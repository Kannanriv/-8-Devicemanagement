import type { Command, Device } from "@hash8/sdk-ts";
import { commandReducer, isCommandExpired } from "@hash8/ops-engine";
import { toHex } from "@hash8/dcs-schema";
import type { Core } from "../context";
import { ApiError, badRequest, notFound } from "../errors";
import { newId } from "../util/ids";

export type StoredCommand = Command & { tenantId: string; expiresAt?: string };

/** Downlink transports register here (MQTT broker publishes to `dev/{serial}/down`). */
export type DownlinkSender = (device: Device, bytes: Uint8Array, port?: number) => boolean;

export const COMMAND_TIMEOUT_SEC = 120;

function publicCommand(c: StoredCommand): Command {
  const { tenantId: _t, expiresAt: _e, ...rest } = c;
  return rest;
}

export class CommandService {
  private senders: DownlinkSender[] = [];
  /** Dev downlink outbox when no transport is attached (and for the simulator). */
  readonly outbox: { serial: string; hex: string; port?: number; at: string }[] = [];

  constructor(private core: Core) {}

  addSender(s: DownlinkSender) {
    this.senders.push(s);
  }

  async list(deviceId: string, limit = 50): Promise<Command[]> {
    const rows = await this.core.repos.commands.list({ where: ["device_id = ?"], params: [deviceId], limit });
    return rows.map(publicCommand);
  }

  async get(id: string, scope?: string[]) {
    const c = await this.core.repos.commands.getScoped(id, scope);
    if (!c) throw notFound("command", id);
    return c;
  }

  async send(device: Device, message: string, data: Record<string, unknown>, actor: string): Promise<Command> {
    const resolved = await this.core.codecs.forDevice(device);
    if (!resolved) throw badRequest(`Device ${device.id} has no codec; cannot encode downlink`);
    const enc = resolved.codec.encode(message, data);
    if (!enc.ok) {
      throw new ApiError(422, "ENCODE_FAILED", enc.errors.map((e) => e.message).join("; "), enc.errors);
    }
    const now = this.core.now();
    let cmd: StoredCommand = {
      id: newId("cmd"),
      tenantId: device.tenantId,
      deviceId: device.id,
      message,
      data,
      payloadHex: toHex(enc.bytes),
      status: "queued",
      requestedBy: actor,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + COMMAND_TIMEOUT_SEC * 1000).toISOString(),
    };
    if (enc.port !== undefined) cmd.port = enc.port;
    await this.core.repos.commands.insert(cmd);

    const delivered = this.transmit(device, enc.bytes, enc.port);
    if (delivered) cmd = { ...cmd, ...commandReducer(cmd, { type: "sent", at: this.core.now().toISOString() }) };
    await this.core.repos.commands.update(cmd);
    await this.core.timeline(device.tenantId, device.id, "command", `Command ${message} ${cmd.status}`, { commandId: cmd.id, payloadHex: cmd.payloadHex, port: cmd.port });
    await this.core.audit(device.tenantId, actor, "device.command.send", `device:${device.id}`, { commandId: cmd.id, message, data });
    this.core.live.broadcast({ type: "command", tenantId: device.tenantId, payload: publicCommand(cmd) });
    return publicCommand(cmd);
  }

  private transmit(device: Device, bytes: Uint8Array, port?: number): boolean {
    let ok = false;
    for (const s of this.senders) ok = s(device, bytes, port) || ok;
    const entry: { serial: string; hex: string; port?: number; at: string } = { serial: device.serial, hex: toHex(bytes), at: this.core.now().toISOString() };
    if (port !== undefined) entry.port = port;
    this.outbox.push(entry);
    if (this.outbox.length > 500) this.outbox.splice(0, this.outbox.length - 500);
    return true; // queued for the device either way (broker retains for offline devices)
  }

  private async transition(c: StoredCommand, type: "ack" | "fail" | "timeout" | "cancel", actor: string, error?: string) {
    const ev: { type: typeof type; at: string; error?: string } = { type, at: this.core.now().toISOString() };
    if (error) ev.error = error;
    let next: StoredCommand;
    try {
      next = { ...c, ...commandReducer(c, ev) };
    } catch (err) {
      throw new ApiError(409, "INVALID_TRANSITION", (err as Error).message);
    }
    await this.core.repos.commands.update(next);
    await this.core.timeline(c.tenantId, c.deviceId, "command", `Command ${c.message} ${next.status}`, { commandId: c.id, error: next.error });
    await this.core.audit(c.tenantId, actor, `device.command.${type}`, `command:${c.id}`, { deviceId: c.deviceId });
    this.core.live.broadcast({ type: "command", tenantId: c.tenantId, payload: publicCommand(next) });
    return publicCommand(next);
  }

  async cancel(id: string, scope: string[], actor: string) {
    return this.transition(await this.get(id, scope), "cancel", actor);
  }

  async ack(id: string, scope: string[] | undefined, actor: string, failed?: string) {
    const c = await this.get(id, scope);
    return this.transition(c, failed ? "fail" : "ack", actor, failed);
  }

  /** Called by the pipeline for uplinks whose message name contains "ack": acks the oldest open command. */
  async ackFromUplink(device: Device, messageName: string, data: Record<string, unknown>) {
    const open = await this.core.repos.commands.list({
      where: ["device_id = ?", "status IN ('queued','sent')"],
      params: [device.id],
      orderBy: "created_at ASC",
      limit: 1,
    });
    const c = open[0];
    if (!c) return undefined;
    const failed = data.success === false || data.result === "error" || data.status === "error";
    return this.transition(c, failed ? "fail" : "ack", `device:${device.id}`, failed ? `Device rejected (${messageName})` : undefined);
  }

  /** Times out commands that were never acknowledged. */
  async sweep(): Promise<number> {
    const now = this.core.now();
    const open = await this.core.repos.commands.list({ where: ["status IN ('queued','sent')"], limit: 500, orderBy: "created_at ASC" });
    let n = 0;
    for (const c of open) {
      if (isCommandExpired(c, now, COMMAND_TIMEOUT_SEC)) {
        await this.transition(c, "timeout", "system");
        n++;
      }
    }
    return n;
  }
}

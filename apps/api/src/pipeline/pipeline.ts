import type { Device, DeviceMessage } from "@hash8/sdk-ts";
import type { DecodeResult } from "@hash8/dcs-schema";
import { fromHex } from "@hash8/dcs-schema";
import type { Core } from "../context";
import { DEFAULT_TENANT_ID } from "../context";
import type { AutomationService } from "../services/automations";
import type { CommandService } from "../services/commands";
import type { DeviceService } from "../services/devices";
import type { IntegrationService } from "../services/integrations";
import type { StoredMessage, UnknownPayload } from "../db/repos";
import { ApiError } from "../errors";
import { newId } from "../util/ids";

export interface Uplink {
  serial?: string;
  deviceId?: string;
  transport: "mqtt" | "http" | "udp" | "tcp" | "coap" | "lorawan" | "sim";
  payloadHex: string;
  port?: number;
  topic?: string;
  receivedAt?: string;
  meta?: Record<string, unknown>;
}

export interface PipelineResult {
  messageId: string;
  deviceId?: string;
  status: DeviceMessage["status"];
  message?: string;
  data?: Record<string, unknown>;
  warnings: string[];
  errors?: string[];
  codecId?: string;
  codecVersion?: string;
}

/**
 * Decode pipeline: resolve device → codec (firmware-linked version) → decode with the
 * cached compiled codec → persist + shadow/health/config → timeline → automations →
 * integrations → live. Per-device work is serialized (ordering), different devices run
 * concurrently up to `concurrency`; the queue is bounded so bursts apply backpressure
 * instead of blocking the event loop.
 */
export class Pipeline {
  private active = 0;
  private waiting: (() => void)[] = [];
  private chains = new Map<string, Promise<unknown>>();
  private pending = 0;
  readonly maxQueue = 50_000;
  processed = 0;
  failed = 0;

  constructor(
    private core: Core,
    private deps: { devices: DeviceService; automations: AutomationService; integrations: IntegrationService; commands: CommandService },
    private concurrency = 8,
  ) {}

  get queueDepth() {
    return this.pending;
  }

  /** Enqueue an uplink; resolves when fully processed. */
  submit(u: Uplink): Promise<PipelineResult> {
    if (this.pending >= this.maxQueue) return Promise.reject(new ApiError(503, "BACKPRESSURE", "Ingest queue full, retry later"));
    this.pending++;
    const key = u.deviceId ?? u.serial ?? "_";
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      await this.acquire();
      try {
        return await this.process(u);
      } finally {
        this.release();
      }
    });
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      this.pending--;
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** Fire-and-forget variant for transports (MQTT/UDP). */
  push(u: Uplink) {
    this.submit(u).catch((err) => {
      this.failed++;
      this.core.log.warn({ err: (err as Error).message, serial: u.serial }, "pipeline error");
    });
  }

  async drain() {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((r) => this.waiting.push(() => (this.active++, r())));
  }
  private release() {
    this.active--;
    // yield to the event loop between jobs so HTTP stays responsive under bursts
    const next = this.waiting.shift();
    if (next) setImmediate(next);
  }

  private async resolveDevice(u: Uplink): Promise<Device | undefined> {
    if (u.deviceId) return this.core.repos.devices.get(u.deviceId);
    if (u.serial) return this.core.repos.devices.getBySerial(u.serial);
    return undefined;
  }

  async process(u: Uplink): Promise<PipelineResult> {
    const receivedAt = u.receivedAt ?? this.core.now().toISOString();
    const id = newId("msg");
    let payload: Uint8Array;
    try {
      payload = fromHex(u.payloadHex);
    } catch {
      throw new ApiError(400, "BAD_PAYLOAD", `Invalid hex payload`);
    }
    const payloadHex = Buffer.from(payload).toString("hex");
    const device = await this.resolveDevice(u);
    this.core.bus.publish("raw.v1", device?.id ?? u.serial ?? "unknown", { ...u, id, receivedAt, payloadHex });

    if (!device) {
      await this.storeUnknown({ id, tenantId: DEFAULT_TENANT_ID, receivedAt, transport: u.transport, payloadHex, reason: "unknown_device", errors: [], ...(u.serial ? { serial: u.serial } : {}), ...portTopic(u) });
      this.processed++;
      return { messageId: id, status: "unknown", warnings: [], errors: [`Unknown device ${u.serial ?? u.deviceId}`] };
    }

    const resolved = await this.core.codecs.forDevice(device);
    const base: StoredMessage = { id, tenantId: device.tenantId, deviceId: device.id, receivedAt, transport: u.transport, payloadHex, status: "unknown", warnings: [], ...portTopic(u) };

    if (!resolved) {
      base.errors = ["No codec linked to this device/model"];
      await this.core.repos.messages.insertMany([base]);
      await this.storeUnknown({ id, tenantId: device.tenantId, deviceId: device.id, serial: device.serial, receivedAt, transport: u.transport, payloadHex, reason: "no_codec", errors: base.errors, ...portTopic(u) });
      await this.touch(device, receivedAt, undefined, undefined);
      this.processed++;
      return { messageId: id, deviceId: device.id, status: "unknown", warnings: [], errors: base.errors };
    }

    const ctx: { port?: number; topic?: string } = {};
    if (u.port !== undefined) ctx.port = u.port;
    // Our broker's transport topic (dev/{serial}/up) is not the device's native topic, so it must not constrain message selection.
    if (u.topic !== undefined && !u.topic.startsWith("dev/")) ctx.topic = u.topic;
    let result: DecodeResult;
    try {
      result = resolved.codec.decode(payload, ctx);
    } catch (err) {
      result = { ok: false, errors: [{ code: "INVALID_SPEC", message: (err as Error).message }], warnings: [] };
    }
    base.codecId = resolved.codecId;
    base.codecVersion = resolved.version;

    if (!result.ok) {
      const noMatch = result.errors.some((e) => e.code === "NO_MATCHING_MESSAGE");
      base.status = noMatch ? "unknown" : "error";
      base.errors = result.errors.map((e) => `${e.code}: ${e.message}`);
      base.warnings = result.warnings;
      await this.core.repos.messages.insertMany([base]);
      await this.storeUnknown({
        id,
        tenantId: device.tenantId,
        deviceId: device.id,
        serial: device.serial,
        receivedAt,
        transport: u.transport,
        payloadHex,
        codecId: resolved.codecId,
        codecVersion: resolved.version,
        reason: noMatch ? "no_matching_message" : "decode_error",
        errors: result.errors,
        ...portTopic(u),
      });
      await this.touch(device, receivedAt, undefined, undefined);
      this.core.live.broadcast({ type: "message", tenantId: device.tenantId, payload: publicMessage(base) });
      this.processed++;
      return { messageId: id, deviceId: device.id, status: base.status, warnings: base.warnings, errors: base.errors, codecId: resolved.codecId, codecVersion: resolved.version };
    }

    base.status = "decoded";
    base.message = result.message;
    base.data = result.data;
    base.warnings = result.warnings;
    await this.core.repos.messages.insertMany([base]);
    const updated = await this.touch(device, receivedAt, result.message, result.data);
    await this.deps.devices.applyReported(updated, result.message, result.data);
    await this.core.repos.timeline.insertMany([
      { id: newId("tl"), tenantId: device.tenantId, deviceId: device.id, at: receivedAt, kind: "message", title: `${result.message} via ${u.transport}`, detail: { messageId: id, port: u.port } },
    ]);
    if (/ack/i.test(result.message)) await this.deps.commands.ackFromUplink(updated, result.message, result.data);

    const envelope = {
      id,
      tenantId: device.tenantId,
      deviceId: device.id,
      serial: device.serial,
      receivedAt,
      transport: u.transport,
      payloadHex,
      codecId: resolved.codecId,
      codecVersion: resolved.version,
      message: result.message,
      data: result.data,
      warnings: result.warnings,
      ...portTopic(u),
    };
    this.core.bus.publish("decoded.v1", device.id, envelope);
    this.deps.integrations.meter(device.tenantId, device.id, payload.length);
    await this.deps.automations.onMessage(updated, resolved.codecId, result.message, result.data);
    await this.deps.integrations.dispatch(device.tenantId, "message.decoded", envelope);
    this.core.live.broadcast({ type: "message", tenantId: device.tenantId, payload: { ...publicMessage(base), serial: device.serial } });
    this.processed++;
    return { messageId: id, deviceId: device.id, status: "decoded", message: result.message, data: result.data, warnings: result.warnings, codecId: resolved.codecId, codecVersion: resolved.version };
  }

  /** Update shadow + lastSeen + health, persist and broadcast. */
  private async touch(device: Device, at: string, message: string | undefined, data: Record<string, unknown> | undefined): Promise<Device> {
    const fresh = (await this.core.repos.devices.get(device.id)) ?? device;
    const shadow = data ? { ...fresh.shadow, ...data } : fresh.shadow;
    const lastSeenAt = !fresh.health.lastSeenAt || fresh.health.lastSeenAt < at ? at : fresh.health.lastSeenAt;
    const health = { ...fresh.health, lastSeenAt };
    if (data) {
      const lat = num(data.lat ?? data.latitude);
      const lng = num(data.lng ?? data.lon ?? data.longitude);
      const flags = (data.flags ?? {}) as Record<string, unknown>;
      if (lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0)) health.gps = { lat, lng, at, fix: flags.gpsFix !== false };
      if (/heartbeat|periodic|status/i.test(`${message ?? ""} ${String(data.msgType ?? "")}`)) health.lastHeartbeatAt = at;
      const eh = num(data.engineHours ?? data.engine_hours);
      if (eh !== undefined) health.engineHours = eh;
      else if (flags.ignition === true && health.engineHours !== undefined && fresh.health.lastSeenAt) {
        const hrs = Math.min(1, Math.max(0, (Date.parse(at) - Date.parse(fresh.health.lastSeenAt)) / 3600_000));
        health.engineHours = Math.round((health.engineHours + hrs) * 10) / 10;
      }
    }
    const draft: Device = { ...fresh, shadow, health, updatedAt: this.core.now().toISOString() };
    draft.health = await this.deps.devices.healthFor(draft);
    await this.deps.devices.save(draft, fresh.health.connectivity !== draft.health.connectivity);
    return draft;
  }

  private async storeUnknown(u: UnknownPayload) {
    await this.core.repos.unknown.insertMany([u]);
    this.core.bus.publish("unknown.v1", u.deviceId ?? u.serial ?? "unknown", u);
  }

  /** Re-run decoding for unresolved unknown payloads (e.g. after publishing a codec fix). */
  async redecode(scope: string[] | undefined, opts: { deviceId?: string; since?: string }): Promise<{ attempted: number; decoded: number; stillUnknown: number }> {
    this.core.codecs.invalidate();
    const items = await this.core.repos.unknown.list(scope, { ...opts, limit: 5000 });
    let decoded = 0;
    for (const u of items) {
      if (!u.deviceId) continue;
      const device = await this.core.repos.devices.get(u.deviceId);
      if (!device) continue;
      const resolved = await this.core.codecs.forDevice(device);
      if (!resolved) continue;
      const ctx: { port?: number; topic?: string } = {};
      if (u.port !== undefined) ctx.port = u.port;
      if (u.topic !== undefined) ctx.topic = u.topic;
      let r: DecodeResult;
      try {
        r = resolved.codec.decode(fromHex(u.payloadHex), ctx);
      } catch {
        continue;
      }
      if (!r.ok) continue;
      const existing = await this.core.repos.messages.get(u.id);
      if (existing) {
        await this.core.repos.messages.updateDecoded(u.id, { status: "decoded", message: r.message, data: r.data, warnings: r.warnings, codecVersion: resolved.version, codecId: resolved.codecId });
      } else {
        await this.core.repos.messages.insertMany([
          { id: u.id, tenantId: device.tenantId, deviceId: device.id, receivedAt: u.receivedAt, transport: u.transport, payloadHex: u.payloadHex, status: "decoded", message: r.message, data: r.data, warnings: r.warnings, codecId: resolved.codecId, codecVersion: resolved.version, ...(u.port !== undefined ? { port: u.port } : {}) },
        ]);
      }
      await this.core.repos.unknown.resolve(u.id, u.id, this.core.now().toISOString());
      decoded++;
    }
    return { attempted: items.length, decoded, stillUnknown: items.length - decoded };
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function portTopic(u: { port?: number; topic?: string }) {
  const o: { port?: number; topic?: string } = {};
  if (u.port !== undefined) o.port = u.port;
  if (u.topic !== undefined) o.topic = u.topic;
  return o;
}

export function publicMessage(m: StoredMessage): DeviceMessage {
  const { tenantId: _t, codecId: _c, ...rest } = m;
  return rest;
}

import type { Automation, AutomationAction, Device, LifecycleState } from "@hash8/sdk-ts";
import { evaluateAutomation, type AutomationEvent } from "@hash8/ops-engine";
import type { Core } from "../context";
import type { AlertService } from "./alerts";
import type { CommandService } from "./commands";
import type { DeviceService } from "./devices";
import type { IntegrationService } from "./integrations";
import { badRequest } from "../errors";

export interface DryRunResult {
  matched: boolean;
  actions: AutomationAction[];
  error?: string;
  event: Record<string, unknown>;
}

/** Runs tenant automations against message / lifecycle / offline events. */
export class AutomationService {
  private cache = new Map<string, { at: number; items: Automation[] }>();
  private offlineFired = new Map<string, string>();
  private statChain: Promise<unknown> = Promise.resolve();

  constructor(
    private core: Core,
    private deps: { alerts: AlertService; commands: CommandService; devices: DeviceService; integrations: IntegrationService },
  ) {}

  invalidate() {
    this.cache.clear();
  }

  /** Automations that apply to a device: owner tenant and its ancestors (solution rules cover customers). */
  private async forTenant(tenantId: string): Promise<Automation[]> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < 5000) return hit.items;
    const all = await this.core.tenants();
    const ids: string[] = [];
    let cur = all.find((t) => t.id === tenantId);
    while (cur) {
      ids.push(cur.id);
      cur = cur.parentId ? all.find((t) => t.id === cur!.parentId) : undefined;
    }
    const items = await this.core.repos.automations.list({ tenantIds: ids.length ? ids : [tenantId] });
    this.cache.set(tenantId, { at: Date.now(), items });
    return items;
  }

  async onMessage(device: Device, codecId: string, message: string, data: Record<string, unknown>) {
    await this.run(device.tenantId, { type: "message", codecId, message, data, device });
  }

  async onLifecycle(device: Device, to: LifecycleState) {
    await this.run(device.tenantId, { type: "lifecycle", to, device });
  }

  /** Fires offline automations for devices silent past each rule's threshold (once per silence). */
  async sweepOffline(): Promise<number> {
    const now = this.core.now();
    const autos = (await this.core.repos.automations.list()).filter((a) => a.enabled && a.trigger.type === "offline");
    if (!autos.length) return 0;
    const offline = await this.core.repos.devices.list(undefined, { connectivity: "offline", limit: 500 });
    let fired = 0;
    for (const d of offline.items) {
      if (!d.health.lastSeenAt) continue;
      const minutes = Math.floor((now.getTime() - Date.parse(d.health.lastSeenAt)) / 60_000);
      for (const a of autos) {
        const key = `${a.id}:${d.id}`;
        if (this.offlineFired.get(key) === d.health.lastSeenAt) continue;
        const scope = await this.core.scope(a.tenantId);
        if (!scope.includes(d.tenantId)) continue;
        const r = evaluateAutomation(a, { type: "offline", minutes, device: d }, now);
        if (r.matched) {
          this.offlineFired.set(key, d.health.lastSeenAt);
          await this.execute(a, d, r.actions, { type: "offline", minutes });
          fired++;
        }
      }
    }
    return fired;
  }

  private async run(tenantId: string, event: AutomationEvent) {
    const autos = await this.forTenant(tenantId);
    const now = this.core.now();
    for (const a of autos) {
      const r = evaluateAutomation(a, event, now);
      if (r.error) {
        await this.bump(a.id, false, true);
        continue;
      }
      if (!r.matched) continue;
      const device = "device" in event ? event.device : undefined;
      const { device: _d, ...summary } = event as Record<string, unknown>;
      await this.execute(a, device, r.actions, summary);
    }
  }

  private async execute(a: Automation, device: Device | undefined, actions: AutomationAction[], event: Record<string, unknown>) {
    let failed = false;
    for (const action of actions) {
      try {
        await this.apply(a, device, action, event);
      } catch (err) {
        failed = true;
        this.core.log.warn({ err, automation: a.id }, "automation action failed");
      }
    }
    await this.bump(a.id, true, failed);
  }

  private async apply(a: Automation, device: Device | undefined, action: AutomationAction, event: Record<string, unknown>) {
    const actor = `automation:${a.id}`;
    const tenantId = device?.tenantId ?? a.tenantId;
    switch (action.type) {
      case "alert": {
        const detail = device ? `${a.name} matched on ${device.name ?? device.serial}` : a.name;
        const alert: Parameters<AlertService["create"]>[0] = { tenantId, severity: action.severity, title: action.title, detail, source: actor };
        if (device) alert.deviceId = device.id;
        await this.deps.alerts.create(alert, { dedupeMinutes: 30 });
        return;
      }
      case "command":
        if (!device) throw new Error("command action needs a device");
        await this.deps.commands.send(device, action.message, action.data, actor);
        return;
      case "webhook": {
        // Webhook actions target one integration explicitly, regardless of its event subscriptions.
        const i = await this.core.repos.integrations.get(action.integrationId);
        if (!i) throw new Error(`integration ${action.integrationId} not found`);
        if (!i.enabled) return;
        this.deps.integrations.enqueue({ integration: i, event: "automation.triggered", payload: { automationId: a.id, name: a.name, deviceId: device?.id, event }, attempt: 1 });
        return;
      }
      case "lifecycle": {
        if (!device) throw new Error("lifecycle action needs a device");
        const fresh = (await this.core.repos.devices.get(device.id)) ?? device;
        if (fresh.lifecycle === action.to) return;
        await this.deps.devices.transition(fresh, action.to, actor, `automation ${a.name}`);
        return;
      }
      case "tag": {
        if (!device) throw new Error("tag action needs a device");
        const fresh = (await this.core.repos.devices.get(device.id)) ?? device;
        const tags = new Set(fresh.tags);
        for (const t of action.add ?? []) tags.add(t);
        for (const t of action.remove ?? []) tags.delete(t);
        const next = [...tags].sort();
        if (next.join(",") === [...fresh.tags].sort().join(",")) return;
        await this.deps.devices.save({ ...fresh, tags: next, updatedAt: this.core.now().toISOString() });
        await this.core.timeline(fresh.tenantId, fresh.id, "audit", `Tags updated by ${a.name}`, { add: action.add, remove: action.remove });
        return;
      }
    }
  }

  private bump(id: string, ran: boolean, failed: boolean) {
    this.statChain = this.statChain.then(async () => {
      const a = await this.core.repos.automations.get(id);
      if (!a) return;
      a.stats = {
        runs: a.stats.runs + (ran ? 1 : 0),
        failures: a.stats.failures + (failed ? 1 : 0),
        lastRunAt: ran ? this.core.now().toISOString() : a.stats.lastRunAt,
      };
      if (!a.stats.lastRunAt) delete a.stats.lastRunAt;
      await this.core.repos.automations.update(a);
      const c = this.cache.get(a.tenantId);
      if (c) c.items = c.items.map((x) => (x.id === a.id ? a : x));
    }).catch(() => {});
    return this.statChain;
  }

  /** Evaluate without side effects, against the device's latest decoded message (or a synthetic event). */
  async dryRun(a: Automation, device: Device, override?: { data?: Record<string, unknown>; message?: string }): Promise<DryRunResult> {
    const now = this.core.now();
    let event: AutomationEvent;
    switch (a.trigger.type) {
      case "message": {
        let data = override?.data;
        let message = override?.message;
        let codecId = device.codecId;
        if (!data) {
          const msgs = await this.core.repos.messages.listForDevice(device.id, 20);
          const m = msgs.find((x) => x.status === "decoded" && (!a.trigger || a.trigger.type !== "message" || !a.trigger.message || x.message === a.trigger.message)) ?? msgs.find((x) => x.status === "decoded");
          data = m?.data ?? { ...device.shadow };
          message ??= m?.message;
        }
        codecId ??= (await this.deps.devices.model(device.modelId))?.codecId;
        const e: AutomationEvent = { type: "message", data, device };
        if (codecId) (e as { codecId?: string }).codecId = codecId;
        if (message) (e as { message?: string }).message = message;
        event = e;
        break;
      }
      case "lifecycle":
        event = { type: "lifecycle", to: device.lifecycle, device };
        break;
      case "offline": {
        const last = device.health.lastSeenAt ? Date.parse(device.health.lastSeenAt) : now.getTime();
        event = { type: "offline", minutes: Math.floor((now.getTime() - last) / 60_000), device };
        break;
      }
      case "schedule":
        event = { type: "schedule", at: now };
        break;
      default:
        throw badRequest("Unsupported trigger");
    }
    const r = evaluateAutomation({ ...a, enabled: true }, event, now);
    const { device: _d, ...summary } = event as Record<string, unknown>;
    const out: DryRunResult = { matched: r.matched, actions: r.actions, event: { ...summary, deviceId: device.id } };
    if (r.error) out.error = r.error;
    return out;
  }
}

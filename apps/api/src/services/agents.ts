import { AsyncLocalStorage } from "node:async_hooks";
import { createAgentRegistry, createAnthropicLlm, type AgentRegistry, type AgentTools } from "@hash8/agents";
import type { AgentName, AgentRun, DeviceMessage } from "@hash8/sdk-ts";
import type { Core } from "../context";
import type { AlertService } from "./alerts";
import type { CommandService } from "./commands";
import type { OtaService } from "./ota";
import type { StatsService } from "./stats";
import { notFound } from "../errors";

const actorStore = new AsyncLocalStorage<{ actor: string }>();

/**
 * Hosts the @hash8/agents registry. One registry per tenant so every tool call is
 * tenant-scoped; the acting user travels via AsyncLocalStorage into audit entries.
 * Runs are mirrored to the `agent_runs` table so they survive restarts.
 */
export class AgentService {
  private registries = new Map<string, AgentRegistry>();
  private llm: ReturnType<typeof createAnthropicLlm>;

  constructor(
    private core: Core,
    private deps: { alerts: AlertService; commands: CommandService; ota: OtaService; stats: StatsService },
  ) {
    this.llm = createAnthropicLlm(core.config.anthropicApiKey);
  }

  get llmEnabled() {
    return !!this.llm;
  }

  tools(tenantId: string): AgentTools {
    const core = this.core;
    const scopeP = core.scope(tenantId);
    const actor = () => actorStore.getStore()?.actor ?? "agent";
    const toDeviceMessage = (u: Awaited<ReturnType<typeof core.repos.unknown.list>>[number]): DeviceMessage => {
      const m: DeviceMessage = { id: u.id, deviceId: u.deviceId ?? `serial:${u.serial ?? "?"}`, receivedAt: u.receivedAt, transport: u.transport, payloadHex: u.payloadHex, status: "unknown", warnings: [], errors: u.errors.map((e) => (typeof e === "string" ? e : `${(e as { code?: string }).code ?? "ERR"}: ${(e as { message?: string }).message ?? ""}`)) };
      if (u.port !== undefined) m.port = u.port;
      if (u.topic !== undefined) m.topic = u.topic;
      if (u.codecVersion) m.codecVersion = u.codecVersion;
      return m;
    };
    return {
      queryDevices: async (q) => core.repos.devices.list(await scopeP, q),
      getDevice: async (id) => {
        const d = await core.repos.devices.get(id);
        const s = await scopeP;
        return d && (s.includes(d.tenantId) || s.includes(d.oemTenantId)) ? d : undefined;
      },
      getMessages: (deviceId, limit) => core.repos.messages.listForDevice(deviceId, limit),
      listUnknownPayloads: async (limit) => (await core.repos.unknown.list(await scopeP, { limit })).map(toDeviceMessage),
      getCodec: async (id, version) => {
        try {
          const r = await core.codecs.get(id, version);
          return (await core.repos.codecs.get(id, r.version))?.spec;
        } catch {
          return undefined;
        }
      },
      listCodecs: async () => (await core.repos.codecs.list(await scopeP)).map((c) => c.summary),
      getCampaign: async (id) => core.repos.campaigns.getScoped(id, await scopeP),
      listCampaigns: async () => core.repos.campaigns.list({ tenantIds: await scopeP }),
      pauseCampaign: async (id, reason) => {
        const c = await this.deps.ota.get(id, await scopeP);
        await this.deps.ota.pause(c, actor(), reason);
      },
      rollbackCampaign: async (id, reason) => {
        const c = await this.deps.ota.get(id, await scopeP);
        await this.deps.ota.rollback(c, actor(), reason);
      },
      sendCommand: async (deviceId, message, data) => {
        const d = await core.repos.devices.get(deviceId);
        if (!d) throw notFound("device", deviceId);
        return this.deps.commands.send(d, message, data, actor());
      },
      createAlert: async (a) => {
        const input: Parameters<AlertService["create"]>[0] = { tenantId, severity: a.severity, title: a.title, source: a.source };
        if (a.category) input.category = a.category;
        if (a.assetId) input.assetId = a.assetId;
        if (a.detail) input.detail = a.detail;
        if (a.deviceId) input.deviceId = a.deviceId;
        return this.deps.alerts.create(input);
      },
      fleetStats: async () => this.deps.stats.fleetStats(tenantId),
      audit: async (action, target, detail) => {
        await core.audit(tenantId, actor(), action, target, detail);
      },
    };
  }

  registry(tenantId: string): AgentRegistry {
    let r = this.registries.get(tenantId);
    if (!r) {
      r = createAgentRegistry(this.llm ? { tools: this.tools(tenantId), llm: this.llm } : { tools: this.tools(tenantId) });
      this.registries.set(tenantId, r);
    }
    return r;
  }

  list(tenantId: string) {
    return this.registry(tenantId).list();
  }

  private async persist(tenantId: string, run: AgentRun) {
    const existing = await this.core.repos.agentRuns.get(run.id);
    const rec = { ...run, tenantId };
    if (existing) await this.core.repos.agentRuns.update(rec);
    else await this.core.repos.agentRuns.insert(rec);
  }

  async run(tenantId: string, name: AgentName, input: Record<string, unknown>, actor: string): Promise<AgentRun> {
    const run = await actorStore.run({ actor }, () => this.registry(tenantId).run(name, input, { actor }));
    await this.persist(tenantId, run);
    await this.core.audit(tenantId, actor, "agent.run", `agent-run:${run.id}`, { agent: name, status: run.status });
    return run;
  }

  async get(tenantId: string, id: string): Promise<AgentRun> {
    const live = this.registry(tenantId).get(id);
    if (live) return live;
    const stored = await this.core.repos.agentRuns.getScoped(id, await this.core.scope(tenantId));
    if (!stored) throw notFound("agent run", id);
    const { tenantId: _t, ...run } = stored;
    return run;
  }

  async listRuns(tenantId: string, limit = 50): Promise<AgentRun[]> {
    const rows = await this.core.repos.agentRuns.list({ tenantIds: await this.core.scope(tenantId), limit });
    return rows.map(({ tenantId: _t, ...r }) => r);
  }

  async approve(tenantId: string, id: string, actor: string): Promise<AgentRun> {
    const reg = this.registry(tenantId);
    if (!reg.get(id)) throw notFound("agent run", id);
    const run = await actorStore.run({ actor }, () => reg.approve(id));
    await this.persist(tenantId, run);
    await this.core.audit(tenantId, actor, "agent.approve", `agent-run:${run.id}`, { agent: run.agent, status: run.status });
    return run;
  }
}

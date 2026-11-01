import type { Alert, Device, DeviceQuery, LifecycleState } from "@hash8/sdk-ts";
import type { LlmMessage, LlmTool } from "../llm";
import type { AgentContext, AgentDef, AgentTools, PendingAction } from "../types";
import { truncate } from "../util";

const SYSTEM = `You are Fleet Copilot for #8 Device Management, an IoT device-management platform. Answer operators' questions about their fleet using the tools: query devices, read messages, codecs, OTA campaigns and fleet stats.
- Ground every statement in tool results; cite device ids/serials. If the data does not answer the question, say so.
- You cannot change anything directly. If the operator asks for a change (send a command, pause/roll back a campaign, raise an alert), call proposeAction once; a human approves it later. Say that it awaits approval.
- Keep answers short: a sentence or two, then a compact list when useful.`;

const deviceQuerySchema = {
  type: "object",
  properties: {
    q: { type: "string", description: "free text: id, serial or name fragment" },
    modelId: { type: "string" },
    organization: { type: "string" },
    branch: { type: "string" },
    oem: { type: "string" },
    lifecycle: { type: "string", enum: ["registered", "assigned", "installing", "pending_activation", "activated", "maintenance", "suspended", "swap", "retired"] },
    connectivity: { type: "string", enum: ["online", "stale", "offline", "never_seen"] },
    health: { type: "string", enum: ["normal", "warning", "critical"] },
    assetId: { type: "string" },
    lastSeenBefore: { type: "string", description: "ISO timestamp" },
    tag: { type: "string" },
    firmwareVersion: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const;

export const COPILOT_TOOLS: LlmTool[] = [
  { name: "queryDevices", description: "Search devices by filters. Returns {items, total}.", input_schema: { ...deviceQuerySchema } },
  { name: "getDevice", description: "Get one device (health, shadow, firmware, codec).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "getMessages", description: "Recent decoded messages of a device, newest last.", input_schema: { type: "object", properties: { deviceId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["deviceId"] } },
  { name: "listUnknownPayloads", description: "Recent payloads that no codec could decode.", input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } } },
  { name: "listCodecs", description: "Codec versions with status and vector pass counts.", input_schema: { type: "object", properties: {} } },
  { name: "getCodec", description: "A codec spec (DCS) by id and optional version.", input_schema: { type: "object", properties: { id: { type: "string" }, version: { type: "string" } }, required: ["id"] } },
  { name: "listCampaigns", description: "OTA campaigns with wave stats.", input_schema: { type: "object", properties: {} } },
  { name: "getCampaign", description: "One OTA campaign.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "fleetStats", description: "Fleet-wide counts: devices, online/offline, messages, decode rate, alerts.", input_schema: { type: "object", properties: {} } },
  {
    name: "proposeAction",
    description: "Propose a write action for human approval (it is NOT executed now).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["sendCommand", "pauseCampaign", "rollbackCampaign", "createAlert"] },
        deviceId: { type: "string" },
        message: { type: "string", description: "downlink message name for sendCommand" },
        data: { type: "object", description: "downlink data for sendCommand" },
        campaignId: { type: "string" },
        severity: { type: "string", enum: ["info", "warning", "critical"] },
        category: { type: "string", enum: ["device_failure", "abnormal_telemetry", "communication_loss", "security", "ota", "other"] },
        title: { type: "string" },
        detail: { type: "string" },
        reason: { type: "string" },
      },
      required: ["type", "reason"],
    },
  },
];

export const fleetCopilot: AgentDef = {
  name: "fleet-copilot",
  title: "Fleet Copilot",
  description:
    "Answers natural-language questions about the fleet (offline devices, firmware distribution, battery, unknown payloads, campaigns, codecs) via a Claude tool-use loop over read-only tools, with a deterministic keyword fallback.",
  async run(input, ctx) {
    const question = String(input.question ?? input.goal ?? "").trim();
    if (!question) throw new Error("fleet-copilot needs input.question");
    if (ctx.llm) return llmLoop(question, ctx);
    return keywordAnswer(question, ctx);
  },
};

async function llmLoop(question: string, ctx: AgentContext) {
  const llm = ctx.llm!;
  const messages: LlmMessage[] = [{ role: "user", content: question }];
  const toolCalls: { name: string; input: unknown }[] = [];
  let pending: PendingAction | undefined;
  let answer = "";
  for (let turn = 0; turn < 8; turn++) {
    const res = await llm.complete({ system: SYSTEM, messages, tools: COPILOT_TOOLS, maxTokens: 8000, effort: "medium" });
    if (!res.toolUses.length) {
      answer = res.text.trim();
      break;
    }
    messages.push({ role: "assistant", content: res.content });
    const results = await Promise.all(
      res.toolUses.map(async (tu) => {
        toolCalls.push({ name: tu.name, input: tu.input });
        ctx.step(`tool ${tu.name}(${truncate(JSON.stringify(tu.input ?? {}), 120)})`);
        try {
          if (tu.name === "proposeAction") {
            pending = toPending(tu.input as Record<string, unknown>);
            return { type: "tool_result" as const, tool_use_id: tu.id, content: "Proposed. It will run only after a human approves this run." };
          }
          const out = await callTool(ctx.tools, tu.name, (tu.input ?? {}) as Record<string, unknown>);
          return { type: "tool_result" as const, tool_use_id: tu.id, content: truncate(JSON.stringify(out ?? null), 20000) };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: tu.id, content: `Error: ${(e as Error).message}`, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
    answer = res.text.trim();
  }
  if (!answer) answer = "I could not complete the analysis within the tool-call budget.";
  ctx.step(`answered with ${toolCalls.length} tool call(s)`);
  return { output: { answer, toolCalls, answeredBy: llm.model }, ...(pending ? { pendingAction: pending } : {}) };
}

function toPending(i: Record<string, unknown>): PendingAction {
  const reason = String(i.reason ?? "requested via fleet-copilot");
  switch (i.type) {
    case "sendCommand":
      if (!i.deviceId || !i.message) throw new Error("sendCommand needs deviceId and message");
      return { type: "sendCommand", deviceId: String(i.deviceId), message: String(i.message), data: (i.data as Record<string, unknown>) ?? {}, reason };
    case "pauseCampaign":
    case "rollbackCampaign":
      if (!i.campaignId) throw new Error(`${i.type} needs campaignId`);
      return { type: i.type, campaignId: String(i.campaignId), reason };
    case "createAlert":
      return {
        type: "createAlert",
        severity: (["info", "warning", "critical"].includes(String(i.severity)) ? i.severity : "warning") as "info" | "warning" | "critical",
        category: (["device_failure", "abnormal_telemetry", "communication_loss", "security", "ota", "other"].includes(String(i.category)) ? i.category : "other") as Alert["category"],
        title: String(i.title ?? "Operator alert"),
        ...(i.detail ? { detail: String(i.detail) } : {}),
        ...(i.deviceId ? { deviceId: String(i.deviceId) } : {}),
        reason,
      };
    default:
      throw new Error(`unsupported action type ${String(i.type)}`);
  }
}

async function callTool(t: AgentTools, name: string, i: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "queryDevices": {
      const page = await t.queryDevices({ limit: 50, ...(i as DeviceQuery) });
      return { total: page.total, items: page.items.map(slimDevice) };
    }
    case "getDevice":
      return t.getDevice(String(i.id));
    case "getMessages":
      return (await t.getMessages(String(i.deviceId), Number(i.limit ?? 20))).map((m) => ({ at: m.receivedAt, status: m.status, message: m.message, port: m.port, data: m.data, hex: m.payloadHex }));
    case "listUnknownPayloads":
      return (await t.listUnknownPayloads(Number(i.limit ?? 50))).map((m) => ({ deviceId: m.deviceId, at: m.receivedAt, port: m.port, topic: m.topic, hex: m.payloadHex }));
    case "listCodecs":
      return t.listCodecs();
    case "getCodec":
      return t.getCodec(String(i.id), i.version ? String(i.version) : undefined);
    case "listCampaigns":
      return t.listCampaigns();
    case "getCampaign":
      return t.getCampaign(String(i.id));
    case "fleetStats":
      return t.fleetStats();
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function slimDevice(d: Device) {
  return {
    id: d.id,
    udi: d.udi,
    serial: d.serial,
    name: d.name,
    model: d.model,
    organization: d.organization,
    lifecycle: d.lifecycle,
    firmwareVersion: d.firmwareVersion,
    connectivity: d.health.connectivity,
    health: d.health.score,
    healthLevel: d.health.level,
    asset: d.assetName ?? d.assetId,
    sim: d.sim ? { iccid: d.sim.iccid, status: d.sim.status, carrier: d.sim.carrier } : undefined,
    battery: d.health.battery,
    lastSeenAt: d.health.lastSeenAt,
    tags: d.tags,
    site: d.site?.name,
  };
}

// ── deterministic fallback ────────────────────────────────────────────────

const LIFECYCLE_WORDS: [RegExp, LifecycleState][] = [
  [/pending activation|awaiting activation|not (yet )?activated|to be activated/, "pending_activation"],
  [/installing|installation in progress|being installed|pending install/, "installing"],
  [/\bassigned\b/, "assigned"],
  [/\bregistered\b|unassigned/, "registered"],
  [/maintenance|under repair/, "maintenance"],
  [/\bsuspended\b/, "suspended"],
  [/\bretired\b|decommission/, "retired"],
];

async function allDevices(t: AgentTools, q: DeviceQuery = {}): Promise<Device[]> {
  return (await t.queryDevices({ limit: 1000, ...q })).items;
}

const label = (d: Device) => `${d.udi || d.id}${d.serial ? ` (${d.serial})` : ""}`;

async function keywordAnswer(question: string, ctx: AgentContext) {
  const q = question.toLowerCase();
  const t = ctx.tools;
  const done = (intent: string, answer: string, data: unknown) => {
    ctx.step(`answered "${intent}" deterministically`);
    return { output: { intent, answer, data, answeredBy: "keywords" } };
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const devMatch = question.match(/\b(?:device|serial|sn|imei|udi)\s*[#:]?\s*([A-Za-z0-9][\w-]{1,})/i);
  const list = (devs: Device[], extra: (d: Device) => string = () => "") =>
    devs.length ? `: ${devs.slice(0, 20).map((d) => `${label(d)}${extra(d)}`).join("; ")}${devs.length > 20 ? " …" : ""}` : ".";

  if (/\bsims?\b|iccid|carrier|data plan/.test(q)) {
    const status = (["suspended", "inactive", "terminated", "active", "unknown"] as const).find((s) => q.includes(s));
    ctx.step(`intent: SIMs${status ? ` ${status}` : ""}`);
    const devs = (await allDevices(t)).filter((d) => d.sim && (!status || d.sim.status === status));
    if (!status) {
      const dist: Record<string, number> = {};
      for (const d of devs) dist[d.sim!.status] = (dist[d.sim!.status] ?? 0) + 1;
      return done("sims", `${plural(devs.length, "device")} with a SIM — ${Object.entries(dist).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"}.`, dist);
    }
    return done(`sims-${status}`, `${plural(devs.length, "device")} with a ${status} SIM${list(devs, (d) => ` ICCID ${d.sim!.iccid} (${d.sim!.carrier})`)}`, devs.map(slimDevice));
  }
  if (/swap(ped|s)?\b|replaced/.test(q)) {
    ctx.step("intent: swapped devices");
    const devs = await allDevices(t, { lifecycle: "swap" });
    const assets = [...new Set(devs.map((d) => d.assetName ?? d.assetId).filter(Boolean))];
    return done(
      "swap",
      `${plural(devs.length, "device")} in swap${assets.length ? ` across ${plural(assets.length, "asset")} (${assets.join(", ")})` : ""}${list(devs, (d) => (d.assetName || d.assetId ? ` on ${d.assetName ?? d.assetId}` : ""))}`,
      devs.map(slimDevice),
    );
  }
  const lifecycleHit = LIFECYCLE_WORDS.find(([re]) => re.test(q));
  if (lifecycleHit) {
    const state = lifecycleHit[1];
    ctx.step(`intent: lifecycle ${state}`);
    const devs = await allDevices(t, { lifecycle: state });
    return done(`lifecycle-${state}`, `${plural(devs.length, "device")} ${state.replace(/_/g, " ")}${list(devs, (d) => (d.organization ? `, ${d.organization}` : ""))}`, devs.map(slimDevice));
  }
  if (/\bstale\b|old data|not fresh|delayed|lagging/.test(q)) {
    ctx.step("intent: stale telemetry");
    const devs = await allDevices(t, { connectivity: "stale" });
    return done(
      "stale",
      `${plural(devs.length, "device")} with stale telemetry${list(devs, (d) => (d.health.lastSeenAt ? `, last data ${d.health.lastSeenAt}` : d.health.dataFreshnessSec ? `, ${Math.round(d.health.dataFreshnessSec / 60)} min old` : ""))}`,
      devs.map(slimDevice),
    );
  }
  if (/critical|attention|unhealthy|warning/.test(q) && !/alert/.test(q)) {
    const level = /warning/.test(q) ? "warning" : "critical";
    ctx.step(`intent: health ${level}`);
    const devs = await allDevices(t, { health: level });
    return done(`health-${level}`, `${plural(devs.length, "device")} at ${level} health${list(devs, (d) => ` (${d.health.issues.slice(0, 2).join(", ") || `score ${d.health.score}`})`)}`, devs.map(slimDevice));
  }
  if (/offline|disconnected|not reporting|silent|went dark|unreachable/.test(q)) {
    ctx.step("intent: offline devices");
    const devs = await allDevices(t, { connectivity: "offline" });
    return done("offline", `${plural(devs.length, "device")} offline${list(devs, (d) => (d.health.lastSeenAt ? `, last seen ${d.health.lastSeenAt}` : ""))}`, devs.map(slimDevice));
  }
  if (/firmware|fw version|versions?\b/.test(q) && !/campaign|rollout/.test(q)) {
    ctx.step("intent: firmware distribution");
    const devs = await allDevices(t);
    const dist: Record<string, number> = {};
    for (const d of devs) dist[d.firmwareVersion ?? "unknown"] = (dist[d.firmwareVersion ?? "unknown"] ?? 0) + 1;
    const parts = Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v}: ${n}`);
    return done("firmware", `Firmware distribution across ${plural(devs.length, "device")} — ${parts.join(", ") || "no devices"}.`, dist);
  }
  if (/batter/.test(q)) {
    ctx.step("intent: low battery");
    const thr = Number(q.match(/(\d{1,3})\s*%/)?.[1] ?? q.match(/(?:below|under|less than|<)\s*(\d{1,3})/)?.[1] ?? 20);
    const devs = (await allDevices(t)).filter((d) => d.health.battery !== undefined && d.health.battery < thr).sort((a, b) => a.id.localeCompare(b.id));
    return done("low-battery", `${plural(devs.length, "device")} below ${thr}% battery${devs.length ? `: ${devs.map((d) => `${label(d)} ${d.health.battery}%`).join("; ")}` : "."}`, devs.map(slimDevice));
  }
  if (/unknown|undecoded|decode fail|can'?t decode/.test(q)) {
    ctx.step("intent: unknown payloads");
    const msgs = await t.listUnknownPayloads(100);
    const byPort: Record<string, number> = {};
    for (const m of msgs) byPort[m.port !== undefined ? `port ${m.port}` : (m.topic ?? "other")] = (byPort[m.port !== undefined ? `port ${m.port}` : (m.topic ?? "other")] ?? 0) + 1;
    return done("unknown-payloads", `${plural(msgs.length, "undecoded payload")} recently${msgs.length ? ` (${Object.entries(byPort).map(([k, n]) => `${k}: ${n}`).join(", ")}). Run payload-triage to propose a codec patch.` : "."}`, byPort);
  }
  if (/campaign|rollout|\bota\b|update/.test(q)) {
    ctx.step("intent: campaigns");
    const cs = await t.listCampaigns();
    return done("campaigns", cs.length ? cs.map((c) => `${c.name} [${c.status}] ${c.waves.map((w) => `${w.name} ${w.succeeded}/${w.targeted} ok, ${w.failed} failed`).join(" · ")}`).join("\n") : "No OTA campaigns.", cs);
  }
  if (/codec|decoder|spec/.test(q)) {
    ctx.step("intent: codecs");
    const cs = await t.listCodecs();
    return done("codecs", cs.map((c) => `${c.codecId}@${c.version} [${c.status}] vectors ${c.vectorsPassed}/${c.vectorsTotal}`).join("\n") || "No codecs.", cs);
  }
  if (devMatch && !/^(s|is|are|with|that)$/i.test(devMatch[1]!)) {
    ctx.step(`intent: device ${devMatch[1]}`);
    const d = (await t.getDevice(devMatch[1]!)) ?? (await allDevices(t, { q: devMatch[1]! }))[0];
    if (d) {
      const msgs = await t.getMessages(d.id, 5);
      const last = msgs.at(-1);
      return done(
        "device",
        `${label(d)}: ${d.lifecycle}, ${d.health.connectivity}, health ${d.health.score}${d.health.battery !== undefined ? `, battery ${d.health.battery}%` : ""}, firmware ${d.firmwareVersion ?? "?"}${last ? `. Last message ${last.message ?? last.status} at ${last.receivedAt}: ${truncate(JSON.stringify(last.data ?? {}), 160)}` : ""}`,
        { device: d, messages: msgs },
      );
    }
  }
  ctx.step("intent: fleet overview");
  const s = await t.fleetStats();
  return done(
    "stats",
    `${s.devices} devices (${s.online} online, ${s.offline} offline), ${s.messages24h} messages in 24h, decode rate ${(s.decodeRate * 100).toFixed(1)}%, avg health ${s.avgHealth}, ${s.activeCampaigns} active campaign(s), ${s.openAlerts} open alert(s).`,
    s,
  );
}

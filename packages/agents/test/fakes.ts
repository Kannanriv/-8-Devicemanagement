import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { parseSpec } from "@hash8/dcs-schema";
import type { Alert, Device, DeviceHealth, DeviceMessage, OtaCampaign } from "@hash8/sdk-ts";
import type { AgentTools } from "../src/types";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm";

export const thSpec: DeviceCodecSpec = parseSpec({
  dcs: "1.0",
  id: "envio.th-sense",
  version: "1.0.0",
  device: { vendor: "Envio", model: "TH-Sense", protocols: ["lorawan"] },
  uplink: [
    {
      name: "periodic",
      when: { port: 1 },
      fields: [
        { name: "temperature", type: "int", bits: 16, scale: 0.01, unit: "Cel", min: -40, max: 85 },
        { name: "humidity", type: "uint", bits: 8, scale: 0.5, unit: "%", min: 0, max: 100 },
        { name: "reserved3", type: "uint", bits: 8, hidden: true },
        { name: "battery", type: "uint", bits: 16, unit: "mV" },
      ],
    },
    {
      name: "alarm",
      when: { port: 2 },
      fields: [{ name: "alarmType", type: "uint", bits: 8, enum: { "0": "none", "1": "overTemp", "2": "tamper" } }],
    },
  ],
  downlink: [{ name: "setInterval", when: { port: 10 }, fields: [{ kind: "const", name: "cmd", bits: 8, value: 1 }, { name: "seconds", type: "uint", bits: 16, unit: "s" }] }],
  vectors: [{ name: "periodic ok", port: 1, hex: "08665a000e10", data: { temperature: 21.5, humidity: 45, battery: 3600 } }],
});

export const emSpec: DeviceCodecSpec = parseSpec({
  dcs: "1.0",
  id: "voltix.em3",
  version: "1.0.0",
  device: { vendor: "Voltix", model: "EM3", protocols: ["mqtt"] },
  uplink: [
    {
      name: "energy",
      when: { topic: "voltix/em3/+/energy" },
      fields: [
        { name: "activeEnergyImport", type: "uint", bits: 32, scale: 0.01, unit: "kW.h" },
        { name: "voltageL1", type: "uint", bits: 16, scale: 0.1, unit: "V" },
        { name: "fault", type: "uint", bits: 8, enum: { "0": "ok", "1": "overVoltage", "2": "phaseLoss" } },
      ],
    },
  ],
  vectors: [{ name: "energy", topic: "voltix/em3/x/energy", hex: "000186a0096000", data: { activeEnergyImport: 1000, voltageL1: 240, fault: "ok" } }],
});

let seq = 0;
type DeviceInit = Omit<Partial<Device>, "health"> & { id: string; health?: Partial<DeviceHealth> };

export function device(p: DeviceInit): Device {
  const { health, ...rest } = p;
  const h: DeviceHealth = { score: 90, level: "normal", connectivity: "online", issues: [], battery: 80, ...health };
  if (!health?.level) h.level = h.score < 40 ? "critical" : h.score < 70 ? "warning" : "normal";
  return {
    udi: `UDI-${p.id}`,
    tenantId: "t1",
    oemTenantId: "oem1",
    oem: "Envio",
    modelId: "m1",
    model: "TH-Sense",
    serial: `SN-${p.id}`,
    lifecycle: "activated",
    provisioning: "provisioned",
    tags: [],
    shadow: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...rest,
    health: h,
  };
}

export function message(deviceId: string, i: number, data: Record<string, unknown>, extra: Partial<DeviceMessage> = {}): DeviceMessage {
  return {
    id: `msg${++seq}`,
    deviceId,
    receivedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    transport: "lorawan",
    port: 1,
    payloadHex: "00",
    status: "decoded",
    message: "periodic",
    data,
    warnings: [],
    ...extra,
  };
}

export interface FakeState {
  devices: Device[];
  messages: Record<string, DeviceMessage[]>;
  unknown: DeviceMessage[];
  codecs: DeviceCodecSpec[];
  campaigns: OtaCampaign[];
}

export function fakeTools(partial: Partial<FakeState> = {}) {
  const state: FakeState = { devices: [], messages: {}, unknown: [], codecs: [thSpec, emSpec], campaigns: [], ...partial };
  const calls: { name: string; args: unknown[] }[] = [];
  const alerts: Alert[] = [];
  const rec = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const tools: AgentTools = {
    async queryDevices(q) {
      rec("queryDevices", q);
      let items = state.devices;
      if (q.connectivity) items = items.filter((d) => d.health.connectivity === q.connectivity);
      if (q.firmwareVersion) items = items.filter((d) => d.firmwareVersion === q.firmwareVersion);
      if (q.modelId) items = items.filter((d) => d.modelId === q.modelId);
      if (q.tag) items = items.filter((d) => d.tags.includes(q.tag!));
      if (q.lifecycle) items = items.filter((d) => d.lifecycle === q.lifecycle);
      if (q.health) items = items.filter((d) => d.health.level === q.health);
      if (q.assetId) items = items.filter((d) => d.assetId === q.assetId);
      if (q.organization) items = items.filter((d) => d.organization === q.organization);
      if (q.q) items = items.filter((d) => [d.id, d.serial, d.name].some((s) => s?.includes(q.q!)));
      return { items: items.slice(0, q.limit ?? 50), total: items.length };
    },
    async getDevice(id) {
      rec("getDevice", id);
      return state.devices.find((d) => d.id === id);
    },
    async getMessages(id, limit) {
      rec("getMessages", id, limit);
      return (state.messages[id] ?? []).slice(-limit);
    },
    async listUnknownPayloads(limit) {
      rec("listUnknownPayloads", limit);
      return state.unknown.slice(0, limit);
    },
    async getCodec(id) {
      rec("getCodec", id);
      return state.codecs.find((c) => c.id === id);
    },
    async listCodecs() {
      rec("listCodecs");
      return state.codecs.map((c) => ({
        codecId: c.id,
        version: c.version,
        status: "published" as const,
        vendor: c.device.vendor,
        model: c.device.model,
        messageCount: c.uplink.length,
        fieldCount: c.uplink.reduce((n, m) => n + m.fields.length, 0),
        vectorsPassed: c.vectors.length,
        vectorsTotal: c.vectors.length,
        createdAt: "2026-01-01T00:00:00Z",
      }));
    },
    async getCampaign(id) {
      rec("getCampaign", id);
      return state.campaigns.find((c) => c.id === id);
    },
    async listCampaigns() {
      rec("listCampaigns");
      return state.campaigns;
    },
    async pauseCampaign(id, reason) {
      rec("pauseCampaign", id, reason);
    },
    async rollbackCampaign(id, reason) {
      rec("rollbackCampaign", id, reason);
    },
    async sendCommand(deviceId, message, data) {
      rec("sendCommand", deviceId, message, data);
      return { id: "cmd1", deviceId, message, data, status: "queued", requestedBy: "agent", createdAt: "", updatedAt: "" };
    },
    async createAlert(a) {
      rec("createAlert", a);
      const al: Alert = { id: `al${alerts.length + 1}`, tenantId: "t1", status: "open", createdAt: "", ...a };
      alerts.push(al);
      return al;
    },
    async fleetStats() {
      rec("fleetStats");
      const online = state.devices.filter((d) => d.health.connectivity === "online").length;
      return { devices: state.devices.length, online, offline: state.devices.length - online, messages24h: 120, decodeRate: 0.97, avgHealth: 88, activeCampaigns: state.campaigns.filter((c) => c.status === "running").length, openAlerts: alerts.length };
    },
    async audit(action, target, detail) {
      rec("audit", action, target, detail);
    },
  };
  return { tools, state, calls, alerts, called: (n: string) => calls.filter((c) => c.name === n) };
}

export type Scripted = Partial<Pick<LlmResponse, "text" | "toolUses">> | ((req: LlmRequest) => Partial<Pick<LlmResponse, "text" | "toolUses">>);

/** Scripted LlmClient: returns the queued responses in order and records requests. */
export function fakeLlm(script: Scripted[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    model: "fake-model",
    async complete(req) {
      requests.push(JSON.parse(JSON.stringify(req)));
      const next = script.shift();
      if (!next) throw new Error("fake llm: script exhausted");
      const r = typeof next === "function" ? next(req) : next;
      const text = r.text ?? "";
      const toolUses = r.toolUses ?? [];
      return {
        text,
        toolUses,
        stopReason: toolUses.length ? "tool_use" : "end_turn",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolUses.map((t) => ({ type: "tool_use" as const, id: t.id, name: t.name, input: t.input as Record<string, unknown> })),
        ],
        model: "fake-model",
      };
    },
  };
  return { llm, requests, remaining: () => script.length };
}

export function campaign(p: Partial<OtaCampaign> & { id: string }): OtaCampaign {
  return {
    tenantId: "t1",
    name: `Campaign ${p.id}`,
    firmwareId: "fw-2.0.0",
    fromVersions: ["1.9.0"],
    cohort: { modelId: "m1" },
    status: "running",
    waves: [],
    healthGate: { maxFailureRate: 0.1, minHealthScore: 60 },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...p,
  };
}

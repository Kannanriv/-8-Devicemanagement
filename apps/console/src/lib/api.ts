"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Hash8Client } from "@hash8/sdk-ts";
import type {
  AgentName,
  AgentRun,
  Alert,
  AuditEntry,
  Automation,
  CodecVersionSummary,
  Command,
  ConfigTemplate,
  Device,
  DeviceConfig,
  DeviceHealth,
  DeviceMessage,
  DeviceModel,
  DeviceQuery,
  Firmware,
  FleetStats,
  Integration,
  LifecycleState,
  OpsItem,
  OtaCampaign,
  Page,
  PluginTarget,
  SpecImportJob,
  Tenant,
  TimelineEvent,
} from "@hash8/sdk-ts";
import type { DecodeResult, DeviceCodecSpec, VectorResult } from "@hash8/dcs-schema";
import { getTenant, useTenant } from "./tenant";

// ── Client ───────────────────────────────────────────────────────────────────
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1").replace(/\/$/, "");
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? deriveWs(API_URL);

function deriveWs(api: string) {
  try {
    const u = new URL(api);
    return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/live`;
  } catch {
    return "ws://localhost:4000/live";
  }
}

const clients = new Map<string, Hash8Client>();
export function client(tenant = getTenant()): Hash8Client {
  const key = tenant ?? "__default";
  let c = clients.get(key);
  if (!c) {
    // Wrap fetch so it is never invoked with the client as `this` (Illegal invocation in browsers).
    c = new Hash8Client({ baseUrl: API_URL, tenantId: tenant, actor: "user:console", fetch: (i, init) => fetch(i, init) });
    clients.set(key, c);
  }
  return c;
}

function authHeaders(): Record<string, string> {
  const t = getTenant();
  const h: Record<string, string> = { "x-actor": "user:console" };
  if (t) h["x-tenant-id"] = t;
  return h;
}

/** True when the request never reached the API (server down / CORS / DNS). */
export function isOffline(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /failed to fetch|networkerror|load failed|ECONNREFUSED|network request failed/i.test(msg);
}

export function errorMessage(err: unknown): string {
  if (isOffline(err)) return "The API is not reachable.";
  const msg = err instanceof Error ? err.message : String(err);
  // Hash8Client formats "METHOD /path → 404: message" — keep the human part.
  const m = msg.match(/→ \d+: (.*)$/);
  return m?.[1] ?? msg;
}

async function rawRequest(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      msg = j.error?.message ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${msg}`);
  }
  return res;
}

export async function uploadMultipart<T>(path: string, form: FormData): Promise<T> {
  const res = await rawRequest(path, { method: "POST", body: form });
  return (await res.json()) as T;
}

export async function downloadFile(path: string, fallbackName: string) {
  const res = await rawRequest(path, { method: "GET" });
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = decodeURIComponent(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}

export const enc = encodeURIComponent;

// ── Supplementary shapes for endpoints the contract leaves open ─────────────
export interface UnknownCluster {
  id: string;
  signature: string;
  count: number;
  devices: number;
  deviceIds: string[];
  port?: number;
  length?: number;
  sampleHex: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  codecId?: string;
}

export interface AgentInfo {
  name: AgentName;
  title?: string;
  description?: string;
  capabilities?: string[];
  lastRunAt?: string;
}

export type SpecImportDetail = SpecImportJob & {
  spec?: DeviceCodecSpec;
};

/** Accepts either server-side clusters or raw unknown DeviceMessages and returns clusters. */
export function normalizeUnknown(raw: unknown): UnknownCluster[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown[] }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  if (list.length === 0) return [];
  const first = list[0] as Record<string, unknown>;
  if ("payloadHex" in first && !("count" in first)) {
    const groups = new Map<string, UnknownCluster & { _devs: Set<string> }>();
    for (const m of list as DeviceMessage[]) {
      const bytes = m.payloadHex.replace(/\s/g, "");
      const sig = `${m.port ?? "–"}:${bytes.length / 2}:${bytes.slice(0, 2).toUpperCase()}`;
      let g = groups.get(sig);
      if (!g) {
        g = {
          id: sig,
          signature: sig,
          count: 0,
          devices: 0,
          deviceIds: [],
          port: m.port,
          length: bytes.length / 2,
          sampleHex: bytes,
          firstSeenAt: m.receivedAt,
          lastSeenAt: m.receivedAt,
          _devs: new Set(),
        };
        groups.set(sig, g);
      }
      g.count++;
      g._devs.add(m.deviceId);
      if (m.receivedAt < (g.firstSeenAt ?? m.receivedAt)) g.firstSeenAt = m.receivedAt;
      if (m.receivedAt > (g.lastSeenAt ?? "")) g.lastSeenAt = m.receivedAt;
    }
    return [...groups.values()]
      .map(({ _devs, ...g }) => ({ ...g, deviceIds: [..._devs], devices: _devs.size }))
      .sort((a, b) => b.count - a.count);
  }
  return (list as Record<string, unknown>[]).map((c, i) => {
    const deviceIds = Array.isArray(c.deviceIds) ? (c.deviceIds as string[]) : [];
    return {
      id: String(c.id ?? c.signature ?? i),
      signature: String(c.signature ?? c.id ?? `cluster-${i + 1}`),
      count: Number(c.count ?? 0),
      devices: Number(c.devices ?? c.deviceCount ?? deviceIds.length),
      deviceIds,
      port: typeof c.port === "number" ? c.port : undefined,
      length: typeof c.length === "number" ? c.length : undefined,
      sampleHex: String(c.sampleHex ?? c.payloadHex ?? (Array.isArray(c.samples) ? c.samples[0] : "") ?? ""),
      firstSeenAt: (c.firstSeenAt ?? c.firstSeen) as string | undefined,
      lastSeenAt: (c.lastSeenAt ?? c.lastSeen) as string | undefined,
      codecId: c.codecId as string | undefined,
    };
  });
}

function normalizeAgents(raw: unknown): { agents: AgentInfo[]; runs: AgentRun[] } {
  const isRun = (x: unknown): x is AgentRun =>
    !!x && typeof x === "object" && "agent" in x && "steps" in x && "status" in x;
  if (Array.isArray(raw)) {
    return {
      agents: raw.filter((x) => !isRun(x) && x && typeof x === "object" && "name" in x) as AgentInfo[],
      runs: raw.filter(isRun),
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { agents?: unknown; runs?: unknown; items?: unknown };
    const agents = Array.isArray(o.agents) ? (o.agents as AgentInfo[]) : Array.isArray(o.items) ? (o.items as AgentInfo[]) : [];
    const runs = Array.isArray(o.runs) ? (o.runs as unknown[]).filter(isRun) : [];
    return { agents, runs };
  }
  return { agents: [], runs: [] };
}

export function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: T[] }).items;
  }
  return [];
}

// ── Query keys (tenant-scoped) ───────────────────────────────────────────────
export const qk = {
  all: (t: string | undefined) => [t ?? "default"] as const,
  inbox: (t?: string) => [t ?? "default", "inbox"] as const,
  stats: (t?: string) => [t ?? "default", "stats"] as const,
  models: (t?: string) => [t ?? "default", "models"] as const,
  devices: (t?: string, q?: DeviceQuery) => [t ?? "default", "devices", q ?? {}] as const,
  device: (t: string | undefined, id: string) => [t ?? "default", "device", id] as const,
  codecs: (t?: string) => [t ?? "default", "codecs"] as const,
  codec: (t: string | undefined, id: string, v: string) => [t ?? "default", "codec", id, v] as const,
  specImports: (t?: string) => [t ?? "default", "spec-imports"] as const,
  unknown: (t?: string) => [t ?? "default", "unknown"] as const,
  firmware: (t?: string) => [t ?? "default", "firmware"] as const,
  campaigns: (t?: string) => [t ?? "default", "campaigns"] as const,
  alerts: (t?: string) => [t ?? "default", "alerts"] as const,
  automations: (t?: string) => [t ?? "default", "automations"] as const,
  integrations: (t?: string) => [t ?? "default", "integrations"] as const,
  audit: (t?: string, p?: object) => [t ?? "default", "audit", p ?? {}] as const,
  agents: (t?: string) => [t ?? "default", "agents"] as const,
  run: (t: string | undefined, id: string) => [t ?? "default", "run", id] as const,
  templates: (t?: string) => [t ?? "default", "templates"] as const,
};

// ── Ops ──────────────────────────────────────────────────────────────────────
export function useOpsInbox() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.inbox(t),
    queryFn: () => client(t).get<OpsItem[]>("/ops/inbox"),
    refetchInterval: 20_000,
  });
}

export function useFleetStats() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.stats(t),
    queryFn: () => client(t).get<FleetStats>("/fleet/stats"),
    refetchInterval: 15_000,
  });
}

/** Optional — not in the v1 contract. Fails quietly so the switcher can fall back. */
export function useTenants() {
  const t = useTenant();
  return useQuery({
    queryKey: [t ?? "default", "tenants"],
    queryFn: async () => asArray<Tenant>(await client(t).get<unknown>("/tenants")),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

// ── Inventory ────────────────────────────────────────────────────────────────
export function useModels() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.models(t),
    queryFn: async () => asArray<DeviceModel>(await client(t).get<unknown>("/models")),
    staleTime: 60_000,
  });
}

export function useDevices(query: DeviceQuery, opts: { enabled?: boolean } = {}) {
  const t = useTenant();
  return useQuery({
    queryKey: qk.devices(t, query),
    queryFn: () =>
      client(t).get<Page<Device>>(
        `/devices${qs({ ...query } as Record<string, string | number | undefined>)}`,
      ),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useDevice(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: qk.device(t, id),
    queryFn: () => client(t).get<Device>(`/devices/${enc(id)}`),
    refetchInterval: 15_000,
  });
}

export function useDeviceHealth(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "health"],
    queryFn: () => client(t).get<DeviceHealth>(`/devices/${enc(id)}/health`),
    refetchInterval: 30_000,
  });
}

export function useDeviceMessages(id: string, limit = 100) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "messages", limit],
    queryFn: async () => asArray<DeviceMessage>(await client(t).get<unknown>(`/devices/${enc(id)}/messages${qs({ limit })}`)),
    refetchInterval: 15_000,
  });
}

export function useDeviceTimeline(id: string, limit = 200) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "timeline", limit],
    queryFn: async () => asArray<TimelineEvent>(await client(t).get<unknown>(`/devices/${enc(id)}/timeline${qs({ limit })}`)),
  });
}

export function useDeviceConfig(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "config"],
    queryFn: () => client(t).get<DeviceConfig>(`/devices/${enc(id)}/config`),
  });
}

export function useConfigTemplates() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.templates(t),
    queryFn: async () => asArray<ConfigTemplate>(await client(t).get<unknown>("/config-templates")),
  });
}

export function useDeviceCommands(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "commands"],
    queryFn: async () => asArray<Command>(await client(t).get<unknown>(`/devices/${enc(id)}/commands`)),
    refetchInterval: (q) =>
      q.state.data?.some((c) => c.status === "queued" || c.status === "sent") ? 3_000 : 20_000,
  });
}

export function useInvalidateTenant() {
  const qc = useQueryClient();
  const t = useTenant();
  return (...keys: (readonly unknown[])[]) => {
    if (keys.length === 0) return qc.invalidateQueries({ queryKey: qk.all(t) });
    return Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
  };
}

export function useUpdateDevice(id: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (patch: Partial<Pick<Device, "name" | "tags" | "site">>) => client(t).patch<Device>(`/devices/${enc(id)}`, patch),
    onSuccess: () => inv(qk.device(t, id), [t ?? "default", "devices"]),
  });
}

export function useLifecycleTransition() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, to, note }: { id: string; to: LifecycleState; note?: string }) =>
      client(t).post<Device>(`/devices/${enc(id)}/lifecycle`, { to, note }),
    onSuccess: () => inv(),
  });
}

export function useTransfer() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (body: { deviceIds: string[]; toTenantId: string }) =>
      client(t).post<{ transferred: number }>("/devices/transfer", body),
    onSuccess: () => inv(),
  });
}

export function usePutConfig(id: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (body: { desired: Record<string, unknown>; templateId?: string }) =>
      client(t).put<DeviceConfig>(`/devices/${enc(id)}/config`, body),
    onSuccess: () => inv(qk.device(t, id)),
  });
}

export function useSendCommand(id: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (body: { message: string; data: Record<string, unknown> }) =>
      client(t).post<Command>(`/devices/${enc(id)}/commands`, body),
    onSuccess: () => inv(qk.device(t, id)),
  });
}

/** Send one command to many devices (bulk action). */
export function useBulkCommand() {
  const t = useTenant();
  return useMutation({
    mutationFn: async (body: { deviceIds: string[]; message: string; data: Record<string, unknown> }) => {
      const results = await Promise.allSettled(
        body.deviceIds.map((d) => client(t).post<Command>(`/devices/${enc(d)}/commands`, { message: body.message, data: body.data })),
      );
      return { ok: results.filter((r) => r.status === "fulfilled").length, failed: results.filter((r) => r.status === "rejected").length };
    },
  });
}

export function useCancelCommand(deviceId: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (commandId: string) => client(t).post<Command>(`/commands/${enc(commandId)}/cancel`),
    onSuccess: () => inv(qk.device(t, deviceId)),
  });
}

// ── Codecs ───────────────────────────────────────────────────────────────────
export function useCodecs() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.codecs(t),
    queryFn: async () => asArray<CodecVersionSummary>(await client(t).get<unknown>("/codecs")),
    staleTime: 30_000,
  });
}

export function useCodecSpec(id: string | undefined, version: string | undefined) {
  const t = useTenant();
  return useQuery({
    queryKey: qk.codec(t, id ?? "", version ?? ""),
    queryFn: () => client(t).get<DeviceCodecSpec>(`/codecs/${enc(id!)}/versions/${enc(version!)}`),
    enabled: !!id && !!version,
    staleTime: 60_000,
  });
}

export function useTestCodec(id: string, version: string) {
  const t = useTenant();
  return useMutation({
    mutationFn: async () => asArray<VectorResult>(await client(t).post<unknown>(`/codecs/${enc(id)}/versions/${enc(version)}/test`)),
  });
}

export function usePublishCodec() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: string }) =>
      client(t).post<unknown>(`/codecs/${enc(id)}/versions/${enc(version)}/publish`),
    onSuccess: () => inv(qk.codecs(t), qk.specImports(t), qk.inbox(t)),
  });
}

export function useCreateCodec() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (spec: unknown) => client(t).post<unknown>("/codecs", spec),
    onSuccess: () => inv(qk.codecs(t)),
  });
}

export function useDecode() {
  const t = useTenant();
  return useMutation({
    mutationFn: (body: { codecId: string; version?: string; hex: string; port?: number; topic?: string }) =>
      client(t).post<DecodeResult>("/diagnostics/decode", body),
  });
}

export function pluginPath(id: string, version: string, target: PluginTarget | "all") {
  return `/codecs/${enc(id)}/versions/${enc(version)}/plugin${qs({ target })}`;
}

// ── Spec imports ─────────────────────────────────────────────────────────────
export function useSpecImports() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.specImports(t),
    queryFn: async () => asArray<SpecImportJob>(await client(t).get<unknown>("/spec-imports")),
    refetchInterval: (q) =>
      q.state.data?.some((j) => j.status === "parsing" || j.status === "extracting") ? 2_000 : 30_000,
  });
}

export function useSpecImport(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.specImports(t), id],
    queryFn: async () => {
      const raw = await client(t).get<Record<string, unknown>>(`/spec-imports/${enc(id)}`);
      const spec = (raw.spec ?? raw.draft ?? raw.dcs ?? raw.draftSpec) as DeviceCodecSpec | undefined;
      return { ...(raw as unknown as SpecImportJob), spec } satisfies SpecImportDetail;
    },
    refetchInterval: (q) =>
      q.state.data?.status === "parsing" || q.state.data?.status === "extracting" ? 2_000 : false,
  });
}

export function useUploadSpec() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      return uploadMultipart<SpecImportJob>("/spec-imports", fd);
    },
    onSuccess: () => inv(qk.specImports(t)),
  });
}

// ── Unknown payloads ─────────────────────────────────────────────────────────
export function useUnknownPayloads() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.unknown(t),
    queryFn: async () => normalizeUnknown(await client(t).get<unknown>("/payloads/unknown")),
    refetchInterval: 30_000,
  });
}

export function useRedecode() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (body: { deviceId?: string; since?: string }) => client(t).post<unknown>("/payloads/redecode", body),
    onSuccess: () => inv(qk.unknown(t), qk.inbox(t), qk.stats(t)),
  });
}

// ── Firmware & OTA ───────────────────────────────────────────────────────────
export function useFirmware() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.firmware(t),
    queryFn: async () => asArray<Firmware>(await client(t).get<unknown>("/firmware")),
  });
}

export function useUploadFirmware() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (input: { file: File; version: string; modelId: string; releaseNotes?: string; codecVersion?: string }) => {
      const fd = new FormData();
      fd.append("version", input.version);
      fd.append("modelId", input.modelId);
      if (input.releaseNotes) fd.append("releaseNotes", input.releaseNotes);
      if (input.codecVersion) fd.append("codecVersion", input.codecVersion);
      fd.append("file", input.file, input.file.name);
      return uploadMultipart<Firmware>("/firmware", fd);
    },
    onSuccess: () => inv(qk.firmware(t)),
  });
}

export function useCampaigns() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.campaigns(t),
    queryFn: async () => asArray<OtaCampaign>(await client(t).get<unknown>("/ota/campaigns")),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === "running") ? 4_000 : 20_000),
  });
}

export function useCreateCampaign() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (body: Partial<OtaCampaign> & { name: string; firmwareId: string }) =>
      client(t).post<OtaCampaign>("/ota/campaigns", body),
    onSuccess: () => inv(qk.campaigns(t), qk.inbox(t)),
  });
}

export type CampaignAction = "start" | "pause" | "resume" | "rollback";
export function useCampaignAction() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: CampaignAction }) =>
      client(t).post<OtaCampaign>(`/ota/campaigns/${enc(id)}/${action}`),
    onSuccess: () => inv(qk.campaigns(t), qk.inbox(t), qk.stats(t)),
  });
}

// ── Alerts, automations, integrations, audit ────────────────────────────────
export function useAlerts() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.alerts(t),
    queryFn: async () => asArray<Alert>(await client(t).get<unknown>("/alerts")),
    refetchInterval: 20_000,
  });
}

export function useAlertAction() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "ack" | "resolve" }) =>
      client(t).post<Alert>(`/alerts/${enc(id)}/${action}`),
    onSuccess: () => inv(qk.alerts(t), qk.inbox(t), qk.stats(t)),
  });
}

export function useAutomations() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.automations(t),
    queryFn: async () => asArray<Automation>(await client(t).get<unknown>("/automations")),
  });
}

export type AutomationDraft = Pick<Automation, "name" | "enabled" | "trigger" | "condition" | "actions">;
export function useSaveAutomation() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, draft }: { id?: string; draft: Partial<AutomationDraft> }) =>
      id ? client(t).patch<Automation>(`/automations/${enc(id)}`, draft) : client(t).post<Automation>("/automations", draft),
    onSuccess: () => inv(qk.automations(t)),
  });
}

export function useDryRun() {
  const t = useTenant();
  return useMutation({
    mutationFn: ({ id, deviceId }: { id: string; deviceId: string }) =>
      client(t).post<Record<string, unknown>>(`/automations/${enc(id)}/dry-run`, { deviceId }),
  });
}

export function useIntegrations() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.integrations(t),
    queryFn: async () => asArray<Integration>(await client(t).get<unknown>("/integrations")),
  });
}

export function useSaveIntegration() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<Integration> }) =>
      id ? client(t).patch<Integration>(`/integrations/${enc(id)}`, body) : client(t).post<Integration>("/integrations", body),
    onSuccess: () => inv(qk.integrations(t)),
  });
}

export function useTestIntegration() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (id: string) => client(t).post<Record<string, unknown>>(`/integrations/${enc(id)}/test`),
    onSettled: () => inv(qk.integrations(t)),
  });
}

export function useAudit(params: { target?: string; actor?: string; limit?: number }) {
  const t = useTenant();
  return useQuery({
    queryKey: qk.audit(t, params),
    queryFn: async () => asArray<AuditEntry>(await client(t).get<unknown>(`/audit${qs(params)}`)),
    placeholderData: keepPreviousData,
  });
}

// ── Agents ───────────────────────────────────────────────────────────────────
export function useAgents() {
  const t = useTenant();
  return useQuery({
    queryKey: qk.agents(t),
    queryFn: async () => normalizeAgents(await client(t).get<unknown>("/agents")),
    staleTime: 30_000,
  });
}

export function useAgentRun(id: string | undefined) {
  const t = useTenant();
  return useQuery({
    queryKey: qk.run(t, id ?? ""),
    queryFn: () => client(t).get<AgentRun>(`/agents/runs/${enc(id!)}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1_200 : false),
  });
}

function rememberRun(qc: QueryClient, t: string | undefined, run: AgentRun) {
  qc.setQueryData(qk.run(t, run.id), run);
  qc.setQueryData<{ agents: AgentInfo[]; runs: AgentRun[] }>(qk.agents(t), (prev) =>
    prev ? { ...prev, runs: [run, ...prev.runs.filter((r) => r.id !== run.id)] } : prev,
  );
}

export function useRunAgent() {
  const t = useTenant();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agent, input }: { agent: AgentName; input: Record<string, unknown> }) =>
      client(t).post<AgentRun>(`/agents/${agent}/run`, input),
    onSuccess: (run) => rememberRun(qc, t, run),
  });
}

export function useApproveRun() {
  const t = useTenant();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client(t).post<AgentRun>(`/agents/runs/${enc(id)}/approve`),
    onSuccess: (run) => {
      rememberRun(qc, t, run);
      void qc.invalidateQueries({ queryKey: qk.all(t) });
    },
  });
}

"use client";

/** v1.1 contract hooks: inventory KPIs, bulk ops, assets, SIM, alerts, history, security, reports. */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentRun,
  Alert,
  Asset,
  AssetAssociation,
  Automation,
  BulkJob,
  BulkOp,
  BulkPreview,
  DeviceCredential,
  DeviceQuery,
  FleetReport,
  InventoryKpis,
  LifecycleState,
  OtaCampaign,
  Severity,
  SimInfo,
  TimelineEvent,
} from "@hash8/sdk-ts";
import { asArray, client, downloadFile, enc, qk, qs, useInvalidateTenant } from "./api";
import { useTenant } from "./tenant";

const k = (t: string | undefined, ...rest: unknown[]) => [t ?? "default", ...rest] as const;

export function deviceQueryString(q: DeviceQuery & Record<string, unknown>) {
  return qs(q as Record<string, string | number | undefined>);
}

// ── Inventory ────────────────────────────────────────────────────────────────
export function useInventoryKpis() {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "devices", "kpis"),
    queryFn: () => client(t).get<InventoryKpis>("/inventory/kpis"),
    refetchInterval: 20_000,
  });
}

export function useLifecycleSummary() {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "devices", "lifecycle-summary"),
    queryFn: async () => {
      const raw = await client(t).get<unknown>("/lifecycle/summary");
      const out: Partial<Record<LifecycleState, number>> = {};
      const src =
        raw && typeof raw === "object" && !Array.isArray(raw) && "counts" in raw ? (raw as { counts: unknown }).counts : raw;
      if (Array.isArray(src)) {
        for (const r of src as { state?: string; lifecycle?: string; count?: number }[]) {
          const key = (r.state ?? r.lifecycle) as LifecycleState | undefined;
          if (key) out[key] = Number(r.count ?? 0);
        }
      } else if (src && typeof src === "object") {
        for (const [key, v] of Object.entries(src)) if (typeof v === "number") out[key as LifecycleState] = v;
      }
      return out;
    },
    refetchInterval: 30_000,
  });
}

export async function exportDevicesCsv(q: DeviceQuery) {
  const rest: Record<string, unknown> = { ...q };
  delete rest.limit;
  delete rest.cursor;
  await downloadFile(`/devices/export${deviceQueryString(rest)}`, `devices-${new Date().toISOString().slice(0, 10)}.csv`);
}

export function useBulkPreview() {
  const t = useTenant();
  return useMutation({
    mutationFn: (body: { op: BulkOp; deviceIds?: string[]; query?: DeviceQuery; params: Record<string, unknown> }) =>
      client(t).post<BulkPreview>("/devices/bulk/preview", body),
  });
}

export function useBulkRun() {
  const t = useTenant();
  return useMutation({
    mutationFn: (body: { op: BulkOp; deviceIds: string[]; params: Record<string, unknown> }) => client(t).post<BulkJob>("/devices/bulk", body),
  });
}

export function useBulkJob(id: string | undefined) {
  const t = useTenant();
  const qc = useQueryClient();
  return useQuery({
    queryKey: k(t, "bulk-job", id ?? ""),
    queryFn: async () => {
      const job = await client(t).get<BulkJob>(`/bulk-jobs/${enc(id!)}`);
      if (job.status !== "running") {
        void qc.invalidateQueries({ queryKey: k(t, "devices") });
        void qc.invalidateQueries({ queryKey: k(t, "device") });
      }
      return job;
    },
    enabled: !!id,
    refetchInterval: (q) => (!q.state.data || q.state.data.status === "running" ? 1_000 : false),
  });
}

export function useBulkJobs() {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "bulk-jobs"),
    queryFn: async () => asArray<BulkJob>(await client(t).get<unknown>("/bulk-jobs")),
  });
}

// ── Assets ───────────────────────────────────────────────────────────────────
export function useAssets(params: { q?: string } = {}) {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "assets", params),
    queryFn: async () => asArray<Asset>(await client(t).get<unknown>(`/assets${qs(params)}`)),
    placeholderData: keepPreviousData,
  });
}

export function useAsset(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "assets", "one", id),
    queryFn: () => client(t).get<Asset>(`/assets/${enc(id)}`),
  });
}

export function useAssetAssociations(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "assets", "one", id, "associations"),
    queryFn: async () => asArray<AssetAssociation>(await client(t).get<unknown>(`/assets/${enc(id)}/associations`)),
  });
}

export function useAssetMutations(id: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  const done = () => inv(k(t, "assets"), k(t, "devices"), k(t, "device"));
  return {
    attach: useMutation({
      mutationFn: (b: { deviceId: string; role: "primary" | "secondary" }) => client(t).post<Asset>(`/assets/${enc(id)}/devices`, b),
      onSuccess: done,
    }),
    detach: useMutation({
      mutationFn: (deviceId: string) => client(t).request<unknown>("DELETE", `/assets/${enc(id)}/devices/${enc(deviceId)}`),
      onSuccess: done,
    }),
    swap: useMutation({
      mutationFn: (b: { oldDeviceId: string; newDeviceId: string }) => client(t).post<Asset>(`/assets/${enc(id)}/swap`, b),
      onSuccess: done,
    }),
  };
}

export function useCreateAsset() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (b: Partial<Asset> & { name: string; type: string }) => client(t).post<Asset>("/assets", b),
    onSuccess: () => inv(k(t, "assets")),
  });
}

// ── SIM ──────────────────────────────────────────────────────────────────────
export type SimRow = SimInfo & { deviceId?: string; deviceUdi?: string; deviceName?: string };

export function useSims(params: { status?: string; carrier?: string } = {}) {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "sims", params),
    queryFn: async () => asArray<SimRow>(await client(t).get<unknown>(`/sims${qs(params)}`)),
    placeholderData: keepPreviousData,
  });
}

export function useDeviceSim(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "sim"],
    queryFn: () => client(t).get<SimInfo>(`/devices/${enc(id)}/sim`),
    retry: false,
  });
}

export function useSimAction(deviceId: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: (action: "activate" | "suspend") => client(t).post<SimInfo>(`/devices/${enc(deviceId)}/sim/${action}`),
    onSuccess: () => inv(qk.device(t, deviceId), k(t, "sims")),
  });
}

// ── Alerts ───────────────────────────────────────────────────────────────────
export type AlertFilter = { status?: string; severity?: Severity; category?: string; deviceId?: string };

export function useAlertsFiltered(params: AlertFilter) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.alerts(t), params],
    queryFn: async () => asArray<Alert>(await client(t).get<unknown>(`/alerts${qs(params)}`)),
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
  });
}

export function useResolveAlert() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, action, resolution }: { id: string; action: "ack" | "resolve"; resolution?: string }) =>
      client(t).post<Alert>(`/alerts/${enc(id)}/${action}`, resolution ? { resolution } : {}),
    onSuccess: () => inv(qk.alerts(t), qk.inbox(t), qk.stats(t)),
  });
}

export function useAlertRules() {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "automations", "alert-rules"),
    queryFn: async () => asArray<Automation>(await client(t).get<unknown>("/alert-rules")),
  });
}

// ── History ──────────────────────────────────────────────────────────────────
export function useDeviceHistory(id: string, kinds: string[]) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "history", kinds.join(",")],
    queryFn: async () =>
      asArray<TimelineEvent>(
        await client(t).get<unknown>(`/devices/${enc(id)}/timeline${qs({ limit: 300, kinds: kinds.join(",") || undefined })}`),
      ),
    placeholderData: keepPreviousData,
  });
}

// ── Security ─────────────────────────────────────────────────────────────────
export function useDeviceCredentials(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.device(t, id), "credentials"],
    queryFn: async () => asArray<DeviceCredential>(await client(t).get<unknown>(`/devices/${enc(id)}/credentials`)),
  });
}

export function useIssueCredential(id: string) {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: () => client(t).post<DeviceCredential>(`/devices/${enc(id)}/credentials`),
    onSuccess: () => inv(qk.device(t, id), k(t, "security")),
  });
}

export function useRevokeCredential() {
  const t = useTenant();
  const inv = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => client(t).post<DeviceCredential>(`/credentials/${enc(id)}/revoke`, { reason }),
    onSuccess: () => inv(k(t, "device"), k(t, "security")),
  });
}

export type CredentialRow = DeviceCredential & { deviceUdi?: string; deviceName?: string };
export interface SecurityOverview {
  active?: number;
  expiring: number;
  expired: number;
  revoked: number;
  total?: number;
  credentials: CredentialRow[];
  isolation: { name: string; ok: boolean; detail?: string }[];
}

function toChecks(iso: unknown): SecurityOverview["isolation"] {
  if (Array.isArray(iso)) {
    return (iso as Record<string, unknown>[]).map((c) => ({
      name: String(c.name ?? c.check ?? c.title ?? c.id ?? "check"),
      ok: c.ok === true || c.pass === true || c.passed === true || c.status === "pass" || c.status === "ok",
      detail: (c.detail ?? c.message ?? c.description) as string | undefined,
    }));
  }
  if (iso && typeof iso === "object") {
    const o = iso as Record<string, unknown>;
    if (Array.isArray(o.checks)) return toChecks(o.checks);
    return Object.entries(o).map(([name, v]) => ({
      name: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
      ok: v === true || (typeof v === "object" && !!v && (v as { ok?: boolean }).ok === true),
      detail: typeof v === "object" && v ? (v as { detail?: string }).detail : typeof v === "string" || typeof v === "number" ? String(v) : undefined,
    }));
  }
  return [];
}

export function useSecurityOverview() {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "security", "overview"),
    queryFn: async () => {
      const raw = ((await client(t).get<Record<string, unknown>>("/security/overview")) ?? {}) as Record<string, unknown>;
      const counts = (raw.counts && typeof raw.counts === "object" ? raw.counts : raw) as Record<string, unknown>;
      const num = (key: string) => Number(counts[key] ?? 0);
      const list = [raw.credentials, raw.items, raw.recent, raw.attention].find(Array.isArray) as CredentialRow[] | undefined;
      return {
        active: counts.active != null ? num("active") : undefined,
        expiring: num("expiring"),
        expired: num("expired"),
        revoked: num("revoked"),
        total: counts.total != null ? num("total") : undefined,
        credentials: list ?? [],
        isolation: toChecks(raw.tenantIsolation ?? raw.isolation ?? raw.checks),
      } satisfies SecurityOverview;
    },
  });
}

// ── Reports ──────────────────────────────────────────────────────────────────
export function useFleetReport(params: { from?: string; to?: string }) {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "reports", "fleet", params),
    queryFn: () => client(t).get<FleetReport>(`/reports/fleet${qs(params)}`),
    placeholderData: keepPreviousData,
  });
}

export type TrendPoint = { at: string; online: number; messages: number; alerts: number };
export function useTrends(days = 30) {
  const t = useTenant();
  return useQuery({
    queryKey: k(t, "reports", "trends", days),
    queryFn: async () => asArray<TrendPoint>(await client(t).get<unknown>(`/reports/trends${qs({ days })}`)),
    staleTime: 60_000,
  });
}

// ── OTA detail, agent runs ───────────────────────────────────────────────────
export function useCampaign(id: string) {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.campaigns(t), "one", id],
    queryFn: () => client(t).get<OtaCampaign>(`/ota/campaigns/${enc(id)}`),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3_000 : 20_000),
  });
}

export function useAgentRuns() {
  const t = useTenant();
  return useQuery({
    queryKey: [...qk.agents(t), "runs"],
    queryFn: async () => asArray<AgentRun>(await client(t).get<unknown>("/agents/runs")),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running") ? 2_000 : 20_000),
  });
}

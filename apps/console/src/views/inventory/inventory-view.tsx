"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark,
  BookmarkPlus,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Download,
  Link2,
  ListFilter,
  Map as MapIcon,
  MoreHorizontal,
  Pause,
  Play,
  Rocket,
  Rows3,
  Search,
  SlidersHorizontal,
  Stethoscope,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { BulkOp, Device, DeviceQuery, InventoryKpis } from "@hash8/sdk-ts";
import { LIFECYCLE_LABELS } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { CONNECTIVITY_LABEL, ConnectivityDot, HealthBadge, LIFECYCLE_ORDER, LifecycleBadge, SimBadge } from "@/components/status";
import { BulkFlow } from "@/components/bulk-flow";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Input, NativeSelect } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Segmented } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage, useDevices, useModels } from "@/lib/api";
import { exportDevicesCsv, useAssets, useInventoryKpis } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";
import { GeoView } from "./geo-view";

const PAGE = 50;

/** URL param → chip label. Unknown params still render as chips. */
const CHIP_LABEL: Record<string, string> = {
  q: "Search",
  organization: "Organization",
  branch: "Branch",
  oem: "OEM",
  modelId: "Model",
  lifecycle: "Lifecycle",
  connectivity: "Connectivity",
  health: "Health",
  firmwareVersion: "Firmware",
  assetId: "Asset",
  tag: "Tag",
  installedFrom: "Installed from",
  installedTo: "Installed to",
  lastSeenAfter: "Seen after",
  lastSeenBefore: "Not seen since",
  kpi: "Focus",
  cert: "Certificate",
  drift: "Config drift",
  sort: "Sort",
};

const KPI_LABEL: Record<string, string> = {
  attention: "Attention required",
  pendingInstallation: "Pending installation",
  otaInProgress: "Firmware updates in progress",
};

function chipValue(k: string, v: string) {
  if (k === "lifecycle") return LIFECYCLE_LABELS[v as keyof typeof LIFECYCLE_LABELS] ?? v;
  if (k === "connectivity") return CONNECTIVITY_LABEL[v as keyof typeof CONNECTIVITY_LABEL] ?? v;
  if (k === "kpi") return KPI_LABEL[v] ?? v;
  if (/^(installed|lastSeen)/.test(k)) return fmt.dateTime(v);
  if (v === "1" || v === "true") return k === "cert" ? "Expiring" : "Yes";
  return fmt.label(v);
}

interface Cohort {
  name: string;
  params: Record<string, string>;
}
const COHORT_KEY = "h8.cohorts.v1";

export function InventoryView() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const params = React.useMemo(() => {
    const o: Record<string, string> = {};
    sp.forEach((v, key) => {
      if (key !== "view" && v) o[key] = v;
    });
    return o;
  }, [sp]);
  const view = sp.get("view") === "map" ? "map" : "table";

  const setParams = React.useCallback(
    (next: Record<string, string | undefined>) => {
      const s = new URLSearchParams();
      for (const [key, v] of Object.entries(next)) if (v) s.set(key, v);
      if (view === "map") s.set("view", "map");
      const str = s.toString();
      router.replace(str ? `${pathname}?${str}` : pathname, { scroll: false });
    },
    [router, pathname, view],
  );
  const setParam = (key: string, v: string | undefined) => setParams({ ...params, [key]: v });

  // Every URL param is sent; the API ignores ones it doesn't know, the chip still shows.
  const query = React.useMemo(() => ({ ...params }) as DeviceQuery, [params]);
  const queryKey = JSON.stringify(query);
  const [cursors, setCursors] = React.useState<(string | undefined)[]>([undefined]);
  React.useEffect(() => setCursors([undefined]), [queryKey]);
  const devices = useDevices({ ...query, limit: PAGE, cursor: cursors[cursors.length - 1] }, { enabled: view === "table" });

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setSelected(new Set()), [queryKey]);
  const [bulk, setBulk] = React.useState<{ op: BulkOp; ids: string[] } | null>(null);
  const [exporting, setExporting] = React.useState(false);

  const items = devices.data?.items ?? [];
  const allChecked = items.length > 0 && items.every((d) => selected.has(d.id));
  const someChecked = !allChecked && items.some((d) => selected.has(d.id));
  const chips = Object.entries(params);

  const runExport = () => {
    setExporting(true);
    exportDevicesCsv(query)
      .then(() => toast.success("Export ready"))
      .catch((e: unknown) => toast.error("Export failed", { description: errorMessage(e) }))
      .finally(() => setExporting(false));
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Every device you manufacture, deploy or operate. Lifecycle, connectivity and health are tracked separately."
        actions={
          <>
            <Segmented
              label="View"
              value={view}
              onValueChange={(v) => {
                const s = new URLSearchParams(params);
                if (v === "map") s.set("view", "map");
                router.replace(s.toString() ? `${pathname}?${s}` : pathname, { scroll: false });
              }}
              options={[
                { value: "table", label: (<><Rows3 />Table</>) },
                { value: "map", label: (<><MapIcon />Map</>) },
              ]}
            />
            <Button variant="secondary" onClick={runExport} disabled={exporting}>
              {exporting ? <Spinner /> : <Download />}
              Export CSV
            </Button>
          </>
        }
      />

      <KpiCards params={params} onApply={(p) => setParams(p)} />

      <div className="mt-6">
        <FilterBar params={params} setParam={setParam} setAll={setParams} />
      </div>

      <div className="mt-3 flex min-h-9 flex-wrap items-center gap-2">
        {chips.map(([key, v]) => (
          <Badge key={key} tone={CHIP_LABEL[key] ? "neutral" : "signal"} className="h-8 gap-2 pr-1 pl-3 text-[13px]">
            <span className="text-subtle">{CHIP_LABEL[key] ?? fmt.label(key)}</span>
            <span className="text-fg">{chipValue(key, v)}</span>
            <button
              type="button"
              onClick={() => setParam(key, undefined)}
              className="focus-ring inline-flex size-6 cursor-pointer items-center justify-center rounded-full hover:bg-press"
              aria-label={`Remove ${CHIP_LABEL[key] ?? key} filter`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {chips.length ? (
          <Button size="sm" variant="ghost" onClick={() => setParams({})}>
            Clear all
          </Button>
        ) : null}
        <div className="ml-auto">
          <Cohorts params={params} apply={setParams} />
        </div>
      </div>

      {view === "map" ? (
        <GeoView query={query} />
      ) : (
        <Panel className="mt-3 overflow-hidden">
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 border-b border-line px-6 py-3 transition-colors sm:px-7",
              selected.size ? "bg-signal/[0.05]" : "bg-transparent",
            )}
            role="toolbar"
            aria-label="Bulk actions"
          >
            <span className="mr-2 text-sm font-medium tabular">
              {selected.size ? `${selected.size} selected` : devices.data ? `${fmt.number(devices.data.total)} devices` : "Devices"}
            </span>
            {selected.size ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setBulk({ op: "assign", ids: [...selected] })}>
                  <Link2 />
                  Assign
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setBulk({ op: "apply_config", ids: [...selected] })}>
                  <SlidersHorizontal />
                  Apply config
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setBulk({ op: "start_ota", ids: [...selected] })}>
                  <Rocket />
                  Start OTA
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setBulk({ op: "diagnostics", ids: [...selected] })}>
                  <Stethoscope />
                  Diagnostics
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="secondary" aria-label="More bulk actions">
                      <MoreHorizontal />
                      More
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => setBulk({ op: "suspend", ids: [...selected] })}>
                      <Pause />
                      Suspend
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBulk({ op: "reactivate", ids: [...selected] })}>
                      <Play />
                      Reactivate
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBulk({ op: "lifecycle", ids: [...selected] })}>Change lifecycle</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBulk({ op: "transfer", ids: [...selected] })}>Transfer ownership</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBulk({ op: "command", ids: [...selected] })}>Send command</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              </>
            ) : (
              <span className="text-[13px] text-subtle">Select devices for bulk actions</span>
            )}
          </div>

          {devices.isPending ? (
            <TableSkeleton />
          ) : devices.error && !devices.data ? (
            <ApiError error={devices.error} onRetry={() => void devices.refetch()} />
          ) : items.length === 0 ? (
            <Empty
              icon={Boxes}
              title={chips.length ? "No devices match" : "No devices yet"}
              action={
                chips.length ? (
                  <Button size="sm" onClick={() => setParams({})}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {chips.length ? "Loosen a filter or clear them to see the whole inventory." : "Register devices, or run the simulator with npm run simulate."}
            </Empty>
          ) : (
            <Table className={cn(devices.isFetching && "opacity-75 transition-opacity")}>
              <THead>
                <TR>
                  <TH className="w-10">
                    <Checkbox
                      checked={allChecked ? true : someChecked ? "indeterminate" : false}
                      onCheckedChange={(v) => setSelected(v ? new Set(items.map((d) => d.id)) : new Set())}
                      aria-label="Select all on this page"
                    />
                  </TH>
                  <TH>Device</TH>
                  <TH className="hidden md:table-cell">Model</TH>
                  <TH>Status</TH>
                  <TH>Connectivity</TH>
                  <TH className="hidden xl:table-cell">Asset</TH>
                  <TH className="hidden lg:table-cell">SIM</TH>
                  <TH className="hidden lg:table-cell">Firmware</TH>
                  <TH className="hidden sm:table-cell">Last seen</TH>
                  <TH>Health</TH>
                  <TH className="w-12">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {items.map((d) => (
                  <DeviceRow
                    key={d.id}
                    d={d}
                    checked={selected.has(d.id)}
                    onCheck={(v) =>
                      setSelected((prev) => {
                        const n = new Set(prev);
                        if (v) n.add(d.id);
                        else n.delete(d.id);
                        return n;
                      })
                    }
                    onAction={(op) => setBulk({ op, ids: [d.id] })}
                  />
                ))}
              </TBody>
            </Table>
          )}
          {devices.data && items.length > 0 ? (
            <div className="flex items-center justify-between border-t border-line px-6 py-3 text-sm text-muted sm:px-7">
              <span className="tabular">
                {fmt.number((cursors.length - 1) * PAGE + 1)}–{fmt.number((cursors.length - 1) * PAGE + items.length)} of {fmt.number(devices.data.total)}
              </span>
              <div className="flex gap-1">
                <Button size="icon-sm" variant="ghost" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!devices.data.cursor}
                  onClick={() => setCursors((c) => [...c, devices.data!.cursor])}
                  aria-label="Next page"
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      )}

      <BulkFlow
        op={bulk?.op ?? null}
        deviceIds={bulk?.ids ?? []}
        query={query}
        open={!!bulk}
        onOpenChange={(v) => !v && setBulk(null)}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}

// ── KPI cards ────────────────────────────────────────────────────────────────
type Card = {
  key: string;
  label: string;
  value: (k: InventoryKpis) => number;
  define: string;
  filter: Record<string, string>;
  tone?: "ion" | "ember" | "danger" | "signal";
  note?: string;
};

const CARDS: Card[] = [
  { key: "total", label: "Total", value: (k) => k.total, define: "Every device in this tenant, in any lifecycle state.", filter: {} },
  {
    key: "connected",
    label: "Connected",
    value: (k) => k.connected,
    define: "Activated devices that reported within their expected interval.",
    filter: { connectivity: "online" },
    tone: "ion",
  },
  {
    key: "offline",
    label: "Offline",
    value: (k) => k.offline,
    define: "Activated devices silent for more than three expected intervals.",
    filter: { connectivity: "offline" },
    tone: "danger",
  },
  {
    key: "attention",
    label: "Attention required",
    value: (k) => k.attentionRequired,
    define: "Health is warning or critical, or there’s an open critical alert. Overlaps with other cards.",
    filter: { kpi: "attention" },
    tone: "ember",
    note: "may overlap",
  },
  {
    key: "pendingInstallation",
    label: "Pending installation",
    value: (k) => k.pendingInstallation,
    define: "Assigned to an asset, or installation in progress.",
    filter: { kpi: "pendingInstallation" },
  },
  {
    key: "activation",
    label: "Activation in progress",
    value: (k) => k.activationInProgress,
    define: "Installed, waiting on provisioning, SIM or first traffic.",
    filter: { lifecycle: "pending_activation" },
    tone: "signal",
  },
  {
    key: "ota",
    label: "Firmware updates",
    value: (k) => k.otaInProgress,
    define: "Devices an OTA campaign is updating right now.",
    filter: { kpi: "otaInProgress" },
    tone: "signal",
  },
];

function sameFilter(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function KpiCards({ params, onApply }: { params: Record<string, string>; onApply: (p: Record<string, string>) => void }) {
  const kpis = useInventoryKpis();
  if (kpis.error && !kpis.data)
    return (
      <Panel>
        <ApiError error={kpis.error} compact className="px-6 py-4" onRetry={() => void kpis.refetch()} />
      </Panel>
    );
  const k = kpis.data;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" aria-label="Inventory summary">
      {CARDS.map((c) => {
        const active = Object.keys(c.filter).length > 0 && sameFilter(params, c.filter);
        return (
          <li key={c.key}>
            <Tooltip content={c.define}>
              <button
                type="button"
                onClick={() => onApply(active ? {} : c.filter)}
                aria-pressed={active}
                className={cn(
                  "focus-ring group flex h-full w-full cursor-pointer flex-col gap-2 rounded-card border bg-panel px-4 py-4 text-left transition-colors",
                  active ? "border-signal/50 bg-signal/[0.06]" : "border-line hover:border-line-strong hover:bg-raised/50",
                )}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                  {c.label}
                  {c.note ? <span className="text-[11px] text-subtle">({c.note})</span> : null}
                </span>
                {k ? (
                  <span
                    className={cn(
                      "text-[26px] leading-none font-semibold tracking-[-0.03em] tabular",
                      c.value(k) > 0 && c.tone === "ion" && "text-ion",
                      c.value(k) > 0 && c.tone === "ember" && "text-ember",
                      c.value(k) > 0 && c.tone === "danger" && "text-danger",
                      c.value(k) > 0 && c.tone === "signal" && "text-signal",
                    )}
                  >
                    {fmt.compact(c.value(k))}
                  </span>
                ) : (
                  <Skeleton className="h-[26px] w-14" />
                )}
                {c.key === "offline" && k ? (
                  <span className="flex flex-col gap-0.5 text-[11.5px] text-subtle">
                    <SubFilter label="Stale telemetry" n={k.stale} onClick={() => onApply({ connectivity: "stale" })} />
                    <SubFilter label="Not commissioned" n={k.notCommissioned} onClick={() => onApply({ connectivity: "never_seen" })} />
                  </span>
                ) : null}
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function SubFilter({ label, n, onClick }: { label: string; n: number; onClick: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      className="focus-ring flex justify-between gap-2 rounded hover:text-fg"
    >
      <span>{label}</span>
      <span className="tabular">{fmt.number(n)}</span>
    </span>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────
const LAST_SEEN: { value: string; label: string; key: "lastSeenAfter" | "lastSeenBefore"; ms: number }[] = [
  { value: "a1h", label: "Seen in the last hour", key: "lastSeenAfter", ms: 3_600_000 },
  { value: "a24h", label: "Seen in the last 24 h", key: "lastSeenAfter", ms: 86_400_000 },
  { value: "b24h", label: "Not seen for 24 h", key: "lastSeenBefore", ms: 86_400_000 },
  { value: "b7d", label: "Not seen for 7 days", key: "lastSeenBefore", ms: 7 * 86_400_000 },
];

function FilterBar({
  params,
  setParam,
  setAll,
}: {
  params: Record<string, string>;
  setParam: (k: string, v: string | undefined) => void;
  setAll: (p: Record<string, string | undefined>) => void;
}) {
  const models = useModels();
  const assets = useAssets();
  const [more, setMore] = React.useState(() => ["organization", "branch", "oem", "installedFrom", "installedTo", "assetId", "lastSeenAfter", "lastSeenBefore"].some((k) => params[k]));
  const [q, setQ] = React.useState(params.q ?? "");
  React.useEffect(() => setQ(params.q ?? ""), [params.q]);
  React.useEffect(() => {
    if ((params.q ?? "") === q) return;
    const t = setTimeout(() => setParam("q", q || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const oems = React.useMemo(() => [...new Set((models.data ?? []).map((m) => m.vendor))].sort(), [models.data]);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-[minmax(240px,2fr)_repeat(5,minmax(0,1fr))_auto]">
        <div className="relative col-span-2 md:col-span-3 xl:col-span-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="UDI, serial, IMEI or name" aria-label="Search devices" className="pl-10" />
        </div>
        <NativeSelect aria-label="Model" value={params.modelId ?? ""} onChange={(e) => setParam("modelId", e.target.value || undefined)}>
          <option value="">All models</option>
          {(models.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.vendor} {m.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Lifecycle" value={params.lifecycle ?? ""} onChange={(e) => setParam("lifecycle", e.target.value || undefined)}>
          <option value="">Any lifecycle</option>
          {LIFECYCLE_ORDER.map((s) => (
            <option key={s} value={s}>
              {LIFECYCLE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Connectivity" value={params.connectivity ?? ""} onChange={(e) => setParam("connectivity", e.target.value || undefined)}>
          <option value="">Any connectivity</option>
          {Object.entries(CONNECTIVITY_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Health" value={params.health ?? ""} onChange={(e) => setParam("health", e.target.value || undefined)}>
          <option value="">Any health</option>
          <option value="normal">Normal</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </NativeSelect>
        <TextFilter label="Firmware" value={params.firmwareVersion} onCommit={(v) => setParam("firmwareVersion", v)} placeholder="Firmware version" />
        <Button variant={more ? "secondary" : "ghost"} onClick={() => setMore((m) => !m)} aria-expanded={more} className="col-span-2 md:col-span-1">
          <ListFilter />
          More filters
        </Button>
      </div>
      {more ? (
        <div className="grid animate-enter grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
          <TextFilter label="Organization" value={params.organization} onCommit={(v) => setParam("organization", v)} placeholder="Organization" />
          <TextFilter label="Branch" value={params.branch} onCommit={(v) => setParam("branch", v)} placeholder="Branch" />
          <NativeSelect aria-label="OEM" value={params.oem ?? ""} onChange={(e) => setParam("oem", e.target.value || undefined)}>
            <option value="">Any OEM</option>
            {oems.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Asset" value={params.assetId ?? ""} onChange={(e) => setParam("assetId", e.target.value || undefined)}>
            <option value="">Any asset</option>
            {(assets.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
          <DateFilter label="Installed from" value={params.installedFrom} onCommit={(v) => setParam("installedFrom", v)} />
          <DateFilter label="Installed to" value={params.installedTo} onCommit={(v) => setParam("installedTo", v)} />
          <NativeSelect
            aria-label="Last seen"
            value={LAST_SEEN.find((o) => params[o.key])?.value ?? ""}
            onChange={(e) => {
              const o = LAST_SEEN.find((x) => x.value === e.target.value);
              const next: Record<string, string | undefined> = { ...params, lastSeenAfter: undefined, lastSeenBefore: undefined };
              if (o) next[o.key] = new Date(Date.now() - o.ms).toISOString();
              setAll(next);
            }}
          >
            <option value="">Any last seen</option>
            {LAST_SEEN.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
    </div>
  );
}

function DateFilter({ label, value, onCommit }: { label: string; value?: string; onCommit: (v?: string) => void }) {
  return (
    <Input
      type="date"
      aria-label={label}
      title={label}
      value={value ? value.slice(0, 10) : ""}
      onChange={(e) => onCommit(e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : undefined)}
    />
  );
}

function TextFilter({ label, value, onCommit, placeholder }: { label: string; value?: string; onCommit: (v?: string) => void; placeholder: string }) {
  const [v, setV] = React.useState(value ?? "");
  React.useEffect(() => setV(value ?? ""), [value]);
  return (
    <Input
      aria-label={label}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (value ?? "") && onCommit(v || undefined)}
      onKeyDown={(e) => e.key === "Enter" && onCommit(v || undefined)}
    />
  );
}

// ── Cohorts ──────────────────────────────────────────────────────────────────
function Cohorts({ params, apply }: { params: Record<string, string>; apply: (p: Record<string, string>) => void }) {
  const [cohorts, setCohorts] = React.useState<Cohort[]>([]);
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(COHORT_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      setCohorts(Array.isArray(v) ? (v as Cohort[]) : []);
    } catch {
      setCohorts([]);
    }
  }, []);
  const save = (c: Cohort[]) => {
    setCohorts(c);
    try {
      localStorage.setItem(COHORT_KEY, JSON.stringify(c));
    } catch {
      /* ignore */
    }
  };
  const has = Object.keys(params).length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
          <Bookmark />
          Saved views{cohorts.length ? ` (${cohorts.length})` : ""}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Saved filter sets</DropdownMenuLabel>
        {cohorts.length === 0 ? <p className="px-2.5 py-2 text-sm text-muted">Save a set of filters to reuse it.</p> : null}
        {cohorts.map((c) => (
          <DropdownMenuItem key={c.name} onSelect={() => apply(c.params)}>
            <Bookmark />
            <span className="flex-1 truncate">{c.name}</span>
            <button
              type="button"
              className="cursor-pointer rounded-full p-1 text-subtle hover:text-danger"
              aria-label={`Delete ${c.name}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                save(cohorts.filter((x) => x.name !== c.name));
              }}
            >
              <X className="size-3.5" />
            </button>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!has}
          onSelect={() => {
            const name = window.prompt("Name this view", Object.entries(params).map(([k, v]) => `${CHIP_LABEL[k] ?? k}: ${chipValue(k, v)}`).join(", "));
            if (name) save([...cohorts.filter((c) => c.name !== name), { name, params }]);
          }}
        >
          <BookmarkPlus />
          Save current filters
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────
const DeviceRow = React.memo(function DeviceRow({
  d,
  checked,
  onCheck,
  onAction,
}: {
  d: Device;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onAction: (op: BulkOp) => void;
}) {
  const suspended = d.lifecycle === "suspended";
  return (
    <TR data-state={checked ? "selected" : undefined}>
      <TD>
        <Checkbox checked={checked} onCheckedChange={(v) => onCheck(!!v)} aria-label={`Select ${d.udi ?? d.serial}`} />
      </TD>
      <TD>
        <Link href={`/devices/${d.id}`} className="focus-ring group flex flex-col rounded-md">
          <span className="font-mono text-[13px] font-medium group-hover:underline group-hover:underline-offset-4">{d.udi ?? d.serial}</span>
          <span className="max-w-52 truncate text-xs text-subtle">{d.name ?? d.serial}</span>
        </Link>
      </TD>
      <TD className="hidden md:table-cell">
        <p className="max-w-44 truncate text-[13px]">{d.model ?? d.modelId}</p>
        <p className="text-xs text-subtle">{d.oem ?? "—"}</p>
      </TD>
      <TD>
        <LifecycleBadge state={d.lifecycle} />
      </TD>
      <TD>
        <ConnectivityDot value={d.health?.connectivity ?? "never_seen"} />
      </TD>
      <TD className="hidden xl:table-cell">
        {d.assetId ? (
          <Link href={`/assets/${d.assetId}`} className="focus-ring max-w-40 truncate rounded text-[13px] hover:underline">
            {d.assetName ?? d.assetId}
          </Link>
        ) : (
          <span className="text-xs text-subtle">Unassigned</span>
        )}
      </TD>
      <TD className="hidden lg:table-cell">
        <SimBadge status={d.sim?.status} />
      </TD>
      <TD className="hidden lg:table-cell">
        <span className="font-mono text-[12.5px] text-muted">{d.firmwareVersion ?? "—"}</span>
        {d.otaStatus && d.otaStatus !== "succeeded" ? <p className="text-[11px] text-signal">OTA {d.otaStatus.replace("_", " ")}</p> : null}
      </TD>
      <TD className="hidden text-[13px] whitespace-nowrap text-muted sm:table-cell">{fmt.ago(d.health?.lastSeenAt)}</TD>
      <TD>
        <HealthBadge level={d.health?.level} score={d.health?.score} />
      </TD>
      <TD>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${d.udi ?? d.serial}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/devices/${d.id}`}>Open Device 360</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAction("assign")}>
              <Link2 />
              {d.assetId ? "Reassign asset" : "Assign to asset"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("apply_config")}>
              <SlidersHorizontal />
              Apply configuration
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("diagnostics")}>
              <Stethoscope />
              Run diagnostics
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("lifecycle")}>Change lifecycle</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAction(suspended ? "reactivate" : "suspend")} className={suspended ? undefined : "text-danger"}>
              {suspended ? <Play /> : <Pause />}
              {suspended ? "Reactivate" : "Suspend"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TD>
    </TR>
  );
});

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6 sm:p-7">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="size-[18px] rounded-[6px]" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="hidden h-9 w-32 md:block" />
          <Skeleton className="h-6 w-28 rounded-[7px]" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

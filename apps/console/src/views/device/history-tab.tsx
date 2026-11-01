"use client";

import * as React from "react";
import {
  BellRing,
  GitBranch,
  HardHat,
  History,
  KeyRound,
  Link2,
  MessageSquareCode,
  Rocket,
  ScrollText,
  Send,
  SlidersHorizontal,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import type { TimelineKind } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeviceHistory } from "@/lib/api-v11";
import { cn, fmt, formatValue } from "@/lib/utils";

const KIND: Record<TimelineKind, { icon: LucideIcon; tone: string; label: string }> = {
  message: { icon: MessageSquareCode, tone: "text-muted", label: "Messages" },
  lifecycle: { icon: GitBranch, tone: "text-signal", label: "Lifecycle" },
  command: { icon: Send, tone: "text-signal", label: "Commands" },
  config: { icon: SlidersHorizontal, tone: "text-ion", label: "Configuration" },
  ota: { icon: Rocket, tone: "text-ion", label: "OTA" },
  alert: { icon: BellRing, tone: "text-ember", label: "Alerts" },
  audit: { icon: ScrollText, tone: "text-muted", label: "Audit" },
  association: { icon: Link2, tone: "text-signal", label: "Asset" },
  ownership: { icon: UserRoundCog, tone: "text-signal", label: "Ownership" },
  technician: { icon: HardHat, tone: "text-ember", label: "Technician" },
  security: { icon: KeyRound, tone: "text-danger", label: "Security" },
};

/** Filter chips from the spec (lifecycle, config, ownership, technician, command) plus related kinds. */
const CHIPS: TimelineKind[] = ["lifecycle", "config", "ownership", "technician", "command", "association", "ota", "alert", "security"];

const dayFmt = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export function HistoryTab({ id }: { id: string }) {
  const [kinds, setKinds] = React.useState<TimelineKind[]>([]);
  const query = useDeviceHistory(id, kinds.length ? kinds : CHIPS);
  const events = React.useMemo(
    () =>
      (query.data ?? [])
        .filter((e) => (kinds.length ? kinds.includes(e.kind) : e.kind !== "message"))
        .toSorted((a, b) => b.at.localeCompare(a.at)),
    [query.data, kinds],
  );
  const days = React.useMemo(() => {
    const m = new Map<string, typeof events>();
    for (const e of events) {
      const k = e.at.slice(0, 10);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()];
  }, [events]);

  const toggle = (k: TimelineKind) => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>History</PanelTitle>
          <PanelDescription>Every change to this device, permanently retained</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter history">
          <Chip active={kinds.length === 0} onClick={() => setKinds([])}>
            All changes
          </Chip>
          {CHIPS.map((k) => {
            const Icon = KIND[k].icon;
            return (
              <Chip key={k} active={kinds.includes(k)} onClick={() => toggle(k)}>
                <Icon className={cn("size-3.5", !kinds.includes(k) && KIND[k].tone)} />
                {KIND[k].label}
              </Chip>
            );
          })}
        </div>
        {query.isPending ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : query.error && !query.data ? (
          <ApiError error={query.error} onRetry={() => void query.refetch()} />
        ) : days.length === 0 ? (
          <Empty icon={History} title="Nothing recorded">
            {kinds.length ? "No events of these kinds. Try another filter." : "Changes appear here as they happen."}
          </Empty>
        ) : (
          <div className={cn("flex flex-col gap-8", query.isFetching && "opacity-70")}>
            {days.map(([day, list]) => (
              <section key={day}>
                <h3 className="mb-3 text-[13px] font-medium text-muted">{dayFmt.format(new Date(`${day}T00:00:00`))}</h3>
                <ol className="flex flex-col">
                  {list.map((e, i) => {
                    const k = KIND[e.kind] ?? KIND.audit;
                    const Icon = k.icon;
                    return (
                      <li key={e.id} className="relative flex gap-4 pb-5 last:pb-0">
                        {i < list.length - 1 ? <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-line" /> : null}
                        <span className="z-[1] flex size-8 shrink-0 items-center justify-center rounded-full bg-raised ring-1 ring-line ring-inset">
                          <Icon className={cn("size-3.5", k.tone)} />
                        </span>
                        <div className="min-w-0 flex-1 pt-1">
                          <div className="flex items-baseline gap-3">
                            <p className="text-sm font-medium">{e.title}</p>
                            <span className="text-xs text-subtle">{k.label}</span>
                            <span className="ml-auto shrink-0 text-xs text-subtle tabular">{fmt.time(e.at)}</span>
                          </div>
                          {e.detail && Object.keys(e.detail).length ? (
                            <p className="mt-1 truncate text-[13px] text-muted">
                              {Object.entries(e.detail)
                                .slice(0, 4)
                                .map(([dk, dv]) => `${dk} ${formatValue(dv)}`)
                                .join(", ")}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-ring inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
        active ? "bg-inverse text-inverse-fg" : "text-muted ring-1 ring-line ring-inset hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

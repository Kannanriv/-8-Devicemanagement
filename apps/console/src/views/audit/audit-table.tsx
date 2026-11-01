"use client";

import * as React from "react";
import Link from "next/link";
import { Bot, ScrollText, Server, User } from "lucide-react";
import type { AuditEntry } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { cn, fmt } from "@/lib/utils";

function targetHref(target: string) {
  const [kind, id] = target.split(":");
  if (!id) return null;
  if (kind === "device") return `/devices/${id}`;
  if (kind === "campaign" || kind === "ota") return `/ota/${id}`;
  if (kind === "codec") return `/codecs/${id}`;
  if (kind === "spec-import") return `/spec-imports/${id}`;
  return null;
}

export function ActorLabel({ actor }: { actor: string }) {
  const [kind, name] = actor.includes(":") ? actor.split(/:(.*)/s) : ["system", actor];
  const Icon = kind === "agent" ? Bot : kind === "user" ? User : Server;
  return (
    <span className="inline-flex items-center gap-2 text-[13px]">
      <span
        className={cn(
          "flex size-6 items-center justify-center rounded-full ring-1 ring-inset",
          kind === "agent" ? "bg-signal/10 text-signal ring-signal/25" : "bg-hover text-muted ring-line",
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className={kind === "system" ? "text-muted" : undefined}>{name || kind}</span>
    </span>
  );
}

export function AuditTable({
  query,
  hideTarget,
}: {
  query: { data?: AuditEntry[]; error: unknown; isPending: boolean; isFetching?: boolean; refetch: () => unknown };
  hideTarget?: boolean;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  if (query.isPending)
    return (
      <div className="flex flex-col gap-2 px-7 pb-7">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
    );
  if (query.error && !query.data) return <ApiError error={query.error} onRetry={() => void query.refetch()} />;
  const list = (query.data ?? []).toSorted((a, b) => b.at.localeCompare(a.at));
  if (list.length === 0)
    return (
      <Empty icon={ScrollText} title="No audit entries">
        Every change by people, agents and the system is recorded here.
      </Empty>
    );
  return (
    <Table className={cn(query.isFetching && "opacity-70")}>
      <THead>
        <TR>
          <TH>When</TH>
          <TH>Actor</TH>
          <TH>Action</TH>
          {!hideTarget ? <TH>Target</TH> : null}
          <TH className="hidden lg:table-cell">Detail</TH>
        </TR>
      </THead>
      <TBody>
        {list.map((e) => {
          const href = targetHref(e.target);
          const detail = e.detail ? JSON.stringify(e.detail) : "";
          return (
            <TR key={e.id} className="cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)}>
              <TD className="text-[13px] whitespace-nowrap text-muted tabular">{fmt.dateTime(e.at)}</TD>
              <TD>
                <ActorLabel actor={e.actor} />
              </TD>
              <TD className="font-mono text-[12.5px]">{e.action}</TD>
              {!hideTarget ? (
                <TD className="font-mono text-[12.5px] text-muted">
                  {href ? (
                    <Link href={href} onClick={(ev) => ev.stopPropagation()} className="focus-ring rounded hover:text-fg hover:underline">
                      {e.target}
                    </Link>
                  ) : (
                    e.target
                  )}
                </TD>
              ) : null}
              <TD className="hidden max-w-[420px] lg:table-cell">
                <span className={cn("block font-mono text-xs text-subtle", open === e.id ? "break-all whitespace-pre-wrap" : "truncate")}>
                  {open === e.id && e.detail ? JSON.stringify(e.detail, null, 2) : detail}
                </span>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useAssetAssociations } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";
import { ActorLabel } from "@/views/audit/audit-table";

export function AssociationHistory({ assetId, highlightDevice }: { assetId: string; highlightDevice?: string }) {
  const q = useAssetAssociations(assetId);
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  if (q.error) return <ApiError error={q.error} onRetry={() => void q.refetch()} />;
  const list = (q.data ?? []).toSorted((a, b) => b.from.localeCompare(a.from));
  if (!list.length)
    return (
      <Empty icon={History} title="No associations yet" className="py-8">
        Installs, swaps and removals are recorded here.
      </Empty>
    );
  return (
    <ol className="flex flex-col">
      {list.map((a, i) => {
        const current = !a.to;
        return (
          <li key={a.id} className="relative flex gap-4 pb-5 last:pb-0">
            {i < list.length - 1 ? <span aria-hidden className="absolute top-4 bottom-0 left-[5px] w-px bg-line" /> : null}
            <span className={cn("relative z-[1] mt-1.5 size-[11px] shrink-0 rounded-full ring-1 ring-inset", current ? "bg-ion ring-ion" : "bg-panel ring-line-strong")} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/devices/${a.deviceId}`} className={cn("focus-ring rounded font-mono text-[13px] hover:underline", a.deviceId === highlightDevice && "text-signal")}>
                  {a.deviceId}
                </Link>
                <Badge>{fmt.label(a.role)}</Badge>
                {a.reason ? <Badge tone={a.reason === "swap" ? "ember" : "neutral"}>{fmt.label(a.reason)}</Badge> : null}
                {current ? <Badge tone="ion">Current</Badge> : null}
              </div>
              <p className="mt-1 text-[13px] text-muted">
                {fmt.dateTime(a.from)}
                {a.to ? ` to ${fmt.dateTime(a.to)}` : " to now"}
              </p>
              <div className="mt-1.5">
                <ActorLabel actor={a.actor} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

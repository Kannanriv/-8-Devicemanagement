"use client";

import * as React from "react";
import { Binary } from "lucide-react";
import type { DeviceModel } from "@hash8/sdk-ts";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCodecs } from "@/lib/api";
import { groupCodecs } from "@/views/codecs/codecs-view";
import { cn } from "@/lib/utils";

export function useCodecIndex() {
  const codecs = useCodecs();
  return React.useMemo(() => {
    const m = new Map<string, { version: string; published: boolean }>();
    for (const g of groupCodecs(codecs.data ?? [])) {
      const v = g.published ?? g.latest;
      m.set(g.id, { version: v.version, published: !!g.published });
    }
    return m;
  }, [codecs.data]);
}

export function CodecBadge({ codecId, index }: { codecId?: string; index: Map<string, { version: string; published: boolean }> }) {
  if (!codecId) return <Badge tone="ember">No codec</Badge>;
  const c = index.get(codecId);
  return (
    <Badge tone={c?.published ? "ion" : "ember"} className="font-mono text-[11px]">
      <Binary />
      {codecId}
      {c ? `@${c.version}` : ""}
      {c && !c.published ? " draft" : ""}
    </Badge>
  );
}

/** Radio-card model picker that shows which codec will decode the device. */
export function ModelPicker({
  models,
  loading,
  value,
  onChange,
  name = "model",
}: {
  models: DeviceModel[];
  loading?: boolean;
  value: string;
  onChange: (id: string) => void;
  name?: string;
}) {
  const index = useCodecIndex();
  if (loading)
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  if (!models.length) return <p className="text-sm text-muted">No device models yet. Register a model through the API (POST /models) first.</p>;
  return (
    <div role="radiogroup" aria-label="Device model" className="grid gap-2 sm:grid-cols-2">
      {models.map((m) => {
        const on = value === m.id;
        return (
          <label
            key={m.id}
            className={cn(
              "focus-within:ring-signal/60 flex cursor-pointer flex-col gap-2 rounded-card border p-4 transition-colors focus-within:ring-2",
              on ? "border-signal/60 bg-signal/[0.06]" : "border-line hover:border-line-strong hover:bg-hover",
            )}
          >
            <input type="radio" name={name} value={m.id} checked={on} onChange={() => onChange(m.id)} className="sr-only" />
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-xs text-muted">{m.vendor}</span>
                <span className="block truncate text-sm font-semibold">{m.name}</span>
              </span>
              <span
                aria-hidden
                className={cn("mt-1 size-4 shrink-0 rounded-full ring-1 ring-inset", on ? "bg-signal ring-signal shadow-[inset_0_0_0_3px_var(--panel)]" : "ring-line-strong")}
              />
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <CodecBadge codecId={m.codecId} index={index} />
              {m.protocols.slice(0, 2).map((p) => (
                <Badge key={p}>{p.toUpperCase()}</Badge>
              ))}
            </span>
          </label>
        );
      })}
    </div>
  );
}

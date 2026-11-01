import * as React from "react";
import { FileSpreadsheet } from "lucide-react";
import type { MessageDef, SourceRef } from "@hash8/dcs-schema";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { fieldRows, sourceLabel, unitLabel } from "@/lib/dcs";
import { cn } from "@/lib/utils";

export const LOW_CONFIDENCE = 0.75;

export function SourceBadge({ source }: { source?: SourceRef }) {
  const label = sourceLabel(source);
  if (!label) return <span className="text-xs text-subtle">—</span>;
  const low = source?.confidence != null && source.confidence < LOW_CONFIDENCE;
  const badge = (
    <Badge tone={low ? "ember" : "neutral"} className="cursor-default font-mono text-[11px]">
      <FileSpreadsheet />
      {label}
    </Badge>
  );
  return source?.text ? (
    <Tooltip content={<span className="block max-w-xs whitespace-pre-wrap">“{source.text}”</span>}>
      <span tabIndex={0} className="focus-ring rounded-full">
        {badge}
      </span>
    </Tooltip>
  ) : (
    badge
  );
}

/** Messages & fields table for one DCS message, with source trace and low-confidence highlighting. */
export function SpecFieldsTable({ msg, highlightLow }: { msg: MessageDef; highlightLow?: boolean }) {
  const rows = React.useMemo(() => fieldRows(msg.fields), [msg]);
  return (
    <div className="scrollbar-quiet overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-xs text-subtle">
            <th className="h-9 pr-3 pl-6 font-medium sm:pl-7">Field</th>
            <th className="px-3 font-medium">Type</th>
            <th className="px-3 text-right font-medium">Bits</th>
            <th className="px-3 font-medium">Unit</th>
            <th className="px-3 text-right font-medium">Scale</th>
            <th className="px-3 font-medium">Enum</th>
            <th className="pr-6 pl-3 font-medium sm:pr-7">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const structural = r.detail === "group" || r.detail === "case" || r.detail?.startsWith("repeat") || r.detail?.startsWith("switch");
            const low = highlightLow && r.source?.confidence != null && r.source.confidence < LOW_CONFIDENCE;
            return (
              <tr key={r.path + (r.detail ?? "")} className={cn("border-b border-line last:border-0", low && "bg-ember/[0.06]")}>
                <td className="py-2.5 pr-3 pl-6 sm:pl-7">
                  <div className="flex items-center gap-2" style={{ paddingLeft: r.depth * 16 }}>
                    {low ? <span className="size-1.5 shrink-0 rounded-full bg-ember" aria-label="Low confidence" /> : null}
                    <span className={cn("font-mono", structural ? "text-muted" : "text-fg", r.hidden && "text-subtle line-through")}>{r.name}</span>
                    {r.detail && structural ? <span className="text-xs text-subtle">{r.detail}</span> : null}
                  </div>
                  {r.description && !structural ? <p className="mt-0.5 max-w-sm truncate text-xs text-subtle" style={{ paddingLeft: r.depth * 16 }}>{r.description}</p> : null}
                </td>
                <td className="px-3 font-mono text-muted">
                  {r.type ?? ""}
                  {r.kind === "const" && r.value != null ? <span className="text-subtle"> = 0x{r.value.toString(16).toUpperCase()}</span> : null}
                </td>
                <td className="px-3 text-right tabular text-muted">{r.bits ?? (typeof r.length === "number" ? `${r.length * 8}` : r.length === "remaining" ? "…" : "")}</td>
                <td className="px-3 text-muted">{unitLabel(r.unit)}</td>
                <td className="px-3 text-right font-mono text-muted">
                  {r.scale != null ? `×${r.scale}` : ""}
                  {r.offset ? ` ${r.offset > 0 ? "+" : "−"}${Math.abs(r.offset)}` : ""}
                </td>
                <td className="px-3">
                  {r.enumMap ? (
                    <Tooltip
                      content={
                        <span className="block font-mono">
                          {Object.entries(r.enumMap).map(([k, v]) => (
                            <span key={k} className="block">
                              {k} → {v}
                            </span>
                          ))}
                        </span>
                      }
                    >
                      <span tabIndex={0} className="focus-ring cursor-default rounded text-muted underline decoration-dotted underline-offset-4">
                        {Object.keys(r.enumMap).length} values
                      </span>
                    </Tooltip>
                  ) : null}
                </td>
                <td className="py-2 pr-6 pl-3 sm:pr-7">{!structural || r.source ? <SourceBadge source={r.source} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

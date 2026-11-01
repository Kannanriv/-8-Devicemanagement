"use client";

import * as React from "react";
import type { FieldRange } from "@/lib/dcs";
import { cn, flatten, formatValue, hexBytes } from "@/lib/utils";

const HUES = ["var(--signal)", "var(--ion)", "var(--ember)", "#B48CFF", "#FFC857", "#5BC8FF", "#FF7AB6"];

/**
 * Raw hex ↔ decoded inspector. When `ranges` are known (static layout from the
 * codec), each field’s bytes are tinted and hovering a byte or field links both sides.
 */
export function HexInspector({
  hex,
  data,
  ranges,
  className,
}: {
  hex: string;
  data?: Record<string, unknown>;
  ranges?: FieldRange[];
  className?: string;
}) {
  const bytes = React.useMemo(() => hexBytes(hex), [hex]);
  const [active, setActive] = React.useState<string | null>(null);
  const visible = React.useMemo(() => (ranges ?? []).filter((r) => r.bits > 0), [ranges]);
  const colorOf = React.useMemo(() => {
    const m = new Map<string, string>();
    visible.forEach((r, i) => m.set(r.path, HUES[i % HUES.length]!));
    return m;
  }, [visible]);

  const byteField = React.useMemo(() => {
    const arr: (FieldRange | undefined)[] = new Array(bytes.length);
    for (const r of visible) {
      const first = Math.floor(r.startBit / 8);
      const last = Math.floor((r.startBit + r.bits - 1) / 8);
      for (let i = first; i <= last && i < bytes.length; i++) arr[i] ??= r;
    }
    return arr;
  }, [visible, bytes.length]);

  const flat = React.useMemo(() => (data ? flatten(data) : {}), [data]);

  return (
    <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]", className)}>
      <div className="rounded-card bg-sunken/60 p-4 ring-1 ring-line ring-inset">
        <div className="mb-3 flex items-center justify-between text-xs text-subtle">
          <span>Raw payload</span>
          <span className="tabular">{bytes.length} bytes</span>
        </div>
        <div className="flex flex-wrap gap-1 font-mono text-[13px]" onMouseLeave={() => setActive(null)}>
          {bytes.map((b, i) => {
            const r = byteField[i];
            const color = r ? colorOf.get(r.path) : undefined;
            const on = r && active === r.path;
            return (
              <span
                key={i}
                onMouseEnter={() => setActive(r?.path ?? null)}
                title={r ? `${r.path} · byte ${i}` : `byte ${i}`}
                className={cn(
                  "inline-flex h-7 w-8 items-center justify-center rounded-[8px] tabular transition-[background-color,box-shadow,opacity] duration-150",
                  !r && "text-subtle",
                  active && r && !on && "opacity-40",
                )}
                style={
                  color
                    ? {
                        color,
                        backgroundColor: `color-mix(in oklab, ${color} ${on ? 26 : 12}%, transparent)`,
                        boxShadow: on ? `inset 0 0 0 1px ${color}` : undefined,
                      }
                    : undefined
                }
              >
                {b}
              </span>
            );
          })}
        </div>
        {visible.length ? (
          <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
            {visible.map((r) => (
              <button
                key={r.path}
                type="button"
                onMouseEnter={() => setActive(r.path)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(r.path)}
                onBlur={() => setActive(null)}
                className={cn("focus-ring flex cursor-default items-center gap-1.5 rounded-md text-muted", active === r.path && "text-fg")}
              >
                <span className="size-2 rounded-[3px]" style={{ background: colorOf.get(r.path) }} />
                {r.path}
                <span className="text-subtle tabular">{r.bits}b</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rounded-card bg-sunken/60 p-4 ring-1 ring-line ring-inset">
        <div className="mb-3 text-xs text-subtle">Decoded</div>
        {Object.keys(flat).length === 0 ? (
          <p className="text-sm text-muted">Nothing decoded for this payload.</p>
        ) : (
          <dl className="flex flex-col font-mono text-[13px]">
            {Object.entries(flat).map(([k, v]) => {
              const color = colorOf.get(k);
              const on = active === k;
              return (
                <div
                  key={k}
                  onMouseEnter={() => colorOf.has(k) && setActive(k)}
                  onMouseLeave={() => setActive(null)}
                  className={cn(
                    "flex items-baseline justify-between gap-4 rounded-[8px] px-2 py-1 transition-colors",
                    on && "bg-hover",
                    active && !on && colorOf.has(active) && "opacity-50",
                  )}
                >
                  <dt className="flex min-w-0 items-center gap-2 truncate text-muted">
                    {color ? <span className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} /> : <span className="size-2 shrink-0" />}
                    {k}
                  </dt>
                  <dd className="shrink-0 text-fg tabular">{formatValue(v)}</dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
    </div>
  );
}

/** Minimal syntax-tinted JSON block. */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const html = React.useMemo(() => {
    const json = JSON.stringify(value, null, 2) ?? "undefined";
    const esc = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (m) => {
        let cls = "text-ion";
        if (m.startsWith('"')) cls = m.endsWith(":") ? "text-muted" : "text-fg";
        else if (/true|false|null/.test(m)) cls = "text-ember";
        return `<span class="${cls}">${m}</span>`;
      },
    );
  }, [value]);
  return (
    <pre
      className={cn("scrollbar-quiet overflow-auto rounded-card bg-sunken/60 p-4 font-mono text-[12.5px] leading-relaxed ring-1 ring-line ring-inset", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

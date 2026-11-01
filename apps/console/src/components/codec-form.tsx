"use client";

import * as React from "react";
import type { MessageDef } from "@hash8/dcs-schema";
import { Field, FieldHint, Input, Label, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { fieldRows, unitLabel, type FieldRow } from "@/lib/dcs";

/** Value-bearing input rows of a message (skips consts, checksums, hidden and structural rows). */
export function inputRows(msg: MessageDef): FieldRow[] {
  return fieldRows(msg.fields).filter((r) => r.kind === "scalar" && !r.hidden && !r.path.includes("[]"));
}

export function defaultValues(msg: MessageDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of inputRows(msg)) {
    const raw = findField(msg, r.path) as { default?: unknown } | undefined;
    if (raw?.default !== undefined) setPath(out, r.path, raw.default);
  }
  return out;
}

function findField(msg: MessageDef, path: string): unknown {
  const parts = path.split(".");
  let fields: unknown[] = msg.fields;
  let found: unknown;
  for (const p of parts) {
    found = fields.find((f) => (f as { name: string }).name === p);
    if (!found) return undefined;
    fields = ((found as { fields?: unknown[] }).fields ?? []) as unknown[];
  }
  return found;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  if (value === undefined || value === "") delete cur[parts[parts.length - 1]!];
  else cur[parts[parts.length - 1]!] = value;
}

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

/** Form generated from a DCS downlink message definition. */
export function CodecMessageForm({
  msg,
  value,
  onChange,
  idPrefix = "f",
}: {
  msg: MessageDef;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  idPrefix?: string;
}) {
  const rows = inputRows(msg);
  if (rows.length === 0) return <p className="text-sm text-muted">This message has no parameters.</p>;
  const update = (path: string, v: unknown) => {
    const next = structuredClone(value);
    setPath(next, path, v);
    onChange(next);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {rows.map((r) => {
        const id = `${idPrefix}-${r.path}`;
        const cur = getPath(value, r.path);
        const unit = unitLabel(r.unit);
        const range = r.min != null || r.max != null ? `${r.min ?? "…"} to ${r.max ?? "…"}${unit ? ` ${unit}` : ""}` : null;
        return (
          <Field key={r.path}>
            <Label htmlFor={id}>
              {r.path}
              {unit ? <span className="ml-1 text-subtle">({unit})</span> : null}
            </Label>
            {r.enumMap ? (
              <NativeSelect id={id} value={cur == null ? "" : String(cur)} onChange={(e) => update(r.path, e.target.value || undefined)}>
                <option value="">Choose…</option>
                {Object.entries(r.enumMap).map(([raw, label]) => (
                  <option key={raw} value={label}>
                    {label} ({raw})
                  </option>
                ))}
              </NativeSelect>
            ) : r.type === "bool" ? (
              <div className="flex h-10 items-center">
                <Switch id={id} checked={!!cur} onCheckedChange={(v) => update(r.path, v)} />
              </div>
            ) : r.type === "string" || r.type === "bytes" || r.type === "bcd" ? (
              <Input
                id={id}
                value={cur == null ? "" : String(cur)}
                onChange={(e) => update(r.path, e.target.value)}
                className={r.type !== "string" ? "font-mono" : undefined}
                placeholder={r.type === "bytes" ? "hex" : undefined}
              />
            ) : (
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                step="any"
                min={r.min}
                max={r.max}
                value={cur == null ? "" : String(cur)}
                onChange={(e) => update(r.path, e.target.value === "" ? undefined : Number(e.target.value))}
              />
            )}
            {r.description || range ? <FieldHint>{[r.description, range].filter(Boolean).join(". ")}</FieldHint> : null}
          </Field>
        );
      })}
    </div>
  );
}

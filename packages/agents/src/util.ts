import type { Field, ScalarField } from "@hash8/dcs-schema";

/** Raw integer range of a uint/int of `bits` width. */
export function representable(type: string, bits: number): [number, number] {
  if (type === "int") return [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1];
  return [0, 2 ** bits - 1];
}

/** Round like the runtime's semantics pipeline (decimals, or 10 decimals for non-integer scale/offset). */
export function roundLike(v: number, f: Pick<ScalarField, "decimals" | "scale" | "offset">): number {
  if (f.decimals !== undefined) return Number(v.toFixed(f.decimals));
  if (!Number.isInteger(f.scale ?? 1) || !Number.isInteger(f.offset ?? 0)) return Number(v.toFixed(10));
  return v;
}

/** Visit every scalar field (with dotted path); switch cases are visited at the parent level. */
export function walkScalars(fields: Field[], fn: (f: ScalarField, path: string) => void, prefix = ""): void {
  for (const f of fields) {
    if (f.kind === "scalar") fn(f, prefix + f.name);
    else if (f.kind === "group" || f.kind === "repeat") walkScalars(f.fields, fn, `${prefix}${f.name}.`);
    else if (f.kind === "switch") {
      for (const c of Object.values(f.cases)) walkScalars(c, fn, prefix);
      if (f.default) walkScalars(f.default, fn, prefix);
    }
  }
}

/** Structural diff with 1e-9 numeric tolerance. */
export function deepDiff(expected: unknown, actual: unknown, path = ""): string[] {
  const out: string[] = [];
  const at = path || "(root)";
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(expected - actual) > 1e-9) out.push(`${at}: expected ${expected}, got ${actual}`);
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push(`${at}: expected ${expected.length} items, got ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) out.push(...deepDiff(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }
  if (isObj(expected) && isObj(actual)) {
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in actual)) out.push(`${p}: missing`);
      else if (!(k in expected)) out.push(`${p}: unexpected`);
      else out.push(...deepDiff(expected[k], actual[k], p));
    }
    return out;
  }
  if (expected !== actual) out.push(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return out;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Flatten numeric leaves of decoded data: {a:{b:1}} -> {"a.b":1}. Booleans count as 0/1. */
export function numericLeaves(data: Record<string, unknown> | undefined, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (!data) return out;
  for (const [k, v] of Object.entries(data)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out[p] = v;
    else if (isObj(v)) numericLeaves(v, p, out);
  }
  return out;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

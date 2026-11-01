import type { DeviceCodecSpec, Field, MessageDef } from "@hash8/dcs-schema";

export type SemverBump = "major" | "minor" | "patch";
export interface SpecDiff {
  breaking: boolean;
  /** Human-readable field-level diff, each line prefixed with BREAKING / MINOR / PATCH. */
  changes: string[];
  suggestedBump: SemverBump;
}

type Level = "BREAKING" | "MINOR" | "PATCH";
interface Flat {
  path: string;
  field: Field;
  /** Static bit offset from message (or repeat element) start; null when it depends on runtime data. */
  offset: number | null;
}

const CHECKSUM_BITS: Record<string, number> = { crc8: 8, xor8: 8, sum8: 8, "crc16-ccitt": 16, "crc16-modbus": 16, crc32: 32 };
const DEFAULT_BITS: Record<string, number> = { uint: 8, int: 8, bool: 1, float: 32 };

/** Static width in bits of a field, or null when it is data-dependent. */
function widthOf(f: Field): number | null {
  switch (f.kind) {
    case "const":
      return f.bits;
    case "checksum":
      return CHECKSUM_BITS[f.algo] ?? null;
    case "scalar":
      if (f.type === "bytes" || f.type === "string" || f.type === "bcd") return typeof f.length === "number" ? f.length * 8 : null;
      return f.bits ?? DEFAULT_BITS[f.type] ?? 8;
    case "group": {
      let total = 0;
      for (const c of f.fields) {
        const w = widthOf(c);
        if (w === null) return null;
        total += w;
      }
      return total;
    }
    case "repeat": {
      if (typeof f.count !== "number") return null;
      let el = 0;
      for (const c of f.fields) {
        const w = widthOf(c);
        if (w === null) return null;
        el += w;
      }
      return el * f.count;
    }
    case "switch":
      return null;
  }
}

/** Flatten a field list into dotted paths with static bit offsets. */
function flatten(fields: Field[], prefix: string, start: number | null, out: Flat[]): number | null {
  let cursor = start;
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    out.push({ path, field: f, offset: cursor });
    if (f.kind === "group") {
      cursor = flatten(f.fields, path, cursor, out);
      continue;
    }
    if (f.kind === "repeat") flatten(f.fields, `${path}[]`, 0, out);
    if (f.kind === "switch") {
      for (const [k, c] of Object.entries(f.cases)) flatten(c, `${prefix ? `${prefix}.` : ""}${f.name}[${k}]`, cursor, out);
      if (f.default) flatten(f.default, `${prefix ? `${prefix}.` : ""}${f.name}[default]`, cursor, out);
    }
    const w = widthOf(f);
    cursor = cursor === null || w === null ? null : cursor + w;
  }
  return cursor;
}

const show = (v: unknown) => (v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v));
const typeLabel = (f: Field) => (f.kind === "scalar" ? f.type : f.kind);

function sizeLabel(f: Field): string {
  const w = widthOf(f);
  if (f.kind === "scalar" && (f.type === "bytes" || f.type === "string" || f.type === "bcd")) return typeof f.length === "number" ? `${f.length} bytes` : `${String(f.length)} length`;
  return w === null ? "variable" : `${w} bits`;
}

function compareField(where: string, a: Flat, b: Flat, add: (lvl: Level, msg: string) => void, shifted: Map<string, number>) {
  const at = `${where}.${b.path}`;
  const fa = a.field as Field & Record<string, unknown>;
  const fb = b.field as Field & Record<string, unknown>;
  if (typeLabel(a.field) !== typeLabel(b.field)) {
    add("BREAKING", `${at}: type ${typeLabel(a.field)} → ${typeLabel(b.field)}`);
    return;
  }
  // Layout (A) — any change breaks existing decoders.
  for (const k of ["bits", "length", "endian"] as const) {
    if (k === "endian" && fa.endian === undefined && fb.endian === undefined) continue;
    const va = k === "endian" ? (fa.endian ?? "big") : fa[k];
    const vb = k === "endian" ? (fb.endian ?? "big") : fb[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) add("BREAKING", `${at}: ${k} ${show(va)} → ${show(vb)}`);
  }
  if (a.offset !== b.offset && a.offset !== null && b.offset !== null) {
    const delta = b.offset - a.offset;
    shifted.set(b.path, delta);
    // A group that moved implies its children moved — report the top-most shift only.
    const parent = b.path.includes(".") ? b.path.slice(0, b.path.lastIndexOf(".")) : undefined;
    if (parent === undefined || shifted.get(parent) !== delta) add("BREAKING", `${at}: offset bit ${a.offset} → bit ${b.offset}`);
  }
  // Semantics (B) that change decoded values.
  for (const k of ["scale", "offset", "value", "algo", "count", "on", "hidden"] as const) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) add("BREAKING", `${at}: ${k} ${show(fa[k])} → ${show(fb[k])}`);
  }
  const ea = (fa.enum ?? {}) as Record<string, string>;
  const eb = (fb.enum ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(ea)) {
    if (!(k in eb)) add("BREAKING", `${at}: enum value ${k}=${v} removed`);
    else if (eb[k] !== v) add("BREAKING", `${at}: enum value ${k} relabelled ${v} → ${eb[k]}`);
  }
  for (const [k, v] of Object.entries(eb)) if (!(k in ea)) add("MINOR", `${at}: enum value ${k}=${v} added`);
  if (fa.decimals !== fb.decimals) add("MINOR", `${at}: decimals ${show(fa.decimals)} → ${show(fb.decimals)}`);
  if (fa.default !== fb.default) add("MINOR", `${at}: default ${show(fa.default)} → ${show(fb.default)}`);
  // Documentation-only (patch).
  for (const k of ["unit", "min", "max", "semantic"] as const) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) add("PATCH", `${at}: ${k} ${show(fa[k])} → ${show(fb[k])}`);
  }
  if ((fa.description ?? "") !== (fb.description ?? "")) add("PATCH", `${at}: description updated`);
}

function compareMessages(dir: "uplink" | "downlink", prev: MessageDef[], next: MessageDef[], add: (lvl: Level, msg: string) => void) {
  const pm = new Map(prev.map((m) => [m.name, m]));
  const nm = new Map(next.map((m) => [m.name, m]));
  for (const m of prev) if (!nm.has(m.name)) add("BREAKING", `${dir} ${m.name}: message removed`);
  for (const m of next) {
    const old = pm.get(m.name);
    if (!old) {
      add("MINOR", `${dir} ${m.name}: message added`);
      continue;
    }
    const where = `${dir} ${m.name}`;
    if (JSON.stringify(old.when ?? {}) !== JSON.stringify(m.when ?? {})) add("BREAKING", `${where}: when ${JSON.stringify(old.when ?? {})} → ${JSON.stringify(m.when ?? {})}`);
    if ((old.description ?? "") !== (m.description ?? "")) add("PATCH", `${where}: description updated`);
    const fa: Flat[] = [];
    const fb: Flat[] = [];
    flatten(old.fields, "", 0, fa);
    flatten(m.fields, "", 0, fb);
    const ma = new Map(fa.map((f) => [f.path, f]));
    const mb = new Map(fb.map((f) => [f.path, f]));
    const shifted = new Map<string, number>();
    for (const f of fa) if (!mb.has(f.path) && !hasRemovedAncestor(f.path, mb)) add("BREAKING", `${where}.${f.path}: field removed`);
    for (const f of fb) {
      const o = ma.get(f.path);
      if (!o) {
        if (!hasRemovedAncestor(f.path, ma)) add("MINOR", `${where}.${f.path}: field added (${typeLabel(f.field)}, ${sizeLabel(f.field)})`);
        continue;
      }
      compareField(where, o, f, add, shifted);
    }
  }
}

/** True when a parent path of `path` is absent from `other` (report only the top-most add/remove). */
function hasRemovedAncestor(path: string, other: Map<string, Flat>): boolean {
  const parts = path.split(".");
  for (let i = 1; i < parts.length; i++) {
    const anc = parts.slice(0, i).join(".");
    const base = anc.replace(/\[[^\]]*\]$/, "");
    if (!other.has(anc) && !other.has(base)) return true;
  }
  return false;
}

/** Field-level diff between two DCS versions with a semver recommendation. */
export function diffSpecs(prev: DeviceCodecSpec, next: DeviceCodecSpec): SpecDiff {
  const lines: { lvl: Level; msg: string }[] = [];
  const add = (lvl: Level, msg: string) => lines.push({ lvl, msg });
  compareMessages("uplink", prev.uplink, next.uplink, add);
  compareMessages("downlink", prev.downlink ?? [], next.downlink ?? [], add);
  if (JSON.stringify(prev.defaults ?? {}) !== JSON.stringify(next.defaults ?? {})) {
    add("BREAKING", `defaults: endian ${prev.defaults?.endian ?? "big"} → ${next.defaults?.endian ?? "big"}`);
  }
  if ((prev.device.firmware ?? "") !== (next.device.firmware ?? "")) add("PATCH", `device: firmware range ${show(prev.device.firmware)} → ${show(next.device.firmware)}`);
  if ((prev.device.description ?? "") !== (next.device.description ?? "")) add("PATCH", "device: description updated");
  const va = new Map((prev.vectors ?? []).map((v) => [v.name, JSON.stringify(v)]));
  const vb = new Map((next.vectors ?? []).map((v) => [v.name, JSON.stringify(v)]));
  const vAdded = [...vb.keys()].filter((k) => !va.has(k)).length;
  const vRemoved = [...va.keys()].filter((k) => !vb.has(k)).length;
  const vChanged = [...vb.keys()].filter((k) => va.has(k) && va.get(k) !== vb.get(k)).length;
  if (vAdded || vRemoved || vChanged) add("PATCH", `vectors: ${vAdded} added, ${vRemoved} removed, ${vChanged} changed (${vb.size} total)`);

  const order: Record<Level, number> = { BREAKING: 0, MINOR: 1, PATCH: 2 };
  const seen = new Set<string>();
  const changes = lines
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => order[a.lvl] - order[b.lvl] || a.i - b.i)
    .map((l) => `${l.lvl} ${l.msg}`)
    .filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  const breaking = lines.some((l) => l.lvl === "BREAKING");
  const minor = lines.some((l) => l.lvl === "MINOR");
  return { breaking, changes, suggestedBump: breaking ? "major" : minor ? "minor" : "patch" };
}

/** Bump a semver by the given level. */
export function bumpVersion(version: string, bump: SemverBump): string {
  const [ma = 0, mi = 0, pa = 0] = version.split("-")[0]!.split(".").map((x) => Number(x) || 0);
  if (bump === "major") return `${ma + 1}.0.0`;
  if (bump === "minor") return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/** Semver comparison (release > prerelease). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map((x) => Number(x) || 0);
  const pb = b.split("-")[0]!.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  const ra = a.includes("-");
  const rb = b.includes("-");
  return ra === rb ? 0 : ra ? -1 : 1;
}

/** The bump actually applied between two versions. */
export function actualBump(prev: string, next: string): SemverBump | "none" {
  const pa = prev.split("-")[0]!.split(".").map((x) => Number(x) || 0);
  const pb = next.split("-")[0]!.split(".").map((x) => Number(x) || 0);
  if (compareSemver(next, prev) <= 0) return "none";
  if ((pb[0] ?? 0) > (pa[0] ?? 0)) return "major";
  if ((pb[1] ?? 0) > (pa[1] ?? 0)) return "minor";
  return "patch";
}

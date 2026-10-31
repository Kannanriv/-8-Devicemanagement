import type { ConfigTemplate, DeviceConfig } from "@hash8/sdk-ts";

type Obj = Record<string, unknown>;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(v: unknown): v is Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Dot paths (sorted) of desired leaves whose reported value differs. Reported-only keys are not drift. */
export function diffConfig(desired: Obj, reported: Obj): string[] {
  const out: string[] = [];
  const walk = (d: Obj, r: unknown, prefix: string) => {
    for (const key of Object.keys(d)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const dv = d[key];
      const rv = isPlainObject(r) && Object.hasOwn(r, key) ? r[key] : undefined;
      if (isPlainObject(dv) && isPlainObject(rv)) walk(dv, rv, path);
      else if (isPlainObject(dv) && rv === undefined) walk(dv, {}, path);
      else if (!deepEqual(dv, rv)) out.push(path);
    }
  };
  walk(desired, reported, "");
  return out.sort();
}

function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepClone) as T;
  if (isPlainObject(v)) {
    const o: Obj = {};
    for (const k of Object.keys(v)) if (!UNSAFE_KEYS.has(k)) o[k] = deepClone(v[k]);
    return o as T;
  }
  return v;
}

function deepMerge(base: Obj, over: Obj): Obj {
  const out = deepClone(base);
  for (const k of Object.keys(over)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const bv = out[k];
    const ov = over[k];
    out[k] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : deepClone(ov);
  }
  return out;
}

/** Template values deep-merged with overrides (overrides win, arrays replaced). Never mutates inputs. */
export function applyTemplate(template: ConfigTemplate, overrides?: Obj): Obj {
  return overrides ? deepMerge(template.values, overrides) : deepClone(template.values);
}

export function buildDeviceConfig(deviceId: string, desired: Obj, reported: Obj, now: Date, templateId?: string): DeviceConfig {
  const cfg: DeviceConfig = {
    deviceId,
    desired,
    reported,
    drift: diffConfig(desired, reported),
    updatedAt: now.toISOString(),
  };
  if (templateId !== undefined) cfg.templateId = templateId;
  return cfg;
}

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  return new Date().toISOString();
}
export function isoOpt(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : iso(v);
}
export function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}
/** Remove undefined keys so JSON output stays clean. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

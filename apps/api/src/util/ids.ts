import { randomUUID } from "node:crypto";

/** Prefixed, roughly time-sortable ids: `dev_lq3k1x9a_4f2c1b7d`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

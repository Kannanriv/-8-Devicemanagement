import { fromHex, toHex } from "@hash8/dcs-schema";

export { fromHex, toHex };

/** Build a minimal raw (unparsed) DCS around uplink fields. */
export function mk(fields: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dcs: "1.0",
    id: "test.dev",
    version: "1.0.0",
    device: { vendor: "Test", model: "Dev" },
    uplink: [{ name: "m", fields }],
    ...extra,
  };
}

export const hex = fromHex;
export const u = (name: string, bits: number, extra: Record<string, unknown> = {}) => ({ name, type: "uint", bits, ...extra });
export const i = (name: string, bits: number, extra: Record<string, unknown> = {}) => ({ name, type: "int", bits, ...extra });

import { DeviceCodecSpec } from "./spec";

export function parseSpec(input: unknown): DeviceCodecSpec {
  return DeviceCodecSpec.parse(input);
}

export function safeParseSpec(input: unknown) {
  return DeviceCodecSpec.safeParse(input);
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "").replace(/[\s:-]/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`invalid hex payload: "${hex}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

import { describe, it, expect } from "vitest";
import { roundTo } from "../src/round";

const ref = (v: number, d: number) => Number(v.toFixed(d));

describe("roundTo (fast Number(v.toFixed(d)))", () => {
  it("matches toFixed on scaled integer raws across decimals 0..12", () => {
    const scales = [1e-7, 0.01, 0.1, 0.5, 0.001, 1 / 3, 0.0625, 1.8];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 4000; n++) {
      const raw = Math.floor((rnd() - 0.5) * 2 ** 32);
      const v = raw * scales[n % scales.length]! + (n % 3 === 0 ? -40 : 0);
      for (const d of [0, 1, 2, 7, 10, 12]) expect(roundTo(v, d)).toBe(ref(v, d));
    }
  });
  it("handles ties like toFixed (away from zero on exact value)", () => {
    for (const v of [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 1.005, 1.045, 2.675, -2.675, 1e-11, -1e-11, 0, -0]) {
      for (const d of [0, 1, 2, 10]) expect(Object.is(roundTo(v, d), ref(v, d))).toBe(true);
    }
  });
  it("handles huge values by falling back", () => {
    for (const v of [1e21, 1e15 + 0.3, -9e15, 123456789012.345]) expect(roundTo(v, 10)).toBe(ref(v, 10));
  });
});

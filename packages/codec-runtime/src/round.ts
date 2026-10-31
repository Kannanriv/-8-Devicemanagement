const POW10 = Array.from({ length: 23 }, (_, k) => 10 ** k);

/**
 * Exactly `Number(v.toFixed(d))` (the normative rounding in dcs-semantics §4), ~80x faster.
 *
 * n = Math.round(v·10^d) is the integer toFixed would choose unless v·10^d lies within
 * floating-point error of a .5 tie; n / 10^d is then a correctly rounded division of two
 * exact doubles, i.e. the same double as parsing the decimal string. Near ties, for huge
 * magnitudes or d > 22 we fall back to toFixed itself.
 */
export function roundTo(v: number, d: number): number {
  if (v === 0) return 0; // (-0).toFixed() is "0"
  const p = POW10[d];
  if (p !== undefined) {
    const x = v * p;
    const ax = x < 0 ? -x : x;
    if (ax < 4e15) {
      const frac = ax - Math.floor(ax);
      const dist = frac > 0.5 ? frac - 0.5 : 0.5 - frac;
      if (dist > ax * 1e-15 + 1e-12) return Math.round(x) / p;
    }
  }
  return Number(v.toFixed(d));
}

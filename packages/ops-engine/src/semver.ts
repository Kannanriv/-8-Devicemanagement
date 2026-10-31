/**
 * Tiny dependency-free semver: parse/compare plus range matching for
 * exact, x-ranges (1.2.x, 1.x, *), ^, ~, comparators (>=, >, <=, <, =),
 * space-separated AND sets and `||` alternatives.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v: string): SemVer | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ? m[4].split(".") : [],
  };
}

function cmpPre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // release > prerelease
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d) return Math.sign(d);
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function cmp(a: SemVer, b: SemVer): number {
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch) || cmpPre(a.pre, b.pre);
}

/** -1 / 0 / 1. Throws on unparseable input. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`);
  return cmp(pa, pb);
}

type Test = (v: SemVer) => boolean;

const sv = (major: number, minor: number, patch: number): SemVer => ({ major, minor, patch, pre: [] });

function partial(s: string): { parts: (number | null)[] } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  const p = (x: string | undefined) => (x === undefined || /^[xX*]$/.test(x) ? null : Number(x));
  return { parts: [p(m[1]), p(m[2]), p(m[3])] };
}

function comparator(token: string): Test | null {
  if (token === "*" || token === "x" || token === "X" || token === "") return () => true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "";
  const body = m[2]!;
  if (op === "" || op === "=" || op === "^" || op === "~") {
    const p = partial(body);
    if (!p) return null;
    const [ma, mi, pa] = p.parts;
    if (ma === null || ma === undefined) return () => true;
    if (op === "^") {
      const lo = parseSemver(body.replace(/[xX*]/g, "0")) ?? sv(ma, mi ?? 0, pa ?? 0);
      const hi = ma > 0 ? sv(ma + 1, 0, 0) : (mi ?? 0) > 0 || mi === null ? sv(0, (mi ?? 0) + 1, 0) : sv(0, 0, (pa ?? 0) + 1);
      return (v) => cmp(v, lo) >= 0 && cmp(v, hi) < 0;
    }
    if (op === "~") {
      const lo = sv(ma, mi ?? 0, pa ?? 0);
      const hi = mi === null || mi === undefined ? sv(ma + 1, 0, 0) : sv(ma, mi + 1, 0);
      return (v) => cmp(v, lo) >= 0 && cmp(v, hi) < 0;
    }
    if (mi === null || mi === undefined) return (v) => v.major === ma;
    if (pa === null || pa === undefined) return (v) => v.major === ma && v.minor === mi;
    const exact = parseSemver(body);
    return exact ? (v) => cmp(v, exact) === 0 : null;
  }
  const target = parseSemver(body);
  if (!target) return null;
  switch (op) {
    case ">=": return (v) => cmp(v, target) >= 0;
    case "<=": return (v) => cmp(v, target) <= 0;
    case ">": return (v) => cmp(v, target) > 0;
    case "<": return (v) => cmp(v, target) < 0;
  }
  return null;
}

/** True if `version` satisfies `range`. Invalid version or range → false. */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  return range.split("||").some((alt) => {
    const tokens = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const tests = tokens.map(comparator);
    return tests.every((t) => t !== null && t(v));
  });
}

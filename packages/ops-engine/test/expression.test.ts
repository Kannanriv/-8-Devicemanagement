import { describe, it, expect } from "vitest";
import { compileExpression, OpsError } from "../src/index";

const ev = (src: string, scope: Record<string, unknown> = {}) => compileExpression(src)(scope);

describe("compileExpression: literals and arithmetic", () => {
  it.each([
    ["42", 42],
    ["3.5e2", 350],
    ["'hi'", "hi"],
    ['"a\\"b"', 'a"b'],
    ["true", true],
    ["false", false],
    ["null", null],
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 % 4", 2],
    ["7 / 2", 3.5],
    ["-3 + 1", -2],
    ["2 - -2", 4],
    ["'a' + 'b'", "ab"],
    ["[1, 2, 3]", [1, 2, 3]],
  ])("%s → %j", (src, out) => {
    expect(ev(src)).toEqual(out);
  });
});

describe("compileExpression: comparison and logic", () => {
  it.each([
    ["1 < 2", true],
    ["2 <= 2", true],
    ["3 > 4", false],
    ["4 >= 4", true],
    ["1 == 1", true],
    ["1 != 2", true],
    ["1 === 1", true],
    ["1 !== 1", false],
    ["true && false", false],
    ["false || 'x'", "x"],
    ["!true", false],
    ["!!1", true],
    ["1 < 2 && 2 < 3 || false", true],
    ["2 in [1, 2, 3]", true],
    ["'x' in ['a', 'b']", false],
  ])("%s → %j", (src, out) => {
    expect(ev(src)).toEqual(out);
  });
  it("== is strict except null/undefined equivalence", () => {
    expect(ev("1 == '1'")).toBe(false);
    expect(ev("missing == null")).toBe(true);
    expect(ev("missing === null")).toBe(false);
  });
  it("short-circuits && and ||", () => {
    expect(() => ev("abs('x')")).toThrow(/abs/);
    expect(ev("false && abs('x')")).toBe(false);
    expect(ev("true || abs('x')")).toBe(true);
  });
  it("runtime errors are OpsError EXPRESSION_RUNTIME", () => {
    try {
      ev("round('a')");
      expect.unreachable();
    } catch (e) {
      expect((e as OpsError).code).toBe("EXPRESSION_RUNTIME");
    }
  });
});

describe("compileExpression: member access and scope", () => {
  const scope = { data: { temperature: 31.5, tags: ["a"], "odd key": 7 }, device: { health: { battery: 12 } } };
  it("reads nested members", () => {
    expect(ev("data.temperature > 30", scope)).toBe(true);
    expect(ev("device.health.battery", scope)).toBe(12);
    expect(ev('data["odd key"]', scope)).toBe(7);
    expect(ev("data.tags[0]", scope)).toBe("a");
  });
  it("missing paths are undefined, not errors", () => {
    expect(ev("data.nope.deeper", scope)).toBeUndefined();
    expect(ev("data.nope > 3", scope)).toBe(false);
    expect(ev("ghost", scope)).toBeUndefined();
  });
  it("blocks prototype access", () => {
    expect(() => ev("data.constructor", scope)).toThrow(OpsError);
    expect(() => ev('data["__proto__"]', scope)).toThrow(OpsError);
    expect(ev("data.toString", scope)).toBeUndefined();
  });
  it("in works on value arrays and strings", () => {
    expect(ev("'a' in data.tags", scope)).toBe(true);
    expect(ev("'ell' in 'hello'")).toBe(true);
    expect(ev("1 in data.temperature", scope)).toBe(false);
  });
  it("compiled function is reusable across scopes", () => {
    const f = compileExpression("data.v * 2");
    expect(f({ data: { v: 2 } })).toBe(4);
    expect(f({ data: { v: 5 } })).toBe(10);
  });
});

describe("compileExpression: functions", () => {
  it.each([
    ["abs(-4)", 4],
    ["min(3, 1, 2)", 1],
    ["max(3, 1, 2)", 3],
    ["round(2.5)", 3],
    ["round(3.14159, 2)", 3.14],
    ["len('abc')", 3],
    ["len([1, 2])", 2],
    ["contains('hello', 'ell')", true],
    ["contains([1, 2], 3)", false],
    ["startsWith('SN-001', 'SN-')", true],
  ])("%s → %j", (src, out) => {
    expect(ev(src)).toEqual(out);
  });
  it("rejects unknown functions at compile time", () => {
    expect(() => compileExpression("eval('1')")).toThrow(/Unknown function 'eval'/);
  });
  it("rejects calling non-identifiers", () => {
    expect(() => compileExpression("data.fn(1)")).toThrow(OpsError);
  });
});

describe("compileExpression: errors and safety", () => {
  it("reports syntax errors with position", () => {
    try {
      compileExpression("1 + * 2");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OpsError);
      expect((e as OpsError).code).toBe("EXPRESSION_SYNTAX");
      expect((e as Error).message).toMatch(/position 4/);
    }
  });
  it.each(["(1 + 2", "'unterminated", "1 2", "a.", "@", "", "a = 1", "[1, 2"])("rejects %j", (src) => {
    expect(() => compileExpression(src)).toThrow(OpsError);
  });
  it("cannot reach globals or execute code", () => {
    expect(ev("process", {})).toBeUndefined();
    expect(ev("globalThis", {})).toBeUndefined();
    expect(() => compileExpression("constructor.constructor('return 1')()")).toThrow(OpsError);
  });
  it("limits source length and nesting depth", () => {
    expect(() => compileExpression("1+".repeat(5000) + "1")).toThrow(OpsError);
    expect(() => compileExpression("(".repeat(200) + "1" + ")".repeat(200))).toThrow(OpsError);
  });
});

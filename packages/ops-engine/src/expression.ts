/**
 * Safe expression language for automation conditions. Hand-written tokenizer +
 * precedence-climbing parser + tree-walking evaluator. Never uses eval/Function.
 *
 * Grammar (lowest → highest precedence):
 *   or      := and ("||" and)*
 *   and     := eq ("&&" eq)*
 *   eq      := rel (("=="|"!="|"==="|"!==") rel)*
 *   rel     := add (("<"|"<="|">"|">="|"in") add)*
 *   add     := mul (("+"|"-") mul)*
 *   mul     := unary (("*"|"/"|"%") unary)*
 *   unary   := ("!"|"-"|"+") unary | postfix
 *   postfix := primary ("." ident | "[" expr "]")*
 *   primary := number | string | true | false | null | ident | ident "(" args ")" | "(" expr ")" | "[" args "]"
 *
 * Identifiers and members resolve to own properties only; missing → undefined.
 * `==` is strict equality except that null and undefined are equal.
 */
import { OpsError } from "./errors";

export type Scope = Record<string, unknown>;
export type CompiledExpression = (scope: Scope) => unknown;

export const EXPRESSION_LIMITS = { maxLength: 4096, maxDepth: 64 } as const;

const BLOCKED = new Set(["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

type TokType = "num" | "str" | "ident" | "op" | "eof";
interface Token {
  type: TokType;
  value: string;
  num?: number;
  pos: number;
}

const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]", ".", ","];

function syntaxError(msg: string, pos: number): OpsError {
  return new OpsError("EXPRESSION_SYNTAX", `${msg} at position ${pos}`, { position: pos });
}
function runtimeError(msg: string): OpsError {
  return new OpsError("EXPRESSION_RUNTIME", msg);
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (/[A-Za-z_$]/.test(src[i] ?? "")) throw syntaxError(`Invalid number '${src.slice(start, i + 1)}'`, start);
      out.push({ type: "num", value: m[0], num: Number(m[0]), pos: start });
      continue;
    }
    if (c === "'" || c === '"') {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw syntaxError("Unterminated string", start);
        const ch = src[i]!;
        if (ch === c) {
          i++;
          break;
        }
        if (ch === "\\") {
          const n = src[i + 1];
          if (n === undefined) throw syntaxError("Unterminated string", start);
          s += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          i += 2;
          continue;
        }
        s += ch;
        i++;
      }
      out.push({ type: "str", value: s, pos: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      i += m[0].length;
      out.push({ type: "ident", value: m[0], pos: start });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw syntaxError(`Unexpected character '${c}'`, i);
    i += op.length;
    out.push({ type: "op", value: op, pos: start });
  }
  out.push({ type: "eof", value: "", pos: src.length });
  return out;
}

type Node =
  | { k: "lit"; v: unknown }
  | { k: "id"; name: string }
  | { k: "mem"; obj: Node; prop: Node }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "arr"; items: Node[] }
  | { k: "un"; op: string; arg: Node }
  | { k: "bin"; op: string; l: Node; r: Node };

type Fn = (...args: unknown[]) => unknown;
const num = (name: string, v: unknown): number => {
  if (typeof v !== "number") throw runtimeError(`${name}() expects a number, got ${v === null ? "null" : typeof v}`);
  return v;
};
const str = (name: string, v: unknown): string => {
  if (typeof v !== "string") throw runtimeError(`${name}() expects a string, got ${v === null ? "null" : typeof v}`);
  return v;
};

export const EXPRESSION_FUNCTIONS: Record<string, Fn> = {
  abs: (x) => Math.abs(num("abs", x)),
  min: (...xs) => Math.min(...xs.map((x) => num("min", x))),
  max: (...xs) => Math.max(...xs.map((x) => num("max", x))),
  round: (x, digits) => {
    const f = 10 ** (digits === undefined ? 0 : num("round", digits));
    return Math.round(num("round", x) * f) / f;
  },
  len: (x) => {
    if (typeof x === "string" || Array.isArray(x)) return x.length;
    if (x && typeof x === "object") return Object.keys(x).length;
    if (x === null || x === undefined) return 0;
    throw runtimeError(`len() expects a string, array or object, got ${typeof x}`);
  },
  contains: (h, n) => {
    if (typeof h === "string") return h.includes(String(n));
    if (Array.isArray(h)) return h.some((x) => looseEq(x, n));
    return false;
  },
  startsWith: (s, p) => str("startsWith", s).startsWith(str("startsWith", p)),
};

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  return a === b;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly t: Token[]) {}

  private peek(): Token {
    return this.t[this.i]!;
  }
  private next(): Token {
    return this.t[this.i++]!;
  }
  private isOp(v: string): boolean {
    const p = this.peek();
    return p.type === "op" && p.value === v;
  }
  private expect(v: string): void {
    const p = this.peek();
    if (!this.isOp(v)) throw syntaxError(p.type === "eof" ? `Expected '${v}' but reached end of input` : `Expected '${v}' but found '${p.value}'`, p.pos);
    this.i++;
  }
  private unexpected(p: Token): never {
    throw syntaxError(p.type === "eof" ? "Unexpected end of input" : `Unexpected token '${p.value}'`, p.pos);
  }

  parse(): Node {
    const n = this.expr();
    const p = this.peek();
    if (p.type !== "eof") this.unexpected(p);
    return n;
  }

  private expr(): Node {
    if (++this.depth > EXPRESSION_LIMITS.maxDepth) throw syntaxError("Expression nested too deeply", this.peek().pos);
    const n = this.binary(0);
    this.depth--;
    return n;
  }

  private static LEVELS: string[][] = [["||"], ["&&"], ["==", "!=", "===", "!=="], ["<", "<=", ">", ">=", "in"], ["+", "-"], ["*", "/", "%"]];

  private binary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary();
    let l = this.binary(level + 1);
    const ops = Parser.LEVELS[level]!;
    for (;;) {
      const p = this.peek();
      const isMatch = (p.type === "op" && ops.includes(p.value)) || (p.type === "ident" && p.value === "in" && ops.includes("in"));
      if (!isMatch) return l;
      this.i++;
      const r = this.binary(level + 1);
      l = { k: "bin", op: p.value, l, r };
    }
  }

  private unary(): Node {
    const p = this.peek();
    if (p.type === "op" && (p.value === "!" || p.value === "-" || p.value === "+")) {
      this.i++;
      if (++this.depth > EXPRESSION_LIMITS.maxDepth) throw syntaxError("Expression nested too deeply", p.pos);
      const arg = this.unary();
      this.depth--;
      return { k: "un", op: p.value, arg };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.i++;
        const p = this.next();
        if (p.type !== "ident") this.unexpected(p);
        if (BLOCKED.has(p.value)) throw syntaxError(`Access to '${p.value}' is not allowed`, p.pos);
        n = { k: "mem", obj: n, prop: { k: "lit", v: p.value } };
      } else if (this.isOp("[")) {
        this.i++;
        const prop = this.expr();
        this.expect("]");
        n = { k: "mem", obj: n, prop };
      } else if (this.isOp("(")) {
        throw syntaxError("Only whitelisted functions can be called", this.peek().pos);
      } else return n;
    }
  }

  private args(close: string): Node[] {
    const items: Node[] = [];
    if (this.isOp(close)) {
      this.i++;
      return items;
    }
    for (;;) {
      items.push(this.expr());
      if (this.isOp(",")) {
        this.i++;
        continue;
      }
      this.expect(close);
      return items;
    }
  }

  private primary(): Node {
    const p = this.next();
    switch (p.type) {
      case "num":
        return { k: "lit", v: p.num };
      case "str":
        return { k: "lit", v: p.value };
      case "ident": {
        if (p.value === "true") return { k: "lit", v: true };
        if (p.value === "false") return { k: "lit", v: false };
        if (p.value === "null") return { k: "lit", v: null };
        if (p.value === "undefined") return { k: "lit", v: undefined };
        if (this.isOp("(")) {
          if (!Object.hasOwn(EXPRESSION_FUNCTIONS, p.value)) {
            throw syntaxError(`Unknown function '${p.value}' (allowed: ${Object.keys(EXPRESSION_FUNCTIONS).join(", ")})`, p.pos);
          }
          this.i++;
          return { k: "call", fn: p.value, args: this.args(")") };
        }
        if (p.value === "in") this.unexpected(p);
        if (BLOCKED.has(p.value)) throw syntaxError(`Access to '${p.value}' is not allowed`, p.pos);
        return { k: "id", name: p.value };
      }
      case "op":
        if (p.value === "(") {
          const n = this.expr();
          this.expect(")");
          return n;
        }
        if (p.value === "[") return { k: "arr", items: this.args("]") };
        return this.unexpected(p);
      default:
        return this.unexpected(p);
    }
  }
}

function getMember(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof key !== "string" && typeof key !== "number") return undefined;
  const k = String(key);
  if (BLOCKED.has(k)) throw runtimeError(`Access to '${k}' is not allowed`);
  if (typeof obj === "string") return k === "length" ? obj.length : /^\d+$/.test(k) ? obj[Number(k)] : undefined;
  if (typeof obj !== "object") return undefined;
  if (Array.isArray(obj) && k === "length") return obj.length;
  return Object.hasOwn(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
}

const truthy = (v: unknown) => Boolean(v);

function evaluate(n: Node, scope: Scope): unknown {
  switch (n.k) {
    case "lit":
      return n.v;
    case "id":
      return Object.hasOwn(scope, n.name) ? scope[n.name] : undefined;
    case "mem":
      return getMember(evaluate(n.obj, scope), evaluate(n.prop, scope));
    case "arr":
      return n.items.map((x) => evaluate(x, scope));
    case "call":
      return EXPRESSION_FUNCTIONS[n.fn]!(...n.args.map((a) => evaluate(a, scope)));
    case "un": {
      const v = evaluate(n.arg, scope);
      if (n.op === "!") return !truthy(v);
      return n.op === "-" ? -(v as number) : +(v as number);
    }
    case "bin": {
      if (n.op === "&&") {
        const l = evaluate(n.l, scope);
        return truthy(l) ? evaluate(n.r, scope) : l;
      }
      if (n.op === "||") {
        const l = evaluate(n.l, scope);
        return truthy(l) ? l : evaluate(n.r, scope);
      }
      const l = evaluate(n.l, scope);
      const r = evaluate(n.r, scope);
      switch (n.op) {
        case "==": return looseEq(l, r);
        case "!=": return !looseEq(l, r);
        case "===": return l === r;
        case "!==": return l !== r;
        case "in":
          if (Array.isArray(r)) return r.some((x) => looseEq(x, l));
          if (typeof r === "string") return typeof l === "string" && r.includes(l);
          return false;
        case "+":
          if (typeof l === "string" || typeof r === "string") return String(l ?? "") + String(r ?? "");
          return (l as number) + (r as number);
      }
      // numeric / ordering ops: only compare like-typed numbers or strings
      const comparable = (typeof l === "number" && typeof r === "number") || (typeof l === "string" && typeof r === "string");
      switch (n.op) {
        case "<": return comparable && (l as number) < (r as number);
        case "<=": return comparable && (l as number) <= (r as number);
        case ">": return comparable && (l as number) > (r as number);
        case ">=": return comparable && (l as number) >= (r as number);
        case "-": return (l as number) - (r as number);
        case "*": return (l as number) * (r as number);
        case "/": return (l as number) / (r as number);
        case "%": return (l as number) % (r as number);
      }
      throw runtimeError(`Unknown operator ${n.op}`);
    }
  }
}

/** Compile once, evaluate many times. Throws OpsError("EXPRESSION_SYNTAX") with position on bad input. */
export function compileExpression(src: string): CompiledExpression {
  if (src.length > EXPRESSION_LIMITS.maxLength) {
    throw syntaxError(`Expression longer than ${EXPRESSION_LIMITS.maxLength} characters`, EXPRESSION_LIMITS.maxLength);
  }
  const ast = new Parser(tokenize(src)).parse();
  return (scope: Scope) => evaluate(ast, scope ?? {});
}

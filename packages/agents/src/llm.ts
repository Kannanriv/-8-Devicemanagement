import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { ZodType, ZodTypeDef } from "zod";

/** Default and fast model ids (overridable via env). */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const FAST_MODEL = "claude-haiku-5-5";

export type LlmMessage = Anthropic.Beta.BetaMessageParam;

export interface LlmTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  /** "fast" routes to the cheaper model (summaries, naming); "default" to the main model. */
  tier?: "default" | "fast";
  effort?: "low" | "medium" | "high" | "xhigh";
}

export interface LlmToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmResponse {
  text: string;
  toolUses: LlmToolUse[];
  stopReason: string | null;
  /** Assistant content blocks to append verbatim to the conversation for the next turn. */
  content: Anthropic.Beta.BetaContentBlockParam[];
  model: string;
}

/** Minimal LLM surface the agents depend on — implemented by Claude, faked in tests. */
export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmRefusalError extends Error {}

/** Claude-backed LlmClient. Returns undefined when no API key is available (agents then use deterministic fallbacks). */
export function createAnthropicLlm(apiKey?: string): LlmClient | undefined {
  const key = apiKey ?? (typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined);
  if (!key) return undefined;
  const client = new Anthropic({ apiKey: key });
  const model = process.env.HASH8_AGENT_MODEL || DEFAULT_MODEL;
  const fastModel = process.env.HASH8_AGENT_FAST_MODEL || FAST_MODEL;
  return {
    model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const m = req.tier === "fast" ? fastModel : model;
      const body: BetaMessageStreamParams = {
        model: m,
        max_tokens: req.maxTokens ?? 32000,
        messages: req.messages,
        output_config: { effort: req.effort ?? (req.tier === "fast" ? "low" : "high") },
        ...(req.system ? { system: req.system } : {}),
        ...(req.tools?.length ? { tools: req.tools as Anthropic.Beta.BetaTool[] } : {}),
        // Server-side refusal fallback for the Opus/Fable line (not available on Haiku).
        ...(/^claude-(opus-5|fable-5)/.test(m) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      };
      // Streaming + finalMessage avoids HTTP timeouts on long DCS outputs.
      const res = await client.beta.messages.stream(body).finalMessage();
      if (res.stop_reason === "refusal") throw new LlmRefusalError(`model declined the request (${res.stop_details?.category ?? "unspecified"})`);
      let text = "";
      const toolUses: LlmToolUse[] = [];
      for (const b of res.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") toolUses.push({ id: b.id, name: b.name, input: b.input });
      }
      return { text, toolUses, stopReason: res.stop_reason, content: res.content as Anthropic.Beta.BetaContentBlockParam[], model: res.model };
    },
  };
}

/** Pull the first JSON object/array out of a model reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]! : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found in reply");
  const open = body[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in reply");
}

export interface JsonResult<T> {
  value?: T;
  attempts: number;
  errors: string[];
}

/**
 * Ask for JSON, validate with zod, and feed validation errors back for up to `retries` more attempts.
 * The conversation is append-only (assistant reply + corrective user turn).
 */
export async function completeJson<T>(
  llm: LlmClient,
  req: LlmRequest,
  schema: ZodType<T, ZodTypeDef, unknown>,
  retries = 2,
  check?: (v: T) => string[],
): Promise<JsonResult<T>> {
  const messages: LlmMessage[] = [...req.messages];
  const errors: string[] = [];
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let res: LlmResponse;
    try {
      res = await llm.complete({ ...req, messages });
    } catch (e) {
      errors.push(`attempt ${attempt}: ${(e as Error).message}`);
      return { attempts: attempt, errors };
    }
    let problems: string[];
    try {
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) {
        problems = check ? check(parsed.data) : [];
        if (!problems.length) return { value: parsed.data, attempts: attempt, errors };
      } else {
        problems = parsed.error.issues.slice(0, 25).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      }
    } catch (e) {
      problems = [(e as Error).message];
    }
    errors.push(`attempt ${attempt}: ${problems.join("; ")}`);
    messages.push({ role: "assistant", content: res.content.length ? res.content : [{ type: "text", text: res.text || "(empty)" }] });
    messages.push({
      role: "user",
      content: `Your JSON failed validation:\n- ${problems.join("\n- ")}\nReturn the corrected, complete JSON only.`,
    });
  }
  return { attempts: retries + 1, errors };
}

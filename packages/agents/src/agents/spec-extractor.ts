import { DeviceCodecSpec, type DeviceCodecSpecInput, type Field, type SourceRef, safeParseSpec } from "@hash8/dcs-schema";
import { extractFromGrids, gridsToText, loadGrids, type ExtractedSpec, type SheetGrid } from "@hash8/spec-ingest";
import { completeJson } from "../llm";
import type { AgentDef } from "../types";

const SYSTEM = `You are the spec-extractor for #8 Device Management. You convert OEM device message specifications (Excel sheets rendered as cell-addressed text) into a Device Codec Spec (DCS v1) JSON document.

DCS v1 essentials:
- Top level: {"dcs":"1.0","id":"<vendor>.<model> lowercase [a-z0-9.-]","version":"x.y.z[-draft]","device":{vendor,model,protocols?,category?},"defaults":{"endian":"big"|"little"},"uplink":[MessageDef...],"downlink"?:[...],"vectors":[...],"meta"?}
- MessageDef: {"name": identifier, "description"?, "when"?: {"port"?: int|int[], "topic"?: string}, "fields": Field[], "source"?}
- Field kinds: scalar {"name","type":"uint"|"int"|"float"|"bool"|"bytes"|"string"|"bcd","bits"? (uint/int/bool width, 1..64, float 32/64),"length"? (bytes for bytes/string/bcd or "remaining"),"endian"?,"scale"?,"offset"?,"unit"? (UCUM: Cel, %, V, mV, kW.h, deg, km/h, dBm ...),"min"?,"max"?,"enum"? {"<decimal raw>":"label"},"hidden"?,"description"?,"source"?};
  const {"kind":"const","name","bits","value"} for fixed markers such as message IDs; checksum {"kind":"checksum","name","algo":"crc8"|"crc16-ccitt"|"crc16-modbus"|"crc32"|"xor8"|"sum8"}; group/repeat/switch for nested layouts.
- Fields are read sequentially by a bit cursor, MSB-first. Every byte of the payload must be covered; undocumented gaps are hidden uint fields named reserved<N>.
- Physical value = raw * scale + offset. Enum keys are decimal strings of the raw value.
- Vectors: {"name","direction":"uplink"|"downlink","port"?,"topic"?,"hex","message","data"} — only when the document gives BOTH the payload hex and the expected decoded values.
- Every field you output must carry "source": {"sheet","cell","row"?,"text"?,"confidence"} pointing at the cell that defines it. Keep existing source refs.

You receive a heuristic draft produced by a deterministic parser and its list of issues. Correct it against the document: wrong types/signedness, scales, units, enums, message split, ports/topics, message-id consts, bit fields, checksums, endianness. Keep field and message names unless they are clearly wrong. Do not invent fields the document does not describe. Reply with the complete corrected DCS JSON only.`;

export const specExtractor: AgentDef = {
  name: "spec-extractor",
  title: "Spec Extractor",
  description:
    "Turns an OEM Excel/text message spec into a draft Device Codec Spec with every field traced to its source cell: deterministic heuristics first, then Claude refinement validated against the DCS schema.",
  async run(input, ctx) {
    const fileName = typeof input.fileName === "string" ? input.fileName : undefined;
    const opts = {
      ...(fileName ? { fileName } : {}),
      ...(typeof input.vendor === "string" ? { vendor: input.vendor } : {}),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
    };
    let grids: SheetGrid[];
    if (typeof input.xlsxBase64 === "string" && input.xlsxBase64) {
      grids = await loadGrids(new Uint8Array(Buffer.from(input.xlsxBase64, "base64")));
      ctx.step(`loaded workbook${fileName ? ` ${fileName}` : ""}: ${grids.length} sheet(s)`);
    } else if (typeof input.text === "string" && input.text.trim()) {
      grids = textToGrids(input.text);
      ctx.step(`parsed pasted text: ${grids[0]!.rows.length} line(s)`);
    } else throw new Error("spec-extractor needs input.xlsxBase64 (base64 .xlsx) or input.text");

    const h = extractFromGrids(grids, opts);
    const fieldCount = h.draft.uplink.concat(h.draft.downlink ?? []).reduce((n, m) => n + m.fields.length, 0);
    ctx.step(`heuristics: ${h.draft.uplink.length + (h.draft.downlink?.length ?? 0)} message(s), ${fieldCount} field(s), confidence ${h.confidence}, ${h.issues.length} issue(s)`);

    let draft: DeviceCodecSpecInput = h.draft;
    let trace = h.trace;
    const issues = [...h.issues];
    let refinedBy = "heuristics";
    let attempts = 0;

    if (ctx.llm) {
      ctx.step(`refining with ${ctx.llm.model}`);
      const docText = gridsToText(grids);
      const r = await completeJson(
        ctx.llm,
        {
          system: SYSTEM,
          maxTokens: 32000,
          effort: "high",
          messages: [
            {
              role: "user",
              content:
                `<document file="${fileName ?? "spec"}">\n${docText}\n</document>\n\n` +
                `<draft>\n${JSON.stringify(h.draft)}\n</draft>\n\n<issues>\n${h.issues.map((i) => `- ${i}`).join("\n") || "(none)"}\n</issues>\n\n` +
                "Return the corrected DCS JSON.",
            },
          ],
        },
        DeviceCodecSpec,
        2,
      );
      attempts = r.attempts;
      if (r.value) {
        const merged = mergeRefinement(r.value as DeviceCodecSpecInput, h);
        draft = merged.draft;
        trace = merged.trace;
        issues.push(...merged.notes);
        refinedBy = ctx.llm.model;
        ctx.step(`refinement accepted after ${r.attempts} attempt(s)`);
      } else {
        issues.push(`Claude refinement failed after ${r.attempts} attempt(s) — using heuristic draft (${r.errors.at(-1) ?? "no detail"})`);
        ctx.step(`refinement failed; keeping heuristic draft`);
      }
    }

    const v = safeParseSpec(draft);
    if (!v.success) issues.push(...v.error.issues.map((i) => `schema: ${i.path.join(".")}: ${i.message}`));
    ctx.step(v.success ? "draft validates against the DCS schema" : "draft does NOT validate against the DCS schema");
    return {
      output: {
        draft,
        trace,
        issues,
        confidence: h.confidence,
        sheets: h.sheets,
        examples: h.examples,
        refinedBy,
        attempts,
        valid: v.success,
      },
    };
  },
};

/** Keep heuristic source refs (and vectors) when Claude's refinement omits them. */
function mergeRefinement(refined: DeviceCodecSpecInput, h: ExtractedSpec): { draft: DeviceCodecSpecInput; trace: Record<string, SourceRef>; notes: string[] } {
  const trace: Record<string, SourceRef> = {};
  const notes: string[] = [];
  const byFieldName = new Map<string, SourceRef>();
  for (const [k, ref] of Object.entries(h.trace)) byFieldName.set(k.split(".").pop()!, ref);
  const walk = (msg: string, fields: unknown[], prefix: string) => {
    for (const raw of fields) {
      const f = raw as Field & { source?: SourceRef };
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const key = `${msg}.${path}`;
      const ref = f.source ?? h.trace[key] ?? byFieldName.get(f.name);
      if (ref) {
        if (!f.source) f.source = ref;
        trace[key] = ref;
      } else notes.push(`${key}: no source reference after refinement — please review`);
      if (f.kind === "group" || f.kind === "repeat") walk(msg, f.fields, path);
      if (f.kind === "switch") {
        for (const c of Object.values(f.cases)) walk(msg, c, prefix);
        if (f.default) walk(msg, f.default, prefix);
      }
    }
  };
  for (const m of [...refined.uplink, ...(refined.downlink ?? [])]) walk(m.name, m.fields, "");
  const draft = { ...refined };
  if ((!draft.vectors || draft.vectors.length === 0) && (h.draft.vectors ?? []).length) {
    const msgs = new Set([...draft.uplink, ...(draft.downlink ?? [])].map((m) => m.name));
    draft.vectors = (h.draft.vectors ?? []).filter((v) => !v.message || msgs.has(v.message));
  }
  draft.meta = { ...(h.draft.meta ?? {}), ...(refined.meta ?? {}), createdBy: "spec-extractor" };
  return { draft, trace, notes };
}

/** Pasted text (TSV, markdown tables, pipe/CSV) to a one-sheet grid. */
export function textToGrids(text: string): SheetGrid[] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (/^\|?\s*:?-{3,}/.test(l)) continue; // markdown separator
    let cells: string[];
    if (l.includes("\t")) cells = l.split("\t");
    else if (l.includes("|")) cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|");
    else if ((l.match(/[,;]/g) ?? []).length >= 2 && !/[.!?]$/.test(l)) cells = l.split(/[,;]/);
    else cells = [l];
    rows.push(cells.map((c) => c.trim()));
  }
  return [{ name: "Text", rows, strike: rows.map(() => false), fill: rows.map(() => undefined), merges: [] }];
}

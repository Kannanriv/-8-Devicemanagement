import { createCodec } from "@hash8/codec-runtime";
import { fromHex, MessageDef, toHex, type DeviceCodecSpec, type DeviceCodecSpecInput } from "@hash8/dcs-schema";
import type { DeviceMessage } from "@hash8/sdk-ts";
import { completeJson } from "../llm";
import type { AgentContext, AgentDef } from "../types";

interface Cluster {
  key: string;
  count: number;
  port?: number;
  topic?: string;
  length: number;
  leadingBytes: string;
  devices: string[];
  firstSeen: string;
  lastSeen: string;
  /** Per byte: "C" constant, "v" low variance, "V" varying. */
  byteProfile: string;
  samples: string[];
  msgs: DeviceMessage[];
}

export const payloadTriage: AgentDef = {
  name: "payload-triage",
  title: "Payload Triage",
  description:
    "Clusters payloads no codec could decode by port/topic, length and leading bytes, infers a candidate message layout, and proposes a DCS patch (new uplink message) with evidence that it decodes every sample.",
  async run(input, ctx) {
    const limit = typeof input.limit === "number" ? input.limit : 500;
    const minCount = typeof input.minCount === "number" ? input.minCount : 2;
    const msgs = await ctx.tools.listUnknownPayloads(limit);
    ctx.step(`fetched ${msgs.length} unknown payload(s)`);
    const clusters = cluster(msgs);
    ctx.step(`formed ${clusters.length} cluster(s): ${clusters.map((c) => `${c.key}×${c.count}`).join(", ") || "none"}`);

    const codecCache = new Map<string, DeviceCodecSpec | undefined>();
    const patches: Record<string, unknown>[] = [];
    let llmBudget = 3;
    for (const c of clusters) {
      if (c.count < minCount) continue;
      const codecId = await codecFor(c, ctx);
      if (codecId && !codecCache.has(codecId)) codecCache.set(codecId, await ctx.tools.getCodec(codecId));
      const codec = codecId ? codecCache.get(codecId) : undefined;
      const existing = new Set([...(codec?.uplink ?? []), ...(codec?.downlink ?? [])].map((m) => m.name));

      let message = heuristicMessage(c, existing);
      let proposedBy = "heuristics";
      if (ctx.llm && llmBudget-- > 0) {
        const proposal = await llmMessage(c, codec, ctx);
        if (proposal) {
          message = proposal;
          proposedBy = ctx.llm.model;
        }
      }
      const decodesAll = decodesSamples(message, c);
      const evidence = {
        count: c.count,
        samples: c.samples.slice(0, 5),
        devices: c.devices,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        byteProfile: c.byteProfile,
        decodesAll,
      };
      let patchedSpec: DeviceCodecSpecInput | undefined;
      if (codec) patchedSpec = { ...codec, version: bumpMinor(codec.version), uplink: [...codec.uplink, message as DeviceCodecSpecInput["uplink"][number]] };
      patches.push({ codecId: codecId ?? null, op: "add-uplink-message", message, proposedBy, evidence, ...(patchedSpec ? { patchedSpec } : {}) });
      ctx.step(`cluster ${c.key}: proposed "${message.name}" (${proposedBy}); decodes ${decodesAll ? "all" : "NOT all"} samples${codecId ? ` → patch for ${codecId}` : ""}`);
    }
    return { output: { clusters: clusters.map(({ msgs: _m, ...rest }) => rest), patches } };
  },
};

function cluster(msgs: DeviceMessage[]): Cluster[] {
  const map = new Map<string, DeviceMessage[]>();
  for (const m of msgs) {
    let bytes: Uint8Array;
    try {
      bytes = fromHex(m.payloadHex);
    } catch {
      continue;
    }
    const chan = m.port !== undefined ? `p${m.port}` : m.topic ? `t:${m.topic}` : "any";
    const key = `${chan}/${bytes.length}B/${bytes.length ? bytes[0]!.toString(16).padStart(2, "0") : "--"}`;
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  const out: Cluster[] = [];
  for (const [key, ms] of map) {
    const rows = ms.map((m) => fromHex(m.payloadHex));
    const len = rows[0]!.length;
    const profile: string[] = [];
    for (let i = 0; i < len; i++) {
      const vals = rows.map((r) => r[i]!);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      profile.push(min === max ? "C" : max - min <= 2 ? "v" : "V");
    }
    let prefix = 0;
    while (prefix < len && profile[prefix] === "C") prefix++;
    const times = ms.map((m) => m.receivedAt).sort();
    out.push({
      key,
      count: ms.length,
      ...(ms[0]!.port !== undefined ? { port: ms[0]!.port } : {}),
      ...(ms[0]!.topic ? { topic: ms[0]!.topic } : {}),
      length: len,
      leadingBytes: toHex(rows[0]!.slice(0, prefix)),
      devices: [...new Set(ms.map((m) => m.deviceId))].sort(),
      firstSeen: times[0]!,
      lastSeen: times[times.length - 1]!,
      byteProfile: profile.join(""),
      samples: [...new Set(ms.map((m) => m.payloadHex.toLowerCase()))],
      msgs: ms,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

async function codecFor(c: Cluster, ctx: AgentContext): Promise<string | undefined> {
  for (const id of c.devices.slice(0, 5)) {
    const d = await ctx.tools.getDevice(id);
    if (d?.codecId) return d.codecId;
  }
  return undefined;
}

function heuristicMessage(c: Cluster, existing: Set<string>): MessageDef {
  const fields: MessageDef["fields"] = [];
  const rows = c.samples.map((h) => fromHex(h));
  let i = 0;
  if (c.length > 0 && c.byteProfile[0] === "C") {
    fields.push({ kind: "const", name: "messageType", type: "uint", bits: 8, value: rows[0]![0]!, description: "Constant leading byte observed in every sample" });
    i = 1;
  }
  while (i < c.length) {
    const p = c.byteProfile[i];
    const next = c.byteProfile[i + 1];
    if (i + 1 < c.length && (p === "v" || p === "C") && next === "V") {
      fields.push({ kind: "scalar", name: `u16_at${i}`, type: "uint", bits: 16, description: `Bytes ${i}-${i + 1} (high byte stable, low byte varying)` });
      i += 2;
    } else {
      fields.push({ kind: "scalar", name: `${p === "C" ? "const" : "u8"}_at${i}`, type: "uint", bits: 8, description: `Byte ${i} (${p === "C" ? "constant" : "varying"} in samples)` });
      i += 1;
    }
  }
  let name = `unknown_${c.port !== undefined ? `p${c.port}` : "x"}_${c.length}b${c.leadingBytes ? `_${c.leadingBytes.slice(0, 2)}` : ""}`;
  while (existing.has(name)) name += "_new";
  const when: MessageDef["when"] = {};
  if (c.port !== undefined) when.port = c.port;
  if (c.topic) when.topic = c.topic;
  return { name, description: `Candidate message inferred from ${c.count} unknown payload(s)`, ...(Object.keys(when).length ? { when } : {}), fields };
}

function decodesSamples(message: MessageDef, c: Cluster): boolean {
  try {
    const codec = createCodec({ dcs: "1.0", id: "triage.candidate", version: "0.0.0", device: { vendor: "triage", model: "candidate" }, uplink: [message] });
    return c.samples.every((h) => codec.decode(fromHex(h), { ...(c.port !== undefined ? { port: c.port } : {}), ...(c.topic ? { topic: c.topic } : {}) }).ok);
  } catch {
    return false;
  }
}

async function llmMessage(c: Cluster, codec: DeviceCodecSpec | undefined, ctx: AgentContext): Promise<MessageDef | undefined> {
  const r = await completeJson(
    ctx.llm!,
    {
      maxTokens: 8000,
      effort: "medium",
      system:
        "You reverse-engineer IoT binary payloads into a DCS v1 MessageDef JSON: {name, description, when:{port?|topic?}, fields:[...]} where fields are " +
        'scalar {"name","type":"uint|int|float|bool|bytes|string|bcd","bits"|"length","scale"?,"unit"?} or const {"kind":"const","name","bits","value"}. ' +
        "Fields are read MSB-first, sequentially; cover every byte exactly. Prefer plausible engineering quantities consistent with the device's existing messages. Reply with JSON only.",
      messages: [
        {
          role: "user",
          content:
            `Device codec: ${codec ? `${codec.id} — existing messages: ${codec.uplink.map((m) => `${m.name}(port ${JSON.stringify(m.when?.port ?? "-")}: ${m.fields.map((f) => f.name).join(",")})`).join("; ")}` : "unknown"}\n` +
            `Cluster: ${c.count} payloads, ${c.port !== undefined ? `port ${c.port}` : `topic ${c.topic ?? "-"}`}, ${c.length} bytes, byte profile ${c.byteProfile} (C=constant, v=low variance, V=varying)\n` +
            `Samples (hex):\n${c.samples.slice(0, 12).join("\n")}`,
        },
      ],
    },
    MessageDef,
    1,
    (m) => (decodesSamples(m, c) ? [] : ["the MessageDef does not decode every sample without errors (check total length and consts)"]),
  );
  return r.value;
}

function bumpMinor(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${Number(m[2]) + 1}.0-draft` : "0.1.0-draft";
}

import { createCodec, describeSpec, runVectors } from "@hash8/codec-runtime";
import type { Codec, DeviceCodecSpec } from "@hash8/dcs-schema";
import { safeParseSpec } from "@hash8/dcs-schema";
import type { CodecStatus, CodecVersionSummary, Device, DeviceModel } from "@hash8/sdk-ts";
import type { Repos, StoredCodec } from "../db/repos";
import { badRequest, notFound } from "../errors";

export interface ResolvedCodec {
  codecId: string;
  version: string;
  codec: Codec;
}

/**
 * Codec registry: compiles each DCS once and caches the interpreter by `id@version`.
 * Resolution honours the firmware↔codec link (firmware.codecVersion) so a device
 * running firmware X is always decoded with the codec version that firmware speaks.
 */
export class CodecService {
  private cache = new Map<string, Codec>();
  /** device firmware link cache: `${modelId}@${fw}` → codecVersion | null */
  private fwLinks = new Map<string, string | null>();
  private latest = new Map<string, string | null>();
  private models = new Map<string, DeviceModel | null>();

  constructor(private repos: Repos) {}

  invalidate(codecId?: string) {
    this.latest.clear();
    this.fwLinks.clear();
    this.models.clear();
    if (!codecId) this.cache.clear();
  }

  compile(spec: DeviceCodecSpec): Codec {
    const key = `${spec.id}@${spec.version}`;
    let c = this.cache.get(key);
    if (!c) {
      c = createCodec(spec);
      this.cache.set(key, c);
    }
    return c;
  }

  async get(codecId: string, version?: string): Promise<ResolvedCodec> {
    const v = version ?? (await this.latestPublishedVersion(codecId)) ?? (await this.repos.codecs.versions(codecId))[0]?.version;
    if (!v) throw notFound("codec", codecId);
    const key = `${codecId}@${v}`;
    let codec = this.cache.get(key);
    if (!codec) {
      const stored = await this.repos.codecs.get(codecId, v);
      if (!stored) throw notFound("codec version", key);
      codec = this.compile(stored.spec);
    }
    return { codecId, version: v, codec };
  }

  async latestPublishedVersion(codecId: string): Promise<string | undefined> {
    if (!this.latest.has(codecId)) {
      this.latest.set(codecId, (await this.repos.codecs.latestPublished(codecId))?.version ?? null);
    }
    return this.latest.get(codecId) ?? undefined;
  }

  private async model(modelId: string) {
    if (!this.models.has(modelId)) this.models.set(modelId, (await this.repos.models.get(modelId)) ?? null);
    return this.models.get(modelId) ?? undefined;
  }

  /** Which codec id/version decodes this device's traffic. */
  async resolveForDevice(device: Device): Promise<{ codecId: string; version: string } | undefined> {
    const codecId = device.codecId ?? (await this.model(device.modelId))?.codecId;
    if (!codecId) return undefined;
    let version: string | undefined;
    if (device.firmwareVersion) {
      const key = `${device.modelId}@${device.firmwareVersion}`;
      if (!this.fwLinks.has(key)) {
        const fw = await this.repos.firmware.list({ where: ["model_id = ?", "version = ?"], params: [device.modelId, device.firmwareVersion], limit: 1 });
        this.fwLinks.set(key, fw[0]?.codecVersion ?? null);
      }
      version = this.fwLinks.get(key) ?? undefined;
    }
    version ??= device.codecVersion ?? (await this.latestPublishedVersion(codecId));
    if (!version) return undefined;
    return { codecId, version };
  }

  async forDevice(device: Device): Promise<ResolvedCodec | undefined> {
    const r = await this.resolveForDevice(device);
    if (!r) return undefined;
    try {
      return await this.get(r.codecId, r.version);
    } catch {
      return undefined;
    }
  }

  /** Validate + summarise a DCS (message/field counts and vector results). */
  summarize(spec: DeviceCodecSpec, status: CodecStatus, createdAt: string, publishedAt?: string): CodecVersionSummary {
    let fieldCount = 0;
    let messageCount = spec.uplink.length + (spec.downlink?.length ?? 0);
    try {
      const d = describeSpec(spec);
      fieldCount = d.fieldCount;
      messageCount = d.messages.length;
    } catch {
      /* describeSpec unavailable → fall back to counts above */
    }
    let passed = 0;
    let total = spec.vectors?.length ?? 0;
    try {
      const results = runVectors(spec);
      total = results.length;
      passed = results.filter((r) => r.pass).length;
    } catch {
      passed = 0;
    }
    const s: CodecVersionSummary = {
      codecId: spec.id,
      version: spec.version,
      status,
      vendor: spec.device.vendor,
      model: spec.device.model,
      messageCount,
      fieldCount,
      vectorsPassed: passed,
      vectorsTotal: total,
      createdAt,
    };
    if (publishedAt) s.publishedAt = publishedAt;
    return s;
  }

  parse(input: unknown): DeviceCodecSpec {
    const r = safeParseSpec(input);
    if (!r.success) throw badRequest("Invalid DCS document", r.error.issues.slice(0, 20));
    return r.data;
  }

  async save(spec: DeviceCodecSpec, tenantId: string, status: CodecStatus, now: Date): Promise<StoredCodec> {
    const existing = await this.repos.codecs.get(spec.id, spec.version);
    const createdAt = existing?.summary.createdAt ?? now.toISOString();
    const publishedAt = status === "published" ? (existing?.summary.publishedAt ?? now.toISOString()) : undefined;
    const stored: StoredCodec = {
      codecId: spec.id,
      version: spec.version,
      tenantId: existing?.tenantId ?? tenantId,
      status,
      spec,
      summary: this.summarize(spec, status, createdAt, publishedAt),
    };
    await this.repos.codecs.upsert(stored);
    this.cache.delete(`${spec.id}@${spec.version}`);
    this.invalidate(spec.id);
    return stored;
  }
}

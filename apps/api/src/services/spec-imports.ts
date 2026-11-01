import { extractFromWorkbook } from "@hash8/spec-ingest";
import { safeParseSpec } from "@hash8/dcs-schema";
import type { SpecImportJob } from "@hash8/sdk-ts";
import type { Core } from "../context";
import type { SpecImportRecord } from "../db/repos";
import type { AgentService } from "./agents";
import { notFound } from "../errors";
import { newId } from "../util/ids";

export function publicJob(r: SpecImportRecord): SpecImportJob {
  const j: SpecImportJob = { id: r.id, fileName: r.fileName, status: r.status, issues: r.issues, createdAt: r.createdAt };
  if (r.codecId) j.codecId = r.codecId;
  if (r.draftVersion) j.draftVersion = r.draftVersion;
  if (r.confidence !== undefined) j.confidence = r.confidence;
  return j;
}

/**
 * Excel → draft DCS: deterministic workbook extraction (spec-ingest) followed by the
 * spec-extractor agent (Claude when configured, deterministic fallback otherwise).
 * A valid draft is stored as a `draft` codec version for human review; the job keeps
 * the full source trace so every field links back to its sheet/cell.
 */
export class SpecImportService {
  constructor(
    private core: Core,
    private agents: AgentService,
  ) {}

  async create(tenantId: string, fileName: string, data: Uint8Array, actor: string): Promise<SpecImportRecord> {
    const job: SpecImportRecord = { id: newId("imp"), tenantId, fileName, status: "parsing", issues: [], createdAt: this.core.now().toISOString() };
    await this.core.repos.specImports.insert(job);
    try {
      const extracted = await extractFromWorkbook(data, { fileName });
      job.status = "extracting";
      job.trace = extracted.trace;
      job.sheets = extracted.sheets;
      job.issues = [...extracted.issues];
      job.confidence = extracted.confidence;
      let draft: unknown = extracted.draft;
      try {
        const run = await this.agents.run(tenantId, "spec-extractor", { fileName, xlsxBase64: Buffer.from(data).toString("base64") }, actor);
        job.agentRunId = run.id;
        const out = run.output ?? {};
        draft = out.draft ?? out.spec ?? draft;
        if (Array.isArray(out.issues)) job.issues = [...new Set((out.issues as unknown[]).map(String))];
        if (typeof out.confidence === "number") job.confidence = out.confidence;
        if (out.trace && typeof out.trace === "object") job.trace = out.trace;
      } catch (err) {
        job.issues.push(`spec-extractor agent unavailable: ${(err as Error).message}`);
      }
      job.draft = draft;
      const parsed = safeParseSpec(draft);
      if (parsed.success) {
        const spec = parsed.data;
        // Never overwrite an existing published version: imports land as a new draft version.
        const existing = await this.core.repos.codecs.get(spec.id, spec.version);
        if (existing && existing.status !== "draft") {
          const [maj, min, pat] = spec.version.split("-")[0]!.split(".").map(Number);
          spec.version = `${maj}.${min}.${(pat ?? 0) + 1}-draft.${Date.now().toString(36)}`;
          job.issues.push(`Codec ${spec.id}@${existing.version} already published; draft stored as ${spec.version}`);
        }
        const stored = await this.core.codecs.save(spec, tenantId, "draft", this.core.now());
        job.codecId = stored.codecId;
        job.draftVersion = stored.version;
        job.status = "review";
      } else {
        job.status = "review";
        job.issues.push(...parsed.error.issues.slice(0, 10).map((i) => `DCS validation: ${i.path.join(".")}: ${i.message}`));
      }
    } catch (err) {
      job.status = "failed";
      job.issues.push((err as Error).message);
    }
    await this.core.repos.specImports.update(job);
    await this.core.audit(tenantId, actor, "spec.import", `spec-import:${job.id}`, { fileName, status: job.status, codecId: job.codecId, draftVersion: job.draftVersion });
    return job;
  }

  async get(id: string, scope: string[]) {
    const j = await this.core.repos.specImports.getScoped(id, scope);
    if (!j) throw notFound("spec import", id);
    return j;
  }
}

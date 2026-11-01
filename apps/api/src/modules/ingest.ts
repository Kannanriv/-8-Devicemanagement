import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Platform } from "../platform";
import { parse, reqCtx } from "../http";
import { badRequest } from "../errors";
import { publicJob } from "../services/spec-imports";

const IngestBody = z.object({ hex: z.string().min(1), port: z.number().int().min(0).max(65535).optional(), topic: z.string().optional() });
const UnknownQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100), deviceId: z.string().optional() });
const RedecodeBody = z.object({ deviceId: z.string().optional(), since: z.string().datetime().optional() });

export default async function ingestModule(app: FastifyInstance, { p }: { p: Platform }) {
  // HTTP ingest adapter. Serial in the path; device auth would be a per-device token in prod.
  app.post<{ Params: { deviceSerial: string } }>("/ingest/http/:deviceSerial", async (req, reply) => {
    const b = parse(IngestBody, req.body);
    const u: Parameters<typeof p.pipeline.submit>[0] = { serial: req.params.deviceSerial, transport: "http", payloadHex: b.hex };
    if (b.port !== undefined) u.port = b.port;
    if (b.topic !== undefined) u.topic = b.topic;
    const result = await p.pipeline.submit(u);
    return reply.status(202).send(result);
  });

  app.get("/payloads/unknown", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = parse(UnknownQuery, req.query);
    return p.repos.unknown.list(ctx.scope, q.deviceId ? { limit: q.limit, deviceId: q.deviceId } : { limit: q.limit });
  });
  app.post("/payloads/redecode", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(RedecodeBody, req.body);
    const opts: { deviceId?: string; since?: string } = {};
    if (b.deviceId) opts.deviceId = b.deviceId;
    if (b.since) opts.since = b.since;
    const r = await p.pipeline.redecode(ctx.scope, opts);
    await p.core.audit(ctx.tenantId, ctx.actor, "payloads.redecode", b.deviceId ? `device:${b.deviceId}` : `tenant:${ctx.tenantId}`, r);
    return r;
  });

  // ── Spec imports (multipart Excel) ──
  app.post("/spec-imports", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    if (!req.isMultipart()) throw badRequest("Expected multipart/form-data with an Excel file field");
    const file = await req.file();
    if (!file) throw badRequest("No file uploaded");
    const buf = await file.toBuffer();
    if (!buf.length) throw badRequest("Empty file");
    const job = await p.specImports.create(ctx.tenantId, file.filename || "spec.xlsx", new Uint8Array(buf), ctx.actor);
    return reply.status(201).send({ ...publicJob(job), draft: job.draft, trace: job.trace, agentRunId: job.agentRunId });
  });
  app.get("/spec-imports", async (req) => {
    const ctx = await reqCtx(p, req);
    return (await p.repos.specImports.list({ tenantIds: ctx.scope, limit: 200 })).map(publicJob);
  });
  app.get<{ Params: { id: string } }>("/spec-imports/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const j = await p.specImports.get(req.params.id, ctx.scope);
    return { ...publicJob(j), draft: j.draft, trace: j.trace ?? {}, sheets: j.sheets, agentRunId: j.agentRunId };
  });
}

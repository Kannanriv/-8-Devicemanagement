import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { describeSpec, runVectors } from "@hash8/codec-runtime";
import { fromHex } from "@hash8/dcs-schema";
import type { PluginTarget } from "@hash8/sdk-ts";
import type { Platform } from "../platform";
import { parse, reqCtx, type RequestCtx } from "../http";
import { ApiError, badRequest, conflict, notFound } from "../errors";

const TARGETS = ["ts", "ts013", "python", "go", "java", "c"] as const;
const PluginQuery = z.object({ target: z.enum([...TARGETS, "all"]).default("all") });
const DecodeBody = z.object({
  codecId: z.string().min(1),
  version: z.string().optional(),
  hex: z.string().min(1),
  port: z.number().int().optional(),
  topic: z.string().optional(),
});
const PublishQuery = z.object({ force: z.enum(["0", "1", "true", "false"]).optional() });

export default async function codecsModule(app: FastifyInstance, { p }: { p: Platform }) {
  async function load(ctx: RequestCtx, id: string, version: string) {
    if (!(await p.repos.codecs.hasAccess(id, ctx.scope))) throw notFound("codec", id);
    const c = await p.repos.codecs.get(id, version);
    if (!c) throw notFound("codec version", `${id}@${version}`);
    return c;
  }

  app.get("/codecs", async (req) => {
    const ctx = await reqCtx(p, req);
    return (await p.repos.codecs.list(ctx.scope)).map((c) => c.summary);
  });
  // codec-compiler is imported lazily so API boot never depends on generator targets.
  const compiler = () => import("@hash8/codec-compiler");
  app.get("/plugin-targets", async () => (await compiler()).listTargets());
  app.get<{ Params: { id: string } }>("/codecs/:id/versions", async (req) => {
    const ctx = await reqCtx(p, req);
    if (!(await p.repos.codecs.hasAccess(req.params.id, ctx.scope))) throw notFound("codec", req.params.id);
    return (await p.repos.codecs.versions(req.params.id)).map((c) => c.summary);
  });
  app.get<{ Params: { id: string; version: string } }>("/codecs/:id/versions/:version", async (req) => {
    const ctx = await reqCtx(p, req);
    return (await load(ctx, req.params.id, req.params.version)).spec;
  });
  app.get<{ Params: { id: string; version: string } }>("/codecs/:id/versions/:version/describe", async (req) => {
    const ctx = await reqCtx(p, req);
    const c = await load(ctx, req.params.id, req.params.version);
    return { summary: c.summary, ...describeSpec(c.spec) };
  });

  app.post("/codecs", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const spec = p.codecs.parse(req.body);
    const existing = await p.repos.codecs.get(spec.id, spec.version);
    if (existing && existing.status === "published") throw conflict(`Codec ${spec.id}@${spec.version} is published and immutable; bump the version`);
    if (existing && !(await p.repos.codecs.hasAccess(spec.id, [ctx.tenantId]))) throw conflict(`Codec ${spec.id} belongs to another tenant`);
    const stored = await p.codecs.save(spec, ctx.tenantId, "draft", p.core.now());
    await p.core.audit(ctx.tenantId, ctx.actor, "codec.draft.save", `codec:${spec.id}@${spec.version}`, { vectors: `${stored.summary.vectorsPassed}/${stored.summary.vectorsTotal}` });
    return reply.status(201).send(stored.summary);
  });

  app.post<{ Params: { id: string; version: string } }>("/codecs/:id/versions/:version/publish", async (req) => {
    const ctx = await reqCtx(p, req);
    const { force } = parse(PublishQuery, req.query);
    const c = await load(ctx, req.params.id, req.params.version);
    if (c.status === "published") throw conflict(`Codec ${c.codecId}@${c.version} is already published`);
    const results = runVectors(c.spec);
    const failed = results.filter((r) => !r.pass);
    if (failed.length && force !== "1" && force !== "true") {
      throw new ApiError(422, "VECTORS_FAILED", `${failed.length}/${results.length} test vectors fail: ${failed.map((f) => f.name).slice(0, 5).join(", ")}`, failed);
    }
    const stored = await p.codecs.save(c.spec, c.tenantId, "published", p.core.now());
    await p.core.audit(ctx.tenantId, ctx.actor, "codec.publish", `codec:${c.codecId}@${c.version}`, { vectors: `${results.length - failed.length}/${results.length}`, forced: failed.length > 0 });
    return stored.summary;
  });

  app.post<{ Params: { id: string; version: string } }>("/codecs/:id/versions/:version/test", async (req) => {
    const ctx = await reqCtx(p, req);
    const c = await load(ctx, req.params.id, req.params.version);
    return runVectors(c.spec);
  });

  app.get<{ Params: { id: string; version: string } }>("/codecs/:id/versions/:version/plugin", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const { target } = parse(PluginQuery, req.query);
    const c = await load(ctx, req.params.id, req.params.version);
    const targets: PluginTarget[] = target === "all" ? [...TARGETS] : [target];
    const zip = await (await compiler()).buildBundle(c.spec, targets);
    const fileName = `${c.codecId}-${c.version}-${target}.zip`;
    await p.core.audit(ctx.tenantId, ctx.actor, "codec.plugin.download", `codec:${c.codecId}@${c.version}`, { target });
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .send(Buffer.from(zip));
  });

  app.post("/diagnostics/decode", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(DecodeBody, req.body);
    if (!(await p.repos.codecs.hasAccess(b.codecId, ctx.scope))) throw notFound("codec", b.codecId);
    const { codec } = await p.codecs.get(b.codecId, b.version);
    let bytes: Uint8Array;
    try {
      bytes = fromHex(b.hex);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const pctx: { port?: number; topic?: string } = {};
    if (b.port !== undefined) pctx.port = b.port;
    if (b.topic !== undefined) pctx.topic = b.topic;
    return codec.decode(bytes, pctx);
  });
}

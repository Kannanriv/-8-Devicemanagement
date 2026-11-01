import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { z } from "zod";
import type { Platform } from "../platform";
import { parse, reqCtx } from "../http";
import { badRequest, notFound } from "../errors";
import { publicFirmware } from "../services/firmware";
import { LIFECYCLES } from "./inventory";

const FirmwareFields = z.object({
  modelId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "version must be semver"),
  codecVersion: z.string().optional(),
  releaseNotes: z.string().optional(),
});
const FirmwareJson = FirmwareFields.extend({ dataBase64: z.string().min(1) });

const Cohort = z.object({
  q: z.string().optional(),
  modelId: z.string().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  connectivity: z.enum(["online", "offline", "never_seen"]).optional(),
  tag: z.string().optional(),
  firmwareVersion: z.string().optional(),
});
const CampaignBody = z.object({
  name: z.string().min(1),
  firmwareId: z.string().min(1),
  fromVersions: z.array(z.string()).optional(),
  cohort: Cohort.optional(),
  healthGate: z.object({ maxFailureRate: z.number().min(0).max(1), minHealthScore: z.number().min(0).max(100) }).optional(),
  waves: z.array(z.object({ name: z.string(), percent: z.number() })).min(1).optional(),
  start: z.boolean().optional(),
});
const ReasonBody = z.object({ reason: z.string().max(500).optional() });

export default async function firmwareOtaModule(app: FastifyInstance, { p }: { p: Platform }) {
  app.get("/firmware", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = req.query as { modelId?: string };
    // Firmware is published by the OEM; solution tenants see firmware for models they operate.
    const rows = await p.db.query<{ doc: Parameters<typeof publicFirmware>[0] }>(
      `SELECT doc FROM firmware WHERE (tenant_id = ANY($1::text[]) OR model_id IN (SELECT DISTINCT model_id FROM devices WHERE tenant_id = ANY($1::text[])))
         ${q.modelId ? "AND model_id = $2" : ""} ORDER BY created_at DESC`,
      q.modelId ? [ctx.scope, q.modelId] : [ctx.scope],
    );
    return rows.map((r) => publicFirmware(r.doc));
  });
  app.get("/firmware/signing-key", async () => ({ algorithm: "ed25519", publicKeyPem: p.firmware.publicKeyPem }));
  app.get<{ Params: { id: string } }>("/firmware/:id/download", async (req, reply) => {
    const fw = await p.repos.firmware.get(req.params.id);
    if (!fw?.filePath || !existsSync(fw.filePath)) throw notFound("firmware", req.params.id);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${fw.modelId}-${fw.version}.bin"`)
      .header("x-firmware-sha256", fw.sha256)
      .header("x-firmware-signature", fw.signature)
      .send(createReadStream(fw.filePath));
  });
  app.post("/firmware", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    let fields: Record<string, string> = {};
    let bytes: Buffer | undefined;
    let fileName: string | undefined;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          bytes = await part.toBuffer();
          fileName = part.filename;
        } else fields[part.fieldname] = String(part.value);
      }
    } else {
      const b = parse(FirmwareJson, req.body);
      fields = { ...b } as unknown as Record<string, string>;
      bytes = Buffer.from(b.dataBase64, "base64");
    }
    if (!bytes?.length) throw badRequest("Firmware binary required (multipart file field)");
    const meta = parse(FirmwareFields, fields);
    const input: Parameters<typeof p.firmware.create>[1] = { modelId: meta.modelId, version: meta.version };
    if (meta.codecVersion) input.codecVersion = meta.codecVersion;
    if (meta.releaseNotes) input.releaseNotes = meta.releaseNotes;
    if (fileName) input.fileName = fileName;
    return reply.status(201).send(await p.firmware.create(ctx.tenantId, input, new Uint8Array(bytes), ctx.actor));
  });

  // ── OTA campaigns ──
  app.get("/ota/campaigns", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.repos.campaigns.list({ tenantIds: ctx.scope });
  });
  app.get<{ Params: { id: string } }>("/ota/campaigns/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.ota.get(req.params.id, ctx.scope);
  });
  app.get<{ Params: { id: string } }>("/ota/campaigns/:id/devices", async (req) => {
    const ctx = await reqCtx(p, req);
    const c = await p.ota.get(req.params.id, ctx.scope);
    return p.repos.campaignDevices.list(c.id);
  });
  app.post("/ota/campaigns", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(CampaignBody, req.body);
    const input: Parameters<typeof p.ota.create>[2] = { name: b.name, firmwareId: b.firmwareId };
    if (b.fromVersions) input.fromVersions = b.fromVersions;
    if (b.cohort) input.cohort = b.cohort;
    if (b.healthGate) input.healthGate = b.healthGate;
    if (b.waves) input.waves = b.waves;
    let c = await p.ota.create(ctx.tenantId, ctx.scope, input, ctx.actor);
    if (b.start) c = await p.ota.start(c, ctx.actor);
    return reply.status(201).send(c);
  });
  for (const action of ["start", "pause", "resume", "rollback"] as const) {
    app.post<{ Params: { id: string } }>(`/ota/campaigns/:id/${action}`, async (req) => {
      const ctx = await reqCtx(p, req);
      const { reason } = parse(ReasonBody, req.body);
      const c = await p.ota.get(req.params.id, ctx.scope);
      switch (action) {
        case "start":
          return p.ota.start(c, ctx.actor);
        case "pause":
          return p.ota.pause(c, ctx.actor, reason);
        case "resume":
          return p.ota.resume(c, ctx.actor);
        case "rollback":
          return p.ota.rollback(c, ctx.actor, reason);
      }
    });
  }
  /** Dev: advance the simulated rollout one step (the ticker does this automatically). */
  app.post<{ Params: { id: string } }>("/ota/campaigns/:id/tick", async (req) => {
    const ctx = await reqCtx(p, req);
    const c = await p.ota.get(req.params.id, ctx.scope);
    return c.status === "running" ? p.ota.tickCampaign(c) : c;
  });
}

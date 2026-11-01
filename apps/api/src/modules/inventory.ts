import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Batch, Device, DeviceModel, LifecycleState } from "@hash8/sdk-ts";
import type { Platform } from "../platform";
import { parse, reqCtx } from "../http";
import { badRequest, conflict, notFound } from "../errors";
import { newId } from "../util/ids";

export const LIFECYCLES = ["registered", "assigned", "installing", "pending_activation", "activated", "maintenance", "suspended", "swap", "retired"] as const;
export const CONNECTIVITY = ["online", "stale", "offline", "never_seen"] as const;

export const DeviceListQuery = z.object({
  q: z.string().optional(),
  organization: z.string().optional(),
  branch: z.string().optional(),
  oem: z.string().optional(),
  modelId: z.string().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  connectivity: z.enum(CONNECTIVITY).optional(),
  health: z.enum(["normal", "warning", "critical"]).optional(),
  firmwareVersion: z.string().optional(),
  assetId: z.string().optional(),
  tag: z.string().optional(),
  installedFrom: z.string().datetime().optional(),
  installedTo: z.string().datetime().optional(),
  lastSeenBefore: z.string().datetime().optional(),
  lastSeenAfter: z.string().datetime().optional(),
  sort: z.enum(["lastSeen", "health", "udi", "installedAt"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
});

const Site = z.object({ name: z.string(), lat: z.number().optional(), lng: z.number().optional() });

const ModelBody = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).optional(),
  vendor: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  protocols: z.array(z.string()).default([]),
  codecId: z.string().optional(),
  imageUrl: z.string().optional(),
  tenantId: z.string().optional(),
});

export const DeviceBody = z.object({
  serial: z.string().min(1),
  modelId: z.string().min(1),
  imei: z.string().optional(),
  iccid: z.string().optional(),
  carrier: z.string().optional(),
  name: z.string().optional(),
  organization: z.string().optional(),
  branch: z.string().optional(),
  batchId: z.string().optional(),
  firmwareVersion: z.string().optional(),
  tags: z.array(z.string()).default([]),
  site: Site.optional(),
});

const DevicePatch = z
  .object({
    name: z.string().optional(),
    imei: z.string().optional(),
    organization: z.string().optional(),
    branch: z.string().optional(),
    batchId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    site: Site.optional(),
    codecVersion: z.string().optional(),
  })
  .strict();

const BatchBody = z.object({
  modelId: z.string(),
  name: z.string().min(1),
  quantity: z.number().int().min(0),
  firmwareId: z.string().optional(),
});

/** Operator-facing unique device identifier derived from model + serial. */
export function makeUdi(model: DeviceModel, serial: string): string {
  const prefix = model.id.split("-").map((p) => p.slice(0, 3)).join("").toUpperCase().slice(0, 6);
  return `UDI-${prefix}-${serial.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-10)}`;
}

export function newDevice(now: string, tenantId: string, model: DeviceModel, b: z.infer<typeof DeviceBody>, lifecycle: LifecycleState = "registered"): Device {
  const d: Device = {
    id: newId("dev"),
    udi: makeUdi(model, b.serial),
    tenantId,
    oemTenantId: model.tenantId,
    oem: model.vendor,
    modelId: model.id,
    model: model.name,
    serial: b.serial,
    lifecycle,
    provisioning: "provisioned",
    tags: b.tags ?? [],
    health: { score: 0, level: "normal", connectivity: "never_seen", issues: ["Never communicated"] },
    shadow: {},
    createdAt: now,
    updatedAt: now,
  };
  if (model.codecId) d.codecId = model.codecId;
  for (const k of ["imei", "name", "batchId", "firmwareVersion", "organization", "branch"] as const) if (b[k]) d[k] = b[k];
  if (b.iccid) d.sim = { iccid: b.iccid, carrier: b.carrier ?? "unknown", status: "inactive" };
  if (b.site) d.site = b.site;
  return d;
}

export default async function inventoryModule(app: FastifyInstance, { p }: { p: Platform }) {
  // ── Models ──
  app.get("/models", async (req) => {
    const { scope } = await reqCtx(p, req);
    // Models are catalog entries: visible to the owning OEM and to tenants holding its devices.
    const rows = await p.db.query<{ doc: DeviceModel }>(
      `SELECT doc FROM models WHERE tenant_id = ANY($1::text[])
          OR id IN (SELECT DISTINCT model_id FROM devices WHERE tenant_id = ANY($1::text[]))
        ORDER BY created_at, id`,
      [scope],
    );
    return rows.map((r) => r.doc);
  });
  app.get<{ Params: { id: string } }>("/models/:id", async (req) => {
    const m = await p.repos.models.get(req.params.id);
    if (!m) throw notFound("model", req.params.id);
    return m;
  });
  app.post("/models", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(ModelBody, req.body);
    const id = b.id ?? `${b.vendor}-${b.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (await p.repos.models.get(id)) throw conflict(`Model ${id} already exists`);
    const m: DeviceModel = { id, tenantId: b.tenantId ?? ctx.tenantId, vendor: b.vendor, name: b.name, category: b.category, protocols: b.protocols, createdAt: p.core.now().toISOString() };
    if (b.codecId) m.codecId = b.codecId;
    if (b.imageUrl) m.imageUrl = b.imageUrl;
    await p.repos.models.insert(m);
    p.devices.invalidateModels();
    await p.core.audit(ctx.tenantId, ctx.actor, "model.create", `model:${id}`, { vendor: m.vendor, name: m.name });
    return reply.status(201).send(m);
  });

  // ── Devices ──
  app.get("/devices", async (req) => {
    const { scope } = await reqCtx(p, req);
    const q = parse(DeviceListQuery, req.query);
    return p.repos.devices.list(scope, q);
  });
  app.get<{ Params: { id: string } }>("/devices/:id", async (req) => {
    const { scope } = await reqCtx(p, req);
    return p.devices.getVisible(req.params.id, scope);
  });
  app.post("/devices", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(DeviceBody, req.body);
    const model = await p.repos.models.get(b.modelId);
    if (!model) throw badRequest(`Unknown modelId ${b.modelId}`);
    if (await p.repos.devices.getBySerial(b.serial)) throw conflict(`Serial ${b.serial} already registered`);
    const d = newDevice(p.core.now().toISOString(), ctx.tenantId, model, b);
    await p.repos.devices.insertMany([d]);
    await p.core.timeline(d.tenantId, d.id, "lifecycle", "Device registered (manufactured)", { actor: ctx.actor });
    await p.core.audit(ctx.tenantId, ctx.actor, "device.create", `device:${d.id}`, { serial: d.serial, modelId: d.modelId });
    return reply.status(201).send(d);
  });
  app.patch<{ Params: { id: string } }>("/devices/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    const patch = parse(DevicePatch, req.body);
    const next: Device = { ...d, ...patch, updatedAt: p.core.now().toISOString() };
    await p.devices.save(next);
    if (patch.codecVersion) p.codecs.invalidate();
    await p.core.audit(d.tenantId, ctx.actor, "device.update", `device:${d.id}`, patch);
    return next;
  });
  app.post("/devices/import", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const body = req.body as unknown;
    const text = typeof body === "string" ? body : typeof (body as { csv?: unknown })?.csv === "string" ? (body as { csv: string }).csv : undefined;
    if (!text) throw badRequest("Expected CSV body (text/csv) with columns serial,imei,iccid,modelId");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let cols = ["serial", "imei", "iccid", "modelId"];
    if (lines[0] && /serial/i.test(lines[0])) cols = lines.shift()!.split(",").map((c) => c.trim());
    const idx = (n: string) => cols.findIndex((c) => c.toLowerCase() === n.toLowerCase());
    const models = new Map<string, DeviceModel | undefined>();
    const created: Device[] = [];
    const errors: { line: number; error: string }[] = [];
    const seen = new Set<string>();
    const now = p.core.now().toISOString();
    for (const [i, line] of lines.entries()) {
      const cells = line.split(",").map((c) => c.trim());
      const get = (n: string) => (idx(n) >= 0 ? cells[idx(n)] || undefined : undefined);
      const serial = get("serial");
      const modelId = get("modelId");
      if (!serial || !modelId) {
        errors.push({ line: i + 1, error: "serial and modelId are required" });
        continue;
      }
      if (!models.has(modelId)) models.set(modelId, await p.repos.models.get(modelId));
      const model = models.get(modelId);
      if (!model) {
        errors.push({ line: i + 1, error: `unknown modelId ${modelId}` });
        continue;
      }
      if (seen.has(serial) || (await p.repos.devices.getBySerial(serial))) {
        errors.push({ line: i + 1, error: `duplicate serial ${serial}` });
        continue;
      }
      seen.add(serial);
      const b: z.infer<typeof DeviceBody> = { serial, modelId, tags: [] };
      const imei = get("imei");
      const iccid = get("iccid");
      if (imei) b.imei = imei;
      if (iccid) b.iccid = iccid;
      created.push(newDevice(now, ctx.tenantId, model, b));
    }
    await p.repos.devices.insertMany(created);
    await p.core.audit(ctx.tenantId, ctx.actor, "device.import", `tenant:${ctx.tenantId}`, { imported: created.length, errors: errors.length });
    return reply.status(created.length ? 201 : 400).send({ imported: created.length, items: created, errors });
  });

  // ── Batches ──
  app.get("/batches", async (req) => {
    const { scope } = await reqCtx(p, req);
    return p.repos.batches.list({ tenantIds: scope });
  });
  app.post("/batches", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(BatchBody, req.body);
    if (!(await p.repos.models.get(b.modelId))) throw badRequest(`Unknown modelId ${b.modelId}`);
    const batch: Batch = { id: newId("bat"), tenantId: ctx.tenantId, modelId: b.modelId, name: b.name, quantity: b.quantity, createdAt: p.core.now().toISOString() };
    if (b.firmwareId) batch.firmwareId = b.firmwareId;
    await p.repos.batches.insert(batch);
    await p.core.audit(ctx.tenantId, ctx.actor, "batch.create", `batch:${batch.id}`, { modelId: b.modelId, quantity: b.quantity });
    return reply.status(201).send(batch);
  });
}

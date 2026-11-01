import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Asset, BulkOp, Device, DeviceQuery, SimInfo } from "@hash8/sdk-ts";
import type { Platform } from "../platform";
import { parse, reqCtx } from "../http";
import { ApiError, badRequest, conflict, notFound } from "../errors";
import { DeviceListQuery } from "./inventory";
import { resetDemo } from "../seed/seed";

const BULK_OPS = ["assign", "lifecycle", "apply_config", "start_ota", "suspend", "reactivate", "diagnostics", "command", "tag", "transfer", "export"] as const;
const QueryBody = DeviceListQuery.omit({ limit: true, cursor: true, sort: true });
const BulkPreviewBody = z.object({ op: z.enum(BULK_OPS), deviceIds: z.array(z.string()).max(10_000).optional(), query: QueryBody.optional(), params: z.record(z.unknown()).default({}) });
const BulkRunBody = z.object({ op: z.enum(BULK_OPS), deviceIds: z.array(z.string()).min(1).max(10_000), params: z.record(z.unknown()).default({}) });
const Site = z.object({ name: z.string(), lat: z.number().optional(), lng: z.number().optional() });
const AssetBody = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  make: z.string().optional(),
  model: z.string().optional(),
  serial: z.string().optional(),
  organization: z.string().optional(),
  branch: z.string().optional(),
  site: Site.optional(),
});
const AssetQuery = z.object({
  q: z.string().optional(),
  type: z.string().optional(),
  organization: z.string().optional(),
  branch: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
const AttachBody = z.object({ deviceId: z.string().min(1), role: z.enum(["primary", "secondary"]).default("primary") });
const SwapBody = z.object({ oldDeviceId: z.string().min(1), newDeviceId: z.string().min(1) });
const SimQuery = z.object({ status: z.enum(["inactive", "active", "suspended", "terminated", "unknown"]).optional(), carrier: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).default(500) });
const RevokeBody = z.object({ reason: z.string().min(1).max(500) });
const IssueBody = z.object({ days: z.number().int().min(1).max(3650).default(365) });
const ReportQuery = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
const TrendQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const CSV_COLUMNS: [string, (d: Device) => unknown][] = [
  ["udi", (d) => d.udi],
  ["serial", (d) => d.serial],
  ["imei", (d) => d.imei],
  ["oem", (d) => d.oem],
  ["model", (d) => d.model],
  ["organization", (d) => d.organization],
  ["branch", (d) => d.branch],
  ["asset", (d) => d.assetName],
  ["lifecycle", (d) => d.lifecycle],
  ["connectivity", (d) => d.health.connectivity],
  ["health", (d) => d.health.level],
  ["healthScore", (d) => d.health.score],
  ["firmware", (d) => d.firmwareVersion],
  ["otaStatus", (d) => d.otaStatus],
  ["iccid", (d) => d.sim?.iccid],
  ["carrier", (d) => d.sim?.carrier],
  ["simStatus", (d) => d.sim?.status],
  ["lastSeenAt", (d) => d.health.lastSeenAt],
  ["installedAt", (d) => d.installedAt],
  ["activatedAt", (d) => d.activatedAt],
];
function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function fleetV11Module(app: FastifyInstance, { p }: { p: Platform }) {
  // ── 01/02 Overview & inventory ──
  app.get("/inventory/kpis", async (req) => p.stats.inventoryKpis((await reqCtx(p, req)).tenantId));
  app.get("/lifecycle/summary", async (req) => p.stats.lifecycleSummary((await reqCtx(p, req)).tenantId));
  app.get("/devices/export", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const q = parse(DeviceListQuery, req.query) as DeviceQuery;
    const ids = await p.repos.devices.ids(ctx.scope, { ...q, limit: undefined, cursor: undefined } as DeviceQuery);
    const lines = [CSV_COLUMNS.map(([h]) => h).join(",")];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = await p.repos.devices.getMany(ids.slice(i, i + 500));
      const byId = new Map(chunk.map((d) => [d.id, d]));
      for (const id of ids.slice(i, i + 500)) {
        const d = byId.get(id);
        if (d) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(d))).join(","));
      }
    }
    await p.core.audit(ctx.tenantId, ctx.actor, "devices.export", `tenant:${ctx.tenantId}`, { rows: ids.length, filters: q });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="devices-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(lines.join("\n") + "\n");
  });

  // ── 02 Bulk operations ──
  app.post("/devices/bulk/preview", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(BulkPreviewBody, req.body);
    const input: { deviceIds?: string[]; query?: DeviceQuery } = {};
    if (b.deviceIds?.length) input.deviceIds = b.deviceIds;
    else if (b.query) input.query = b.query as DeviceQuery;
    else throw badRequest("deviceIds or query required");
    return p.bulk.preview(ctx, b.op as BulkOp, input, b.params);
  });
  app.post("/devices/bulk", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(BulkRunBody, req.body);
    return reply.status(201).send(await p.bulk.run(ctx, b.op as BulkOp, b.deviceIds, b.params));
  });
  app.get("/bulk-jobs", async (req) => {
    const ctx = await reqCtx(p, req);
    return (await p.repos.bulkJobs.list({ tenantIds: ctx.scope, limit: 100 })).map(({ tenantId: _t, ...j }) => j);
  });
  app.get<{ Params: { id: string } }>("/bulk-jobs/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const j = await p.repos.bulkJobs.getScoped(req.params.id, ctx.scope);
    if (!j) throw notFound("bulk job", req.params.id);
    const { tenantId: _t, ...pub } = j;
    return pub;
  });

  // ── 04 Assets ──
  app.get("/assets", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = parse(AssetQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) (where.push("search LIKE ?"), params.push(`%${q.q.toLowerCase()}%`));
    if (q.type) (where.push("type = ?"), params.push(q.type));
    if (q.organization) (where.push("organization = ?"), params.push(q.organization));
    if (q.branch) (where.push("branch = ?"), params.push(q.branch));
    const [items, total] = await Promise.all([
      p.repos.assets.list({ tenantIds: ctx.scope, where, params, limit: q.limit, offset: q.offset, orderBy: "created_at DESC, id" }),
      p.repos.assets.count({ tenantIds: ctx.scope, where, params }),
    ]);
    return { items, total };
  });
  app.post("/assets", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(AssetBody, req.body);
    return reply.status(201).send(await p.assets.create(ctx.tenantId, b as Omit<Asset, "id" | "tenantId" | "deviceIds" | "createdAt">, ctx.actor));
  });
  app.get<{ Params: { id: string } }>("/assets/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.assets.get(req.params.id, ctx.scope);
    const devices = await p.repos.devices.getMany(a.deviceIds);
    return { ...a, devices };
  });
  app.patch<{ Params: { id: string } }>("/assets/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.assets.get(req.params.id, ctx.scope);
    const patch = parse(AssetBody.partial(), req.body);
    const next: Asset = { ...a, ...(patch as Partial<Asset>) };
    await p.repos.assets.update(next);
    if (patch.name) for (const d of await p.repos.devices.getMany(a.deviceIds)) await p.devices.save({ ...d, assetName: patch.name });
    await p.core.audit(a.tenantId, ctx.actor, "asset.update", `asset:${a.id}`, patch);
    return next;
  });
  app.post<{ Params: { id: string } }>("/assets/:id/devices", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const a = await p.assets.get(req.params.id, ctx.scope);
    const b = parse(AttachBody, req.body);
    const r = await p.assets.attach(a, b.deviceId, b.role, ctx.actor, "install", ctx.scope);
    return reply.status(201).send(r);
  });
  app.delete<{ Params: { id: string; deviceId: string } }>("/assets/:id/devices/:deviceId", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.assets.get(req.params.id, ctx.scope);
    return p.assets.detach(a, req.params.deviceId, ctx.actor, "remove");
  });
  app.post<{ Params: { id: string } }>("/assets/:id/swap", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.assets.get(req.params.id, ctx.scope);
    const b = parse(SwapBody, req.body);
    return p.assets.swap(a, b.oldDeviceId, b.newDeviceId, ctx.actor, ctx.scope);
  });
  app.get<{ Params: { id: string } }>("/assets/:id/associations", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.assets.get(req.params.id, ctx.scope);
    return p.repos.associations.forAsset(a.id);
  });
  app.get<{ Params: { id: string } }>("/devices/:id/associations", async (req) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.repos.associations.forDevice(d.id);
  });

  // ── 07 SIM ──
  app.get<{ Params: { id: string } }>("/devices/:id/sim", async (req) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    if (!d.sim) throw notFound("SIM for device", d.id);
    return d.sim;
  });
  for (const action of ["activate", "suspend"] as const) {
    app.post<{ Params: { id: string } }>(`/devices/:id/sim/${action}`, async (req) => {
      const ctx = await reqCtx(p, req);
      const d = await p.devices.getVisible(req.params.id, ctx.scope);
      if (!d.sim) throw notFound("SIM for device", d.id);
      if (d.sim.status === "terminated") throw conflict("SIM is terminated", "INVALID_STATE");
      const to: SimInfo["status"] = action === "activate" ? "active" : "suspended";
      if (d.sim.status === to) throw conflict(`SIM already ${to}`, "INVALID_STATE");
      const sim: SimInfo = { ...d.sim, status: to };
      if (to === "active") sim.activatedAt ??= p.core.now().toISOString();
      await p.devices.save({ ...d, sim, updatedAt: p.core.now().toISOString() });
      await p.core.timeline(d.tenantId, d.id, "audit", `SIM ${action === "activate" ? "activated" : "suspended"} (${sim.carrier})`, { iccid: sim.iccid });
      await p.core.audit(d.tenantId, ctx.actor, `sim.${action}`, `device:${d.id}`, { iccid: sim.iccid, carrier: sim.carrier });
      await p.integrations.dispatch(d.tenantId, `sim.${action}`, { deviceId: d.id, iccid: sim.iccid, carrier: sim.carrier });
      return sim;
    });
  }
  app.get("/sims", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = parse(SimQuery, req.query);
    const where = ["doc ? 'sim'", "(tenant_id = ANY($1::text[]) OR oem_tenant_id = ANY($1::text[]))"];
    const params: unknown[] = [ctx.scope];
    if (q.status) (params.push(q.status), where.push(`doc->'sim'->>'status' = $${params.length}`));
    if (q.carrier) (params.push(q.carrier), where.push(`doc->'sim'->>'carrier' = $${params.length}`));
    params.push(q.limit);
    const rows = await p.db.query<{ doc: Device }>(`SELECT doc FROM devices WHERE ${where.join(" AND ")} ORDER BY udi LIMIT $${params.length}`, params);
    return rows.map(({ doc: d }) => ({ ...d.sim!, deviceId: d.id, udi: d.udi, organization: d.organization, lifecycle: d.lifecycle }));
  });

  // ── 12 Security ──
  app.get<{ Params: { id: string } }>("/devices/:id/credentials", async (req) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.credentials.list(d.id);
  });
  app.post<{ Params: { id: string } }>("/devices/:id/credentials", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    if (d.lifecycle === "retired") throw conflict("Cannot issue credentials to a retired device", "INVALID_STATE");
    const b = parse(IssueBody, req.body ?? {});
    return reply.status(201).send(await p.credentials.issue(d, ctx.actor, b.days));
  });
  app.post<{ Params: { id: string } }>("/credentials/:id/revoke", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(RevokeBody, req.body);
    return p.credentials.revoke(req.params.id, ctx.scope, ctx.actor, b.reason);
  });
  app.get("/credentials/expiring", async (req) => {
    const ctx = await reqCtx(p, req);
    const days = Number((req.query as { days?: string }).days ?? 30);
    return p.credentials.expiring(ctx.scope, Number.isFinite(days) ? days : 30);
  });
  app.get("/security/overview", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.credentials.overview(ctx.tenantId, ctx.scope);
  });
  app.get("/security/ca", async () => ({ certificatePem: p.credentials.ca.certPem, fingerprint: p.credentials.ca.fingerprint, notAfter: p.credentials.ca.notAfter }));

  // ── 13 Reports ──
  app.get("/reports/fleet", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = parse(ReportQuery, req.query);
    const to = q.to ? new Date(q.to) : p.core.now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw badRequest("from must be before to");
    return p.stats.fleetReport(ctx.tenantId, from, to);
  });
  app.get("/reports/trends", async (req) => {
    const ctx = await reqCtx(p, req);
    const { days } = parse(TrendQuery, req.query);
    return p.stats.trends(ctx.tenantId, days);
  });

  // ── Admin (dev) ──
  app.post("/admin/demo/reset", async (req) => {
    const ctx = await reqCtx(p, req);
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_RESET !== "1") throw new ApiError(403, "FORBIDDEN", "Demo reset is disabled in production");
    const stats = await resetDemo(p);
    await p.core.audit(ctx.tenantId, ctx.actor, "admin.demo.reset", "system:demo", stats);
    return { reset: true, ...stats };
  });
}

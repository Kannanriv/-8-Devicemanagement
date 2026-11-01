import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConfigTemplate } from "@hash8/sdk-ts";
import { applyTemplate } from "@hash8/ops-engine";
import type { Platform } from "../platform";
import { parse, reqCtx } from "../http";
import { badRequest } from "../errors";
import { newId } from "../util/ids";
import { LIFECYCLES } from "./inventory";

const LifecycleBody = z.object({ to: z.enum(LIFECYCLES), note: z.string().max(500).optional() });
const TransferBody = z.object({ deviceIds: z.array(z.string()).min(1).max(10_000), toTenantId: z.string().min(1) });
const Limit = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) });
const TimelineQuery = Limit.extend({ kinds: z.string().optional() });
const ConfigBody = z.object({ desired: z.record(z.unknown()).optional(), templateId: z.string().optional() }).refine((b) => b.desired || b.templateId, "desired or templateId required");
const TemplateBody = z.object({ modelId: z.string(), name: z.string().min(1), values: z.record(z.unknown()) });
const CommandBody = z.object({ message: z.string().min(1), data: z.record(z.unknown()).default({}) });
const AckBody = z.object({ success: z.boolean().default(true), error: z.string().optional() });

export default async function deviceOpsModule(app: FastifyInstance, { p }: { p: Platform }) {
  // ── Lifecycle & transfer ──
  app.post<{ Params: { id: string } }>("/devices/:id/lifecycle", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(LifecycleBody, req.body);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.devices.transition(d, b.to, ctx.actor, b.note);
  });
  app.post("/devices/transfer", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(TransferBody, req.body);
    const transferred = await p.devices.transfer(b.deviceIds, b.toTenantId, ctx.scope, ctx.actor);
    return { transferred };
  });

  // ── Health & history ──
  app.get<{ Params: { id: string } }>("/devices/:id/health", async (req) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.devices.healthFor(d);
  });
  app.get<{ Params: { id: string } }>("/devices/:id/messages", async (req) => {
    const ctx = await reqCtx(p, req);
    const { limit } = parse(Limit, req.query);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.repos.messages.listForDevice(d.id, limit);
  });
  app.get<{ Params: { id: string } }>("/devices/:id/timeline", async (req) => {
    const ctx = await reqCtx(p, req);
    const { limit, kinds } = parse(TimelineQuery, req.query);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.repos.timeline.listForDevice(d.id, limit, kinds ? kinds.split(",").map((k) => k.trim()).filter(Boolean) : undefined);
  });

  // ── Config ──
  app.get<{ Params: { id: string } }>("/devices/:id/config", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.devices.getConfig(await p.devices.getVisible(req.params.id, ctx.scope));
  });
  app.put<{ Params: { id: string } }>("/devices/:id/config", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(ConfigBody, req.body);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    let desired = b.desired ?? {};
    if (b.templateId) {
      const t = await p.repos.templates.getScoped(b.templateId, ctx.scope);
      if (!t) throw badRequest(`Unknown templateId ${b.templateId}`);
      if (t.modelId !== d.modelId) throw badRequest(`Template ${t.id} is for model ${t.modelId}, device is ${d.modelId}`);
      desired = applyTemplate(t, b.desired);
    }
    return p.devices.setDesired(d, desired, ctx.actor, b.templateId);
  });
  app.get("/config-templates", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = req.query as { modelId?: string };
    return p.repos.templates.list(q.modelId ? { tenantIds: ctx.scope, where: ["model_id = ?"], params: [q.modelId] } : { tenantIds: ctx.scope });
  });
  app.post("/config-templates", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(TemplateBody, req.body);
    if (!(await p.repos.models.get(b.modelId))) throw badRequest(`Unknown modelId ${b.modelId}`);
    const prior = await p.repos.templates.list({ tenantIds: [ctx.tenantId], where: ["model_id = ?", "doc->>'name' = ?"], params: [b.modelId, b.name] });
    const t: ConfigTemplate = {
      id: newId("cfgt"),
      tenantId: ctx.tenantId,
      modelId: b.modelId,
      name: b.name,
      version: prior.reduce((m, x) => Math.max(m, x.version), 0) + 1,
      values: b.values,
      createdAt: p.core.now().toISOString(),
    };
    await p.repos.templates.insert(t);
    await p.core.audit(ctx.tenantId, ctx.actor, "config.template.create", `config-template:${t.id}`, { modelId: t.modelId, version: t.version });
    return reply.status(201).send(t);
  });

  // ── Commands ──
  app.get<{ Params: { id: string } }>("/devices/:id/commands", async (req) => {
    const ctx = await reqCtx(p, req);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return p.commands.list(d.id);
  });
  app.post<{ Params: { id: string } }>("/devices/:id/commands", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(CommandBody, req.body);
    const d = await p.devices.getVisible(req.params.id, ctx.scope);
    return reply.status(201).send(await p.commands.send(d, b.message, b.data, ctx.actor));
  });
  app.post<{ Params: { id: string } }>("/commands/:id/cancel", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.commands.cancel(req.params.id, ctx.scope, ctx.actor);
  });
  app.post<{ Params: { id: string } }>("/commands/:id/ack", async (req) => {
    const ctx = await reqCtx(p, req);
    const b = parse(AckBody, req.body);
    return p.commands.ack(req.params.id, ctx.scope, ctx.actor, b.success ? undefined : (b.error ?? "Device reported failure"));
  });
}

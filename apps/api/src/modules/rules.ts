import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentName, Automation, Integration } from "@hash8/sdk-ts";
import { compileExpression } from "@hash8/ops-engine";
import type { Platform } from "../platform";
import { parse, reqCtx } from "../http";
import { badRequest, notFound } from "../errors";
import { newId } from "../util/ids";
import { LIFECYCLES } from "./inventory";

const Severity = z.enum(["info", "warning", "critical"]);
const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), codecId: z.string().optional(), message: z.string().optional() }),
  z.object({ type: z.literal("lifecycle"), to: z.enum(LIFECYCLES) }),
  z.object({ type: z.literal("offline"), minutes: z.number().int().min(1) }),
  z.object({ type: z.literal("schedule"), cron: z.string().min(1) }),
]);
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("alert"), severity: Severity, title: z.string().min(1) }),
  z.object({ type: z.literal("command"), message: z.string().min(1), data: z.record(z.unknown()).default({}) }),
  z.object({ type: z.literal("webhook"), integrationId: z.string().min(1) }),
  z.object({ type: z.literal("lifecycle"), to: z.enum(LIFECYCLES) }),
  z.object({ type: z.literal("tag"), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }),
]);
const AutomationBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  trigger: Trigger,
  condition: z.string().max(4096).optional(),
  actions: z.array(Action).min(1),
});
const AutomationPatch = AutomationBody.partial();
const DryRunBody = z.object({ deviceId: z.string().min(1), data: z.record(z.unknown()).optional(), message: z.string().optional() });

const KINDS = ["webhook", "hash8-crm", "hash8-ticketing", "hash8-installation", "hash8-sim", "mqtt-bridge", "kafka"] as const;
const IntegrationBody = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  events: z.array(z.string()).min(1),
  config: z.record(z.unknown()).default({}),
});
const IntegrationPatch = IntegrationBody.partial();

const AlertQuery = z.object({
  status: z.enum(["open", "acknowledged", "resolved"]).optional(),
  severity: Severity.optional(),
  category: z.enum(["device_failure", "abnormal_telemetry", "communication_loss", "security", "ota", "other"]).optional(),
  deviceId: z.string().optional(),
  assetId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const AuditQuery = z.object({
  target: z.string().optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const AGENTS = ["spec-extractor", "codec-verifier", "payload-triage", "rollout-guardian", "fleet-copilot", "anomaly-sentinel", "integration-builder"] as const;
const AgentRunBody = z.record(z.unknown());

function checkCondition(c: string | undefined) {
  if (!c) return;
  try {
    compileExpression(c);
  } catch (err) {
    throw badRequest(`Invalid condition: ${(err as Error).message}`);
  }
}

function redact(i: Integration): Integration {
  const config = { ...i.config };
  for (const k of Object.keys(config)) if (/secret|token|password|apikey/i.test(k) && k !== "secretRef") config[k] = "••••";
  return { ...i, config };
}

export default async function rulesModule(app: FastifyInstance, { p }: { p: Platform }) {
  // ── Alerts ──
  app.get("/alerts", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = parse(AlertQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) (where.push("status = ?"), params.push(q.status));
    if (q.severity) (where.push("severity = ?"), params.push(q.severity));
    if (q.deviceId) (where.push("device_id = ?"), params.push(q.deviceId));
    if (q.category) (where.push("doc->>'category' = ?"), params.push(q.category));
    if (q.assetId) (where.push("doc->>'assetId' = ?"), params.push(q.assetId));
    return p.repos.alerts.list({ tenantIds: ctx.scope, where, params, limit: q.limit });
  });
  app.post<{ Params: { id: string } }>("/alerts/:id/ack", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.alerts.setStatus(req.params.id, ctx.scope, "acknowledged", ctx.actor);
  });
  app.post<{ Params: { id: string } }>("/alerts/:id/resolve", async (req) => {
    const ctx = await reqCtx(p, req);
    const { resolution } = parse(z.object({ resolution: z.string().max(1000).optional() }), req.body ?? {});
    return p.alerts.setStatus(req.params.id, ctx.scope, "resolved", ctx.actor, resolution);
  });

  // ── Alert rules (= automations whose actions raise alerts) ──
  app.get("/alert-rules", async (req) => {
    const ctx = await reqCtx(p, req);
    return (await p.repos.automations.list({ tenantIds: ctx.scope, orderBy: "created_at ASC" })).filter((a) => a.actions.some((x) => x.type === "alert"));
  });
  app.post("/alert-rules", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(AutomationBody, req.body);
    if (!b.actions.some((x) => x.type === "alert")) throw badRequest("An alert rule needs at least one alert action");
    checkCondition(b.condition);
    const a: Automation = { id: newId("aut"), tenantId: ctx.tenantId, name: b.name, enabled: b.enabled, trigger: b.trigger, actions: b.actions, stats: { runs: 0, failures: 0 }, createdAt: p.core.now().toISOString() };
    if (b.condition) a.condition = b.condition;
    await p.repos.automations.insert(a);
    p.automations.invalidate();
    await p.core.audit(ctx.tenantId, ctx.actor, "alert-rule.create", `automation:${a.id}`, { name: a.name });
    return reply.status(201).send(a);
  });

  // ── Automations ──
  app.get("/automations", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.repos.automations.list({ tenantIds: ctx.scope, orderBy: "created_at ASC" });
  });
  app.post("/automations", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(AutomationBody, req.body);
    checkCondition(b.condition);
    const a: Automation = { id: newId("aut"), tenantId: ctx.tenantId, name: b.name, enabled: b.enabled, trigger: b.trigger, actions: b.actions, stats: { runs: 0, failures: 0 }, createdAt: p.core.now().toISOString() };
    if (b.condition) a.condition = b.condition;
    await p.repos.automations.insert(a);
    p.automations.invalidate();
    await p.core.audit(ctx.tenantId, ctx.actor, "automation.create", `automation:${a.id}`, { name: a.name });
    return reply.status(201).send(a);
  });
  app.patch<{ Params: { id: string } }>("/automations/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.repos.automations.getScoped(req.params.id, ctx.scope);
    if (!a) throw notFound("automation", req.params.id);
    const patch = parse(AutomationPatch, req.body);
    checkCondition(patch.condition);
    const next: Automation = { ...a, ...patch } as Automation;
    await p.repos.automations.update(next);
    p.automations.invalidate();
    await p.core.audit(a.tenantId, ctx.actor, "automation.update", `automation:${a.id}`, patch as Record<string, unknown>);
    return next;
  });
  app.post<{ Params: { id: string } }>("/automations/:id/dry-run", async (req) => {
    const ctx = await reqCtx(p, req);
    const a = await p.repos.automations.getScoped(req.params.id, ctx.scope);
    if (!a) throw notFound("automation", req.params.id);
    const b = parse(DryRunBody, req.body);
    const d = await p.devices.getVisible(b.deviceId, ctx.scope);
    const override: { data?: Record<string, unknown>; message?: string } = {};
    if (b.data) override.data = b.data;
    if (b.message) override.message = b.message;
    return p.automations.dryRun(a, d, override);
  });

  // ── Integrations ──
  app.get("/integrations", async (req) => {
    const ctx = await reqCtx(p, req);
    return (await p.repos.integrations.list({ tenantIds: ctx.scope, orderBy: "created_at ASC" })).map(redact);
  });
  app.get<{ Params: { id: string } }>("/integrations/:id/deliveries", async (req) => {
    const ctx = await reqCtx(p, req);
    const i = await p.repos.integrations.getScoped(req.params.id, ctx.scope);
    if (!i) throw notFound("integration", req.params.id);
    return p.repos.deliveries.list(i.id);
  });
  app.post("/integrations", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const b = parse(IntegrationBody, req.body);
    const i: Integration = { id: newId("int"), tenantId: ctx.tenantId, kind: b.kind, name: b.name, enabled: b.enabled, events: b.events, config: b.config, stats: { delivered: 0, failed: 0 }, createdAt: p.core.now().toISOString() };
    await p.repos.integrations.insert(i);
    await p.core.audit(ctx.tenantId, ctx.actor, "integration.create", `integration:${i.id}`, { kind: i.kind, name: i.name });
    return reply.status(201).send(redact(i));
  });
  app.patch<{ Params: { id: string } }>("/integrations/:id", async (req) => {
    const ctx = await reqCtx(p, req);
    const i = await p.repos.integrations.getScoped(req.params.id, ctx.scope);
    if (!i) throw notFound("integration", req.params.id);
    const patch = parse(IntegrationPatch, req.body);
    const next: Integration = { ...i, ...patch, config: patch.config ? { ...i.config, ...patch.config } : i.config };
    await p.repos.integrations.update(next);
    await p.core.audit(i.tenantId, ctx.actor, "integration.update", `integration:${i.id}`, { ...patch, config: patch.config ? Object.keys(patch.config) : undefined });
    return redact(next);
  });
  app.post<{ Params: { id: string } }>("/integrations/:id/test", async (req) => {
    const ctx = await reqCtx(p, req);
    const i = await p.repos.integrations.getScoped(req.params.id, ctx.scope);
    if (!i) throw notFound("integration", req.params.id);
    const delivery = await p.integrations.testDelivery(i);
    await p.core.audit(i.tenantId, ctx.actor, "integration.test", `integration:${i.id}`, { status: delivery?.status });
    return { delivery, integration: redact((await p.repos.integrations.get(i.id)) ?? i) };
  });

  // ── Audit ──
  app.get("/audit", async (req) => {
    const ctx = await reqCtx(p, req);
    const q = parse(AuditQuery, req.query);
    return p.repos.audit.list(ctx.scope, q);
  });

  // ── Agents ──
  app.get("/agents", async (req) => p.agents.list((await reqCtx(p, req)).tenantId));
  app.get("/agents/runs", async (req) => p.agents.listRuns((await reqCtx(p, req)).tenantId));
  app.post<{ Params: { name: string } }>("/agents/:name/run", async (req, reply) => {
    const ctx = await reqCtx(p, req);
    const name = parse(z.enum(AGENTS), req.params.name) as AgentName;
    const input = parse(AgentRunBody, req.body ?? {});
    return reply.status(201).send(await p.agents.run(ctx.tenantId, name, input, ctx.actor));
  });
  app.get<{ Params: { id: string } }>("/agents/runs/:id", async (req) => p.agents.get((await reqCtx(p, req)).tenantId, req.params.id));
  app.post<{ Params: { id: string } }>("/agents/runs/:id/approve", async (req) => {
    const ctx = await reqCtx(p, req);
    return p.agents.approve(ctx.tenantId, req.params.id, ctx.actor);
  });
}

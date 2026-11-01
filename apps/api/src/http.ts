import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Platform } from "./platform";
import { DEFAULT_TENANT_ID } from "./context";
import { ApiError, badRequest } from "./errors";

export interface RequestCtx {
  tenantId: string;
  actor: string;
  /** Tenant ids visible to the caller (self + descendants). */
  scope: string[];
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export async function reqCtx(p: Platform, req: FastifyRequest): Promise<RequestCtx> {
  const tenantId = header(req, "x-tenant-id")?.trim() || DEFAULT_TENANT_ID;
  const tenants = await p.core.tenants();
  if (!tenants.some((t) => t.id === tenantId)) {
    p.core.invalidateTenants();
    if (!(await p.core.tenants()).some((t) => t.id === tenantId)) throw new ApiError(400, "UNKNOWN_TENANT", `Unknown tenant ${tenantId}`);
  }
  const actor = header(req, "x-actor")?.trim() || "user:demo";
  return { tenantId, actor, scope: await p.core.scope(tenantId) };
}

export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw badRequest(msg, r.error.issues);
  }
  return r.data;
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

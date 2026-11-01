import type { AuditEntry, Tenant, TimelineEvent, TimelineKind } from "@hash8/sdk-ts";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./config";
import type { Db } from "./db/db";
import type { Repos } from "./db/repos";
import type { EventBus } from "./bus/bus";
import type { LiveHub } from "./live/hub";
import type { CodecService } from "./codecs/codec-service";
import { newId } from "./util/ids";

export const DEFAULT_TENANT_ID = "tn_solution_demo";

/**
 * Shared core every service gets: config, storage, bus, live hub, clock and the
 * cross-cutting writers (audit + timeline) that every mutation goes through.
 */
export class Core {
  private tenantCache?: Tenant[];
  constructor(
    readonly config: AppConfig,
    readonly db: Db,
    readonly repos: Repos,
    readonly bus: EventBus,
    readonly live: LiveHub,
    readonly codecs: CodecService,
    readonly log: FastifyBaseLogger,
  ) {}

  now(): Date {
    return new Date();
  }

  async tenants(): Promise<Tenant[]> {
    this.tenantCache ??= await this.repos.tenants.list();
    return this.tenantCache;
  }
  invalidateTenants() {
    this.tenantCache = undefined;
  }

  /** Tenant ids visible to a tenant: itself plus descendants (solution → customers). */
  async scope(tenantId: string): Promise<string[]> {
    const all = await this.tenants();
    const out = [tenantId];
    for (let i = 0; i < out.length; i++) for (const t of all) if (t.parentId === out[i] && !out.includes(t.id)) out.push(t.id);
    return out;
  }

  async audit(tenantId: string, actor: string, action: string, target: string, detail?: Record<string, unknown>): Promise<AuditEntry> {
    const e: AuditEntry = { id: newId("aud"), tenantId, at: this.now().toISOString(), actor, action, target };
    if (detail) e.detail = detail;
    await this.repos.audit.insert(e);
    this.live.broadcast({ type: "audit", tenantId, payload: e });
    return e;
  }

  async timeline(tenantId: string, deviceId: string, kind: TimelineKind, title: string, detail?: Record<string, unknown>, at?: string): Promise<TimelineEvent> {
    const e: TimelineEvent = { id: newId("tl"), deviceId, at: at ?? this.now().toISOString(), kind, title };
    if (detail) e.detail = detail;
    await this.repos.timeline.insertMany([{ ...e, tenantId }]);
    return e;
  }
}

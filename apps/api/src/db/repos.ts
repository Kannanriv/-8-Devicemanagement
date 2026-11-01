import type {
  AgentRun,
  Asset,
  AssetAssociation,
  BulkJob,
  DeviceCredential,
  Alert,
  AuditEntry,
  Automation,
  Batch,
  CodecStatus,
  CodecVersionSummary,
  Command,
  ConfigTemplate,
  Device,
  DeviceMessage,
  DeviceModel,
  DeviceQuery,
  Firmware,
  Integration,
  OtaCampaign,
  Page,
  SpecImportJob,
  Tenant,
  TimelineEvent,
} from "@hash8/sdk-ts";
import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import type { Db } from "./db";
import { DocRepo } from "./doc-repo";
import { compact, iso, isoOpt, json } from "../util/rows";

// ── Repository interfaces (time-series + hot paths). Postgres/Timescale implement the same. ──

export interface DeviceRepository {
  get(id: string): Promise<Device | undefined>;
  getBySerial(serial: string): Promise<Device | undefined>;
  getMany(ids: string[]): Promise<Device[]>;
  list(scope: string[] | undefined, q: DeviceQuery): Promise<Page<Device>>;
  ids(scope: string[] | undefined, q: DeviceQuery): Promise<string[]>;
  insertMany(devices: Device[]): Promise<void>;
  update(device: Device): Promise<Device>;
  count(scope?: string[]): Promise<number>;
}

export interface MessageRepository {
  insertMany(msgs: StoredMessage[]): Promise<void>;
  listForDevice(deviceId: string, limit: number): Promise<DeviceMessage[]>;
  count24h(scope: string[] | undefined, now: Date): Promise<{ total: number; decoded: number }>;
  countForDeviceSince(deviceId: string, since: Date): Promise<{ total: number; errors: number }>;
}

export interface TimelineRepository {
  insertMany(events: (TimelineEvent & { tenantId: string })[]): Promise<void>;
  listForDevice(deviceId: string, limit: number, kinds?: string[]): Promise<TimelineEvent[]>;
}

export interface StoredMessage extends DeviceMessage {
  tenantId: string;
  codecId?: string;
}

export interface UnknownPayload {
  id: string;
  tenantId: string;
  deviceId?: string;
  serial?: string;
  receivedAt: string;
  transport: string;
  port?: number;
  topic?: string;
  payloadHex: string;
  codecId?: string;
  codecVersion?: string;
  reason: string;
  errors: unknown[];
  resolvedAt?: string;
  resolvedMessageId?: string;
}

export interface StoredCodec {
  codecId: string;
  version: string;
  tenantId: string;
  status: CodecStatus;
  spec: DeviceCodecSpec;
  summary: CodecVersionSummary;
}

// ── Implementations ──────────────────────────────────────────────────────────

export class TenantRepo {
  constructor(private db: Db) {}
  async list(): Promise<Tenant[]> {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM tenants ORDER BY created_at, id`);
    return rows.map(toTenant);
  }
  async get(id: string): Promise<Tenant | undefined> {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return rows[0] ? toTenant(rows[0]) : undefined;
  }
  async insert(t: Tenant): Promise<void> {
    await this.db.query(`INSERT INTO tenants (id, name, kind, parent_id, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`, [
      t.id,
      t.name,
      t.kind,
      t.parentId ?? null,
      t.createdAt,
    ]);
  }
}
function toTenant(r: Record<string, unknown>): Tenant {
  return compact({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as Tenant["kind"],
    parentId: (r.parent_id as string | null) ?? undefined,
    createdAt: iso(r.created_at),
  });
}

function deviceCols(d: Device): unknown[] {
  return [
    d.id,
    d.tenantId,
    d.oemTenantId,
    d.modelId,
    d.serial,
    d.udi,
    d.oem ?? "",
    d.organization ?? null,
    d.branch ?? null,
    d.assetId ?? null,
    d.lifecycle,
    d.health.connectivity,
    d.health.level ?? "normal",
    d.otaStatus ?? null,
    d.installedAt ?? null,
    d.firmwareVersion ?? null,
    d.tags,
    Math.round(d.health.score),
    d.health.lastSeenAt ?? null,
    [d.udi, d.serial, d.name, d.imei, d.sim?.iccid, d.site?.name, d.assetName, d.organization, d.branch, d.model, d.oem, d.id].filter(Boolean).join(" ").toLowerCase(),
    json(d),
    d.createdAt,
    d.updatedAt,
  ];
}
const DEVICE_COLS =
  "id, tenant_id, oem_tenant_id, model_id, serial, udi, oem, organization, branch, asset_id, lifecycle, connectivity, health_level, ota_status, installed_at, firmware_version, tags, health_score, last_seen_at, search, doc, created_at, updated_at";

const SORTS: Record<NonNullable<DeviceQuery["sort"]>, string> = {
  lastSeen: "last_seen_at DESC NULLS LAST, id",
  health: "health_score ASC, id",
  udi: "udi ASC, id",
  installedAt: "installed_at DESC NULLS LAST, id",
};

export class PgDeviceRepo implements DeviceRepository {
  constructor(private db: Db) {}
  async get(id: string) {
    const rows = await this.db.query<{ doc: Device }>(`SELECT doc FROM devices WHERE id = $1`, [id]);
    return rows[0]?.doc;
  }
  async getBySerial(serial: string) {
    const rows = await this.db.query<{ doc: Device }>(`SELECT doc FROM devices WHERE serial = $1`, [serial]);
    return rows[0]?.doc;
  }
  async getMany(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.db.query<{ doc: Device }>(`SELECT doc FROM devices WHERE id = ANY($1::text[])`, [ids]);
    return rows.map((r) => r.doc);
  }
  private filter(scope: string[] | undefined, q: DeviceQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (scope) {
      const s = p(scope);
      // owner OR manufacturer: OEMs keep visibility of devices they built.
      where.push(`(tenant_id = ANY(${s}::text[]) OR oem_tenant_id = ANY(${s}::text[]))`);
    }
    if (q.q) where.push(`search LIKE ${p(`%${q.q.toLowerCase()}%`)}`);
    if (q.organization) where.push(`organization = ${p(q.organization)}`);
    if (q.branch) where.push(`branch = ${p(q.branch)}`);
    if (q.oem) {
      const o = p(q.oem);
      where.push(`(oem = ${o} OR oem_tenant_id = ${o})`);
    }
    if (q.modelId) where.push(`model_id = ${p(q.modelId)}`);
    if (q.lifecycle) where.push(`lifecycle = ${p(q.lifecycle)}`);
    if (q.connectivity) where.push(`connectivity = ${p(q.connectivity)}`);
    if (q.health) where.push(`health_level = ${p(q.health)}`);
    if (q.tag) where.push(`tags @> ARRAY[${p(q.tag)}]::text[]`);
    if (q.firmwareVersion) where.push(`firmware_version = ${p(q.firmwareVersion)}`);
    if (q.assetId) where.push(`asset_id = ${p(q.assetId)}`);
    if (q.installedFrom) where.push(`installed_at >= ${p(q.installedFrom)}`);
    if (q.installedTo) where.push(`installed_at <= ${p(q.installedTo)}`);
    if (q.lastSeenBefore) where.push(`last_seen_at < ${p(q.lastSeenBefore)}`);
    if (q.lastSeenAfter) where.push(`last_seen_at >= ${p(q.lastSeenAfter)}`);
    return { where, params, p };
  }
  async list(scope: string[] | undefined, q: DeviceQuery): Promise<Page<Device>> {
    const { where, params, p } = this.filter(scope, q);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM devices ${whereSql}`, params))[0]?.n ?? 0;
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const pageWhere = [...where];
    let offset = 0;
    const sortSql = q.sort ? SORTS[q.sort] : "id";
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (c.startsWith("o:")) offset = Number(c.slice(2)) || 0;
      else pageWhere.push(`id > ${p(c)}`);
    }
    const rows = await this.db.query<{ doc: Device; id: string }>(
      `SELECT id, doc FROM devices ${pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : ""} ORDER BY ${sortSql} LIMIT ${p(limit + 1)}${offset ? ` OFFSET ${p(offset)}` : ""}`,
      params,
    );
    const items = rows.slice(0, limit).map((r) => r.doc);
    const page: Page<Device> = { items, total };
    if (rows.length > limit) page.cursor = encodeCursor(q.sort ? `o:${offset + limit}` : items[items.length - 1]!.id);
    return page;
  }
  async ids(scope: string[] | undefined, q: DeviceQuery): Promise<string[]> {
    const { where, params } = this.filter(scope, q);
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM devices ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
      params,
    );
    return rows.map((r) => r.id);
  }
  async insertMany(devices: Device[], chunk = 100) {
    for (let i = 0; i < devices.length; i += chunk) {
      const params: unknown[] = [];
      const tuples = devices.slice(i, i + chunk).map((d) => {
        const vals = deviceCols(d);
        return `(${vals.map((v) => (params.push(v), `$${params.length}`)).join(",")})`;
      });
      await this.db.query(`INSERT INTO devices (${DEVICE_COLS}) VALUES ${tuples.join(",")}`, params);
    }
  }
  async update(d: Device) {
    const vals = deviceCols(d);
    const cols = DEVICE_COLS.split(", ");
    const sets = cols.slice(1).map((c, i) => `${c} = $${i + 2}`);
    await this.db.query(`UPDATE devices SET ${sets.join(", ")} WHERE id = $1`, vals);
    return d;
  }
  async count(scope?: string[]) {
    const rows = scope
      ? await this.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM devices WHERE tenant_id = ANY($1::text[]) OR oem_tenant_id = ANY($1::text[])`,
          [scope],
        )
      : await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM devices`);
    return rows[0]?.n ?? 0;
  }
  /** Aggregates for FleetStats. */
  async stats(scope: string[] | undefined) {
    const rows = await this.db.query<{ total: number; online: number; offline: number; avg: number | null }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE connectivity = 'online')::int AS online,
              count(*) FILTER (WHERE connectivity = 'offline')::int AS offline,
              avg(health_score) FILTER (WHERE lifecycle IN ('activated','maintenance'))::float AS avg
         FROM devices ${scope ? "WHERE tenant_id = ANY($1::text[]) OR oem_tenant_id = ANY($1::text[])" : ""}`,
      scope ? [scope] : [],
    );
    return rows[0]!;
  }
}

export function encodeCursor(id: string) {
  return Buffer.from(id).toString("base64url");
}
export function decodeCursor(c: string) {
  return Buffer.from(c, "base64url").toString();
}

function toMessage(r: Record<string, unknown>): DeviceMessage {
  return compact({
    id: r.id as string,
    deviceId: r.device_id as string,
    receivedAt: iso(r.received_at),
    transport: r.transport as string,
    port: (r.port as number | null) ?? undefined,
    topic: (r.topic as string | null) ?? undefined,
    payloadHex: r.payload_hex as string,
    status: r.status as DeviceMessage["status"],
    message: (r.message as string | null) ?? undefined,
    data: (r.data as Record<string, unknown> | null) ?? undefined,
    warnings: (r.warnings as string[]) ?? [],
    errors: (r.errors as string[] | null) ?? undefined,
    codecVersion: (r.codec_version as string | null) ?? undefined,
  });
}

export class PgMessageRepo implements MessageRepository {
  constructor(private db: Db) {}
  async insertMany(msgs: StoredMessage[], chunk = 250) {
    for (let i = 0; i < msgs.length; i += chunk) {
      const params: unknown[] = [];
      const tuples = msgs.slice(i, i + chunk).map((m) => {
        const vals = [
          m.id,
          m.tenantId,
          m.deviceId,
          m.receivedAt,
          m.status,
          m.transport,
          m.port ?? null,
          m.topic ?? null,
          m.payloadHex,
          m.message ?? null,
          m.codecId ?? null,
          m.codecVersion ?? null,
          m.data ? json(m.data) : null,
          json(m.warnings ?? []),
          m.errors ? json(m.errors) : null,
        ];
        return `(${vals.map((v) => (params.push(v), `$${params.length}`)).join(",")})`;
      });
      await this.db.query(
        `INSERT INTO messages (id, tenant_id, device_id, received_at, status, transport, port, topic, payload_hex, message, codec_id, codec_version, data, warnings, errors) VALUES ${tuples.join(",")}`,
        params,
      );
    }
  }
  async listForDevice(deviceId: string, limit: number) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM messages WHERE device_id = $1 ORDER BY received_at DESC LIMIT $2`,
      [deviceId, limit],
    );
    return rows.map(toMessage);
  }
  async get(id: string) {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM messages WHERE id = $1`, [id]);
    return rows[0] ? toMessage(rows[0]) : undefined;
  }
  async updateDecoded(id: string, patch: { status: string; message?: string; data?: unknown; warnings: string[]; codecVersion?: string; codecId?: string }) {
    await this.db.query(
      `UPDATE messages SET status=$2, message=$3, data=$4, warnings=$5, errors=NULL, codec_version=$6, codec_id=$7 WHERE id=$1`,
      [id, patch.status, patch.message ?? null, patch.data ? json(patch.data) : null, json(patch.warnings), patch.codecVersion ?? null, patch.codecId ?? null],
    );
  }
  async count24h(scope: string[] | undefined, now: Date) {
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const rows = await this.db.query<{ total: number; decoded: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'decoded')::int AS decoded
         FROM messages WHERE received_at >= $1 ${scope ? "AND tenant_id = ANY($2::text[])" : ""}`,
      scope ? [since, scope] : [since],
    );
    return rows[0] ?? { total: 0, decoded: 0 };
  }
  async countForDeviceSince(deviceId: string, since: Date) {
    const rows = await this.db.query<{ total: number; errors: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'decoded')::int AS errors
         FROM messages WHERE device_id = $1 AND received_at >= $2`,
      [deviceId, since.toISOString()],
    );
    return rows[0] ?? { total: 0, errors: 0 };
  }
  /** Messages per device in the last hour, for the whole scope (health sweep). */
  async ratesSince(since: Date): Promise<Map<string, { total: number; errors: number }>> {
    const rows = await this.db.query<{ device_id: string; total: number; errors: number }>(
      `SELECT device_id, count(*)::int AS total, count(*) FILTER (WHERE status <> 'decoded')::int AS errors
         FROM messages WHERE received_at >= $1 GROUP BY device_id`,
      [since.toISOString()],
    );
    return new Map(rows.map((r) => [r.device_id, { total: r.total, errors: r.errors }]));
  }
}

function toUnknown(r: Record<string, unknown>): UnknownPayload {
  return compact({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    deviceId: (r.device_id as string | null) ?? undefined,
    serial: (r.serial as string | null) ?? undefined,
    receivedAt: iso(r.received_at),
    transport: r.transport as string,
    port: (r.port as number | null) ?? undefined,
    topic: (r.topic as string | null) ?? undefined,
    payloadHex: r.payload_hex as string,
    codecId: (r.codec_id as string | null) ?? undefined,
    codecVersion: (r.codec_version as string | null) ?? undefined,
    reason: r.reason as string,
    errors: (r.errors as unknown[]) ?? [],
    resolvedAt: isoOpt(r.resolved_at),
    resolvedMessageId: (r.resolved_message_id as string | null) ?? undefined,
  });
}

export class UnknownRepo {
  constructor(private db: Db) {}
  async insertMany(items: UnknownPayload[]) {
    for (const u of items) {
      await this.db.query(
        `INSERT INTO unknown_payloads (id, tenant_id, device_id, serial, received_at, transport, port, topic, payload_hex, codec_id, codec_version, reason, errors)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [u.id, u.tenantId, u.deviceId ?? null, u.serial ?? null, u.receivedAt, u.transport, u.port ?? null, u.topic ?? null, u.payloadHex, u.codecId ?? null, u.codecVersion ?? null, u.reason, json(u.errors)],
      );
    }
  }
  async list(scope: string[] | undefined, opts: { deviceId?: string; since?: string; limit?: number; includeResolved?: boolean } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (!opts.includeResolved) where.push("resolved_at IS NULL");
    if (scope) where.push(`tenant_id = ANY(${p(scope)}::text[])`);
    if (opts.deviceId) where.push(`device_id = ${p(opts.deviceId)}`);
    if (opts.since) where.push(`received_at >= ${p(opts.since)}`);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM unknown_payloads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT ${p(opts.limit ?? 200)}`,
      params,
    );
    return rows.map(toUnknown);
  }
  async countOpen(scope: string[] | undefined) {
    const rows = await this.db.query<{ n: number; devices: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT device_id)::int AS devices FROM unknown_payloads WHERE resolved_at IS NULL ${scope ? "AND tenant_id = ANY($1::text[])" : ""}`,
      scope ? [scope] : [],
    );
    return rows[0] ?? { n: 0, devices: 0 };
  }
  async resolve(id: string, messageId: string, at: string) {
    await this.db.query(`UPDATE unknown_payloads SET resolved_at = $2, resolved_message_id = $3 WHERE id = $1`, [id, at, messageId]);
  }
}

export class PgTimelineRepo implements TimelineRepository {
  constructor(private db: Db) {}
  async insertMany(events: (TimelineEvent & { tenantId: string })[], chunk = 250) {
    for (let i = 0; i < events.length; i += chunk) {
      const params: unknown[] = [];
      const tuples = events.slice(i, i + chunk).map((e) => {
        const vals = [e.id, e.tenantId, e.deviceId, e.at, e.kind, e.title, e.detail ? json(e.detail) : null];
        return `(${vals.map((v) => (params.push(v), `$${params.length}`)).join(",")})`;
      });
      await this.db.query(`INSERT INTO timeline (id, tenant_id, device_id, at, kind, title, detail) VALUES ${tuples.join(",")}`, params);
    }
  }
  async listForDevice(deviceId: string, limit: number, kinds?: string[]) {
    const rows = await this.db.query<Record<string, unknown>>(
      kinds?.length
        ? `SELECT * FROM timeline WHERE device_id = $1 AND kind = ANY($3::text[]) ORDER BY at DESC LIMIT $2`
        : `SELECT * FROM timeline WHERE device_id = $1 ORDER BY at DESC LIMIT $2`,
      kinds?.length ? [deviceId, limit, kinds] : [deviceId, limit],
    );
    return rows.map((r) =>
      compact({
        id: r.id as string,
        deviceId: r.device_id as string,
        at: iso(r.at),
        kind: r.kind as TimelineEvent["kind"],
        title: r.title as string,
        detail: (r.detail as Record<string, unknown> | null) ?? undefined,
      }),
    );
  }
}

export interface ConfigRow {
  deviceId: string;
  tenantId: string;
  desired: Record<string, unknown>;
  reported: Record<string, unknown>;
  templateId?: string;
  updatedAt: string;
}
export class ConfigRepo {
  constructor(private db: Db) {}
  async get(deviceId: string): Promise<ConfigRow | undefined> {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM device_configs WHERE device_id = $1`, [deviceId]);
    const r = rows[0];
    if (!r) return undefined;
    return compact({
      deviceId: r.device_id as string,
      tenantId: r.tenant_id as string,
      desired: (r.desired as Record<string, unknown>) ?? {},
      reported: (r.reported as Record<string, unknown>) ?? {},
      templateId: (r.template_id as string | null) ?? undefined,
      updatedAt: iso(r.updated_at),
    });
  }
  async upsert(c: ConfigRow) {
    await this.db.query(
      `INSERT INTO device_configs (device_id, tenant_id, desired, reported, template_id, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (device_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, desired = EXCLUDED.desired, reported = EXCLUDED.reported,
         template_id = EXCLUDED.template_id, updated_at = EXCLUDED.updated_at`,
      [c.deviceId, c.tenantId, json(c.desired), json(c.reported), c.templateId ?? null, c.updatedAt],
    );
  }
  async all(scope: string[] | undefined): Promise<ConfigRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM device_configs ${scope ? "WHERE tenant_id = ANY($1::text[])" : ""}`,
      scope ? [scope] : [],
    );
    return rows.map((r) =>
      compact({
        deviceId: r.device_id as string,
        tenantId: r.tenant_id as string,
        desired: (r.desired as Record<string, unknown>) ?? {},
        reported: (r.reported as Record<string, unknown>) ?? {},
        templateId: (r.template_id as string | null) ?? undefined,
        updatedAt: iso(r.updated_at),
      }),
    );
  }
}

export class CodecRepo {
  constructor(private db: Db) {}
  private map(r: Record<string, unknown>): StoredCodec {
    return {
      codecId: r.codec_id as string,
      version: r.version as string,
      tenantId: r.tenant_id as string,
      status: r.status as CodecStatus,
      spec: r.spec as DeviceCodecSpec,
      summary: r.summary as CodecVersionSummary,
    };
  }
  async get(codecId: string, version: string) {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM codec_versions WHERE codec_id = $1 AND version = $2`, [codecId, version]);
    return rows[0] ? this.map(rows[0]) : undefined;
  }
  async versions(codecId: string) {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM codec_versions WHERE codec_id = $1 ORDER BY created_at DESC`, [codecId]);
    return rows.map((r) => this.map(r)).sort((a, b) => compareSemver(b.version, a.version));
  }
  async latestPublished(codecId: string) {
    return (await this.versions(codecId)).find((v) => v.status === "published");
  }
  async list(scope: string[] | undefined) {
    const rows = await this.db.query<Record<string, unknown>>(
      scope
        ? `SELECT * FROM codec_versions WHERE tenant_id = ANY($1::text[])
             OR codec_id IN (SELECT codec_id FROM codec_access WHERE tenant_id = ANY($1::text[]))
           ORDER BY codec_id, created_at DESC`
        : `SELECT * FROM codec_versions ORDER BY codec_id, created_at DESC`,
      scope ? [scope] : [],
    );
    return rows.map((r) => this.map(r));
  }
  async hasAccess(codecId: string, scope: string[] | undefined) {
    if (!scope) return true;
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM codec_versions WHERE codec_id = $1 AND tenant_id = ANY($2::text[])
       UNION ALL SELECT count(*)::int FROM codec_access WHERE codec_id = $1 AND tenant_id = ANY($2::text[])`,
      [codecId, scope],
    );
    return rows.some((r) => r.n > 0);
  }
  async upsert(c: StoredCodec) {
    await this.db.query(
      `INSERT INTO codec_versions (codec_id, version, tenant_id, status, spec, summary, created_at, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (codec_id, version) DO UPDATE SET status = EXCLUDED.status, spec = EXCLUDED.spec, summary = EXCLUDED.summary, published_at = EXCLUDED.published_at`,
      [c.codecId, c.version, c.tenantId, c.status, json(c.spec), json(c.summary), c.summary.createdAt, c.summary.publishedAt ?? null],
    );
  }
  async grant(codecId: string, tenantId: string) {
    await this.db.query(`INSERT INTO codec_access (codec_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [codecId, tenantId]);
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (isNaN(Number(x)) ? x : Number(x)));
  const pb = b.split(/[.-]/).map((x) => (isNaN(Number(x)) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return i >= 3 ? 1 : -1; // release > prerelease
    if (y === undefined) return i >= 3 ? -1 : 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

export class AuditRepo {
  constructor(private db: Db) {}
  async insert(e: AuditEntry) {
    await this.insertMany([e]);
  }
  async insertMany(entries: AuditEntry[]) {
    for (const e of entries) {
      await this.db.query(`INSERT INTO audit (id, tenant_id, at, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        e.id,
        e.tenantId,
        e.at,
        e.actor,
        e.action,
        e.target,
        e.detail ? json(e.detail) : null,
      ]);
    }
  }
  async list(scope: string[] | undefined, q: { target?: string; actor?: string; action?: string; limit?: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (scope) where.push(`tenant_id = ANY(${p(scope)}::text[])`);
    if (q.target) where.push(`target = ${p(q.target)}`);
    if (q.actor) where.push(`actor = ${p(q.actor)}`);
    if (q.action) where.push(`action LIKE ${p(q.action.replace(/\*/g, "%"))}`);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ${p(Math.min(q.limit ?? 100, 1000))}`,
      params,
    );
    return rows.map(
      (r): AuditEntry =>
        compact({
          id: r.id as string,
          tenantId: r.tenant_id as string,
          at: iso(r.at),
          actor: r.actor as string,
          action: r.action as string,
          target: r.target as string,
          detail: (r.detail as Record<string, unknown> | null) ?? undefined,
        }),
    );
  }
}

export interface CampaignDevice {
  campaignId: string;
  deviceId: string;
  wave: number;
  status: "pending" | "updating" | "succeeded" | "failed" | "rolled_back";
  fromVersion?: string;
}
export class CampaignDeviceRepo {
  constructor(private db: Db) {}
  async insertMany(items: CampaignDevice[]) {
    for (let i = 0; i < items.length; i += 200) {
      const params: unknown[] = [];
      const tuples = items.slice(i, i + 200).map((c) => {
        const vals = [c.campaignId, c.deviceId, c.wave, c.status, c.fromVersion ?? null];
        return `(${vals.map((v) => (params.push(v), `$${params.length}`)).join(",")})`;
      });
      await this.db.query(
        `INSERT INTO campaign_devices (campaign_id, device_id, wave, status, from_version) VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING`,
        params,
      );
    }
  }
  async list(campaignId: string, wave?: number): Promise<CampaignDevice[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM campaign_devices WHERE campaign_id = $1 ${wave !== undefined ? "AND wave = $2" : ""} ORDER BY device_id`,
      wave !== undefined ? [campaignId, wave] : [campaignId],
    );
    return rows.map((r) =>
      compact({
        campaignId: r.campaign_id as string,
        deviceId: r.device_id as string,
        wave: r.wave as number,
        status: r.status as CampaignDevice["status"],
        fromVersion: (r.from_version as string | null) ?? undefined,
      }),
    );
  }
  async setStatus(campaignId: string, deviceIds: string[], status: CampaignDevice["status"]) {
    if (!deviceIds.length) return;
    await this.db.query(`UPDATE campaign_devices SET status = $3, updated_at = now() WHERE campaign_id = $1 AND device_id = ANY($2::text[])`, [
      campaignId,
      deviceIds,
      status,
    ]);
  }
}

export interface DeliveryRecord {
  id: string;
  integrationId: string;
  tenantId: string;
  event: string;
  status: "delivered" | "failed" | "pending";
  attempts: number;
  signature?: string;
  target?: string;
  body: unknown;
  response?: unknown;
  at: string;
}
export class DeliveryRepo {
  constructor(private db: Db) {}
  async insert(d: DeliveryRecord) {
    await this.db.query(
      `INSERT INTO integration_deliveries (id, integration_id, tenant_id, event, status, attempts, signature, target, body, response, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [d.id, d.integrationId, d.tenantId, d.event, d.status, d.attempts, d.signature ?? null, d.target ?? null, json(d.body), d.response === undefined ? null : json(d.response), d.at],
    );
  }
  async list(integrationId: string, limit = 50): Promise<DeliveryRecord[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM integration_deliveries WHERE integration_id = $1 ORDER BY at DESC LIMIT $2`,
      [integrationId, limit],
    );
    return rows.map((r) =>
      compact({
        id: r.id as string,
        integrationId: r.integration_id as string,
        tenantId: r.tenant_id as string,
        event: r.event as string,
        status: r.status as DeliveryRecord["status"],
        attempts: r.attempts as number,
        signature: (r.signature as string | null) ?? undefined,
        target: (r.target as string | null) ?? undefined,
        body: r.body,
        response: r.response ?? undefined,
        at: iso(r.at),
      }),
    );
  }
}

export class KvRepo {
  constructor(private db: Db) {}
  async get<T>(key: string): Promise<T | undefined> {
    const rows = await this.db.query<{ value: T }>(`SELECT value FROM kv WHERE key = $1`, [key]);
    return rows[0]?.value;
  }
  async set(key: string, value: unknown) {
    await this.db.query(`INSERT INTO kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, json(value)]);
  }
}

export class AssociationRepo {
  constructor(private db: Db) {}
  private map(r: Record<string, unknown>): AssetAssociation {
    return compact({
      id: r.id as string,
      assetId: r.asset_id as string,
      deviceId: r.device_id as string,
      role: r.role as AssetAssociation["role"],
      from: iso(r.from_at),
      to: isoOpt(r.to_at),
      reason: (r.reason as AssetAssociation["reason"] | null) ?? undefined,
      actor: r.actor as string,
    });
  }
  async insertMany(items: (AssetAssociation & { tenantId: string })[]) {
    for (const a of items) {
      await this.db.query(
        `INSERT INTO asset_associations (id, tenant_id, asset_id, device_id, role, from_at, to_at, reason, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.id, a.tenantId, a.assetId, a.deviceId, a.role, a.from, a.to ?? null, a.reason ?? null, a.actor],
      );
    }
  }
  async forAsset(assetId: string) {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM asset_associations WHERE asset_id = $1 ORDER BY from_at DESC, id`, [assetId]);
    return rows.map((r) => this.map(r));
  }
  async forDevice(deviceId: string) {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM asset_associations WHERE device_id = $1 ORDER BY from_at DESC, id`, [deviceId]);
    return rows.map((r) => this.map(r));
  }
  async openForDevice(deviceId: string) {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM asset_associations WHERE device_id = $1 AND to_at IS NULL`, [deviceId]);
    return rows[0] ? this.map(rows[0]) : undefined;
  }
  async close(id: string, at: string, reason?: string) {
    await this.db.query(`UPDATE asset_associations SET to_at = $2, reason = COALESCE($3, reason) WHERE id = $1`, [id, at, reason ?? null]);
  }
}

export type CredentialRecord = DeviceCredential & { tenantId: string; createdAt: string; certificatePem?: string };
export type BulkJobRecord = BulkJob & { tenantId: string };

export interface FirmwareRow extends Firmware {
  filePath?: string;
}
export interface SpecImportRecord extends SpecImportJob {
  tenantId: string;
  draft?: unknown;
  trace?: unknown;
  sheets?: unknown;
  agentRunId?: string;
}
export interface AgentRunRecord extends AgentRun {
  tenantId: string;
}

export function createRepos(db: Db) {
  return {
    db,
    tenants: new TenantRepo(db),
    models: new DocRepo<DeviceModel>(db, "models", { codec_id: (m) => m.codecId }),
    batches: new DocRepo<Batch>(db, "batches", { model_id: (b) => b.modelId }),
    devices: new PgDeviceRepo(db),
    messages: new PgMessageRepo(db),
    unknown: new UnknownRepo(db),
    timeline: new PgTimelineRepo(db),
    configs: new ConfigRepo(db),
    templates: new DocRepo<ConfigTemplate>(db, "config_templates", { model_id: (t) => t.modelId }),
    commands: new DocRepo<Command & { tenantId: string; expiresAt?: string }>(db, "commands", {
      device_id: (c) => c.deviceId,
      status: (c) => c.status,
      expires_at: (c) => c.expiresAt,
    }),
    codecs: new CodecRepo(db),
    specImports: new DocRepo<SpecImportRecord>(db, "spec_imports"),
    firmware: new DocRepo<FirmwareRow>(db, "firmware", {
      model_id: (f) => f.modelId,
      version: (f) => f.version,
      file_path: (f) => f.filePath,
    }),
    campaigns: new DocRepo<OtaCampaign>(db, "campaigns", { status: (c) => c.status }),
    campaignDevices: new CampaignDeviceRepo(db),
    alerts: new DocRepo<Alert>(db, "alerts", {
      device_id: (a) => a.deviceId,
      status: (a) => a.status,
      severity: (a) => a.severity,
    }),
    automations: new DocRepo<Automation>(db, "automations"),
    integrations: new DocRepo<Integration>(db, "integrations"),
    deliveries: new DeliveryRepo(db),
    audit: new AuditRepo(db),
    agentRuns: new DocRepo<AgentRunRecord>(db, "agent_runs", { agent: (r) => r.agent }),
    kv: new KvRepo(db),
    assets: new DocRepo<Asset>(db, "assets", {
      type: (a) => a.type,
      organization: (a) => a.organization,
      branch: (a) => a.branch,
      search: (a) => [a.name, a.serial, a.make, a.model, a.type, a.site?.name, a.id].filter(Boolean).join(" ").toLowerCase(),
    }),
    associations: new AssociationRepo(db),
    credentials: new DocRepo<CredentialRecord>(db, "credentials", {
      device_id: (c) => c.deviceId,
      revoked_at: (c) => c.revokedAt,
      expires_at: (c) => c.expiresAt,
    }),
    bulkJobs: new DocRepo<BulkJobRecord>(db, "bulk_jobs"),
  };
}
export type Repos = ReturnType<typeof createRepos>;

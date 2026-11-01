import type { FleetReport, FleetStats, InventoryKpis, LifecycleState, OpsItem } from "@hash8/sdk-ts";
import { LIFECYCLE_TRANSITIONS } from "@hash8/sdk-ts";
import { buildOpsInbox, computeInventoryKpis, diffConfig } from "@hash8/ops-engine";
import type { Core } from "../context";

const DEVICE_SCOPE = "(tenant_id = ANY($1::text[]) OR oem_tenant_id = ANY($1::text[]))";

export class StatsService {
  constructor(private core: Core) {}

  async fleetStats(tenantId: string): Promise<FleetStats> {
    const scope = await this.core.scope(tenantId);
    const now = this.core.now();
    const [d, m, campaigns, alerts] = await Promise.all([
      this.core.repos.devices.stats(scope),
      this.core.repos.messages.count24h(scope, now),
      this.core.repos.campaigns.count({ tenantIds: scope, where: ["status = ?"], params: ["running"] }),
      this.core.repos.alerts.count({ tenantIds: scope, where: ["status <> ?"], params: ["resolved"] }),
    ]);
    return {
      devices: d.total,
      online: d.online,
      offline: d.offline,
      messages24h: m.total,
      decodeRate: m.total ? Math.round((m.decoded / m.total) * 1000) / 1000 : 1,
      avgHealth: Math.round(d.avg ?? 0),
      activeCampaigns: campaigns,
      openAlerts: alerts,
    };
  }

  async inbox(tenantId: string): Promise<OpsItem[]> {
    const scope = await this.core.scope(tenantId);
    const db = this.core.db;
    const soon = new Date(this.core.now().getTime() + 30 * 86_400_000).toISOString();
    const [campaigns, openAlerts, unknownRows, connRows, pending, simRows, certs, specReviews, configs] = await Promise.all([
      this.core.repos.campaigns.list({ tenantIds: scope, where: ["status IN ('running','paused','rolled_back','failed')"], limit: 50 }),
      this.core.repos.alerts.list({ tenantIds: scope, where: ["status = 'open'"], limit: 200 }),
      db.query<{ codec_id: string | null; n: number }>(
        `SELECT codec_id, count(*)::int AS n FROM unknown_payloads WHERE resolved_at IS NULL AND tenant_id = ANY($1::text[]) GROUP BY codec_id`,
        [scope],
      ),
      db.query<{ model_id: string; connectivity: string; n: number }>(
        `SELECT model_id, connectivity, count(*)::int AS n FROM devices
          WHERE connectivity IN ('offline','stale') AND lifecycle = 'activated' AND ${DEVICE_SCOPE} GROUP BY 1, 2`,
        [scope],
      ),
      db.query<{ n: number; overdue: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE updated_at < now() - interval '48 hours')::int AS overdue
           FROM devices WHERE lifecycle = 'pending_activation' AND ${DEVICE_SCOPE}`,
        [scope],
      ),
      db.query<{ status: string; n: number }>(
        `SELECT CASE WHEN (doc->'sim'->>'usageMbMonth')::float > (doc->'sim'->>'planLimitMb')::float THEN 'over_plan' ELSE doc->'sim'->>'status' END AS status,
                count(*)::int AS n
           FROM devices WHERE lifecycle IN ('activated','maintenance','pending_activation') AND doc ? 'sim' AND ${DEVICE_SCOPE}
            AND (doc->'sim'->>'status' IN ('suspended','terminated','unknown','inactive')
                 OR (doc->'sim'->>'usageMbMonth')::float > (doc->'sim'->>'planLimitMb')::float)
          GROUP BY 1`,
        [scope],
      ),
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM credentials WHERE tenant_id = ANY($1::text[]) AND revoked_at IS NULL AND expires_at <= $2`,
        [scope, soon],
      ),
      this.core.repos.specImports.count({ tenantIds: scope, where: ["doc->>'status' = 'review'"] }),
      this.core.repos.configs.all(scope),
    ]);
    const unknownByCodec: Record<string, number> = {};
    for (const r of unknownRows) unknownByCodec[r.codec_id ?? "unassigned"] = r.n;
    const offlineByModel: Record<string, number> = {};
    const staleByModel: Record<string, number> = {};
    for (const r of connRows) (r.connectivity === "offline" ? offlineByModel : staleByModel)[r.model_id] = r.n;
    const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0);
    const simByStatus: Record<string, number> = {};
    for (const r of simRows) simByStatus[r.status] = r.n;
    return buildOpsInbox(
      {
        campaigns,
        unknownPayloadCount: unknownRows.reduce((s, r) => s + r.n, 0),
        unknownByCodec,
        offlineDevices: { count: sum(offlineByModel), byModel: offlineByModel },
        staleDevices: { count: sum(staleByModel), byModel: staleByModel },
        pendingActivation: { count: pending[0]?.n ?? 0, overdue: pending[0]?.overdue ?? 0 },
        simIssues: { count: sum(simByStatus), byStatus: simByStatus },
        expiringCerts: certs[0]?.n ?? 0,
        pendingSpecReviews: specReviews,
        openAlerts,
        driftedConfigs: configs.filter((c) => Object.keys(c.desired).length && diffConfig(c.desired, c.reported).length).length,
      },
      this.core.now(),
    );
  }

  async inventoryKpis(tenantId: string): Promise<InventoryKpis> {
    const scope = await this.core.scope(tenantId);
    const ids = await this.core.repos.devices.ids(scope, {});
    const devices = await this.core.repos.devices.getMany(ids);
    const crit = await this.core.db.query<{ device_id: string }>(
      `SELECT DISTINCT device_id FROM alerts WHERE tenant_id = ANY($1::text[]) AND status = 'open' AND severity = 'critical' AND device_id IS NOT NULL`,
      [scope],
    );
    return computeInventoryKpis(devices, new Set(crit.map((r) => r.device_id)));
  }

  async lifecycleSummary(tenantId: string): Promise<Record<LifecycleState, number>> {
    const scope = await this.core.scope(tenantId);
    const rows = await this.core.db.query<{ lifecycle: LifecycleState; n: number }>(
      `SELECT lifecycle, count(*)::int AS n FROM devices WHERE ${DEVICE_SCOPE} GROUP BY lifecycle`,
      [scope],
    );
    const out = Object.fromEntries(Object.keys(LIFECYCLE_TRANSITIONS).map((k) => [k, 0])) as Record<LifecycleState, number>;
    for (const r of rows) out[r.lifecycle] = r.n;
    return out;
  }

  async trends(tenantId: string, days: number): Promise<{ at: string; online: number; messages: number; alerts: number }[]> {
    const scope = await this.core.scope(tenantId);
    const now = this.core.now();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000);
    const msgs = await this.core.db.query<{ day: string; n: number; devices: number }>(
      `SELECT to_char(date_trunc('day', received_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS n, count(DISTINCT device_id)::int AS devices
         FROM messages WHERE tenant_id = ANY($1::text[]) AND received_at >= $2 GROUP BY 1`,
      [scope, start.toISOString()],
    );
    const alerts = await this.core.db.query<{ day: string; n: number }>(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM alerts WHERE tenant_id = ANY($1::text[]) AND created_at >= $2 GROUP BY 1`,
      [scope, start.toISOString()],
    );
    const m = new Map(msgs.map((r) => [r.day, r]));
    const a = new Map(alerts.map((r) => [r.day, r.n]));
    const out: { at: string; online: number; messages: number; alerts: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      out.push({ at: d.toISOString(), online: m.get(key)?.devices ?? 0, messages: m.get(key)?.n ?? 0, alerts: a.get(key) ?? 0 });
    }
    return out;
  }

  async fleetReport(tenantId: string, from: Date, to: Date): Promise<FleetReport> {
    const scope = await this.core.scope(tenantId);
    const db = this.core.db;
    const p = [scope, from.toISOString(), to.toISOString()];
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
    const [fleet] = await db.query<{ activated: number; signal: number | null; usage: number | null }>(
      `SELECT count(*) FILTER (WHERE lifecycle IN ('activated','maintenance'))::int AS activated,
              avg((doc->'health'->>'signal')::float) AS signal,
              sum(coalesce((doc->'sim'->>'usageMbMonth')::float, 0)) AS usage
         FROM devices WHERE tenant_id = ANY($1::text[])`,
      [scope],
    );
    const activated = Math.max(1, fleet?.activated ?? 1);
    const daily = await db.query<{ day: string; devices: number }>(
      `SELECT to_char(date_trunc('day', received_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(DISTINCT device_id)::int AS devices
         FROM messages WHERE tenant_id = ANY($1::text[]) AND received_at >= $2 AND received_at < $3 GROUP BY 1 ORDER BY 1`,
      p,
    );
    const series = daily.map((r) => ({ at: `${r.day}T00:00:00.000Z`, onlinePct: Math.min(100, Math.round((r.devices / activated) * 1000) / 10) }));
    const uptimePct = series.length ? Math.round((series.reduce((s, x) => s + x.onlinePct, 0) / series.length) * 10) / 10 : 0;
    const [failures] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE tenant_id = ANY($1::text[]) AND created_at >= $2 AND created_at < $3 AND doc->>'category' = 'device_failure'`,
      p,
    );
    const [deploy] = await db.query<{ installs: number; started: number }>(
      `SELECT count(*) FILTER (WHERE detail->>'to' = 'activated')::int AS installs,
              count(*) FILTER (WHERE detail->>'to' = 'installing')::int AS started
         FROM timeline WHERE tenant_id = ANY($1::text[]) AND kind = 'lifecycle' AND at >= $2 AND at < $3`,
      p,
    );
    const [act] = await db.query<{ avg_h: number | null }>(
      `SELECT avg(extract(epoch FROM ((doc->>'activatedAt')::timestamptz - (doc->>'installedAt')::timestamptz)) / 3600)::float AS avg_h
         FROM devices WHERE tenant_id = ANY($1::text[]) AND doc ? 'activatedAt' AND doc ? 'installedAt'
          AND (doc->>'activatedAt')::timestamptz >= $2 AND (doc->>'activatedAt')::timestamptz < $3`,
      p,
    );
    const campaigns = await this.core.repos.campaigns.list({ tenantIds: scope, where: ["created_at >= ?", "created_at < ?"], params: [from.toISOString(), to.toISOString()] });
    let ok = 0;
    let bad = 0;
    for (const c of campaigns)
      for (const w of c.waves) {
        ok += w.succeeded;
        bad += w.failed;
      }
    const byCause = await db.query<{ k: string; n: number }>(
      `SELECT doc->>'category' AS k, count(*)::int AS n FROM alerts WHERE tenant_id = ANY($1::text[]) AND created_at >= $2 AND created_at < $3 GROUP BY 1`,
      p,
    );
    const byModel = await db.query<{ k: string; n: number }>(
      `SELECT d.model_id AS k, count(*)::int AS n FROM alerts a JOIN devices d ON d.id = a.device_id
        WHERE a.tenant_id = ANY($1::text[]) AND a.created_at >= $2 AND a.created_at < $3 AND a.severity <> 'info' GROUP BY 1`,
      p,
    );
    const byCarrier = await db.query<{ k: string; mb: number }>(
      `SELECT doc->'sim'->>'carrier' AS k, sum(coalesce((doc->'sim'->>'usageMbMonth')::float, 0))::float AS mb
         FROM devices WHERE tenant_id = ANY($1::text[]) AND doc ? 'sim' GROUP BY 1`,
      [scope],
    );
    const [util] = await db.query<{ total: number; decoded: number; devices: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'decoded')::int AS decoded, count(DISTINCT device_id)::int AS devices
         FROM messages WHERE tenant_id = ANY($1::text[]) AND received_at >= $2 AND received_at < $3`,
      p,
    );
    const report: FleetReport = {
      period: { from: from.toISOString(), to: to.toISOString() },
      reliability: { uptimePct, series },
      deployment: {
        installs: deploy?.installs ?? 0,
        successRate: deploy?.started ? Math.min(1, Math.round((deploy.installs / deploy.started) * 1000) / 1000) : 1,
        avgActivationHours: Math.round((act?.avg_h ?? 0) * 10) / 10,
      },
      ota: { campaigns: campaigns.length, successRate: ok + bad ? Math.round((ok / (ok + bad)) * 1000) / 1000 : 1, rollbacks: campaigns.filter((c) => c.status === "rolled_back").length },
      failures: { byCause: Object.fromEntries(byCause.map((r) => [r.k, r.n])), byModel: Object.fromEntries(byModel.map((r) => [r.k, r.n])) },
      connectivity: { dataUsageMb: Math.round(fleet?.usage ?? 0), byCarrier: Object.fromEntries(byCarrier.map((r) => [r.k, Math.round(r.mb)])) },
      utilization: {
        messages: util?.total ?? 0,
        decodeRate: util?.total ? Math.round((util.decoded / util.total) * 1000) / 1000 : 1,
        activeDevicesPct: Math.min(100, Math.round(((util?.devices ?? 0) / activated) * 1000) / 10),
      },
    };
    if (fleet?.signal != null) report.connectivity.avgSignal = Math.round(fleet.signal);
    if (failures?.n) report.reliability.mtbfHours = Math.round(((activated * days * 24) / failures.n) * 10) / 10;
    return report;
  }
}

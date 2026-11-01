import type {
  CatalogModel,
  CertificationLevel,
  CertificationRun,
  CodecRelease,
  EcosystemGraph,
  EcosystemOverview,
  EcosystemPartner,
} from "@hash8/sdk-ts";
import { isCertified, levelRank } from "./levels";

export interface CatalogQuery {
  q?: string;
  category?: string;
  protocol?: string;
  connectivity?: string;
  /** Minimum certification level. */
  level?: CertificationLevel;
  partnerId?: string;
}

const norm = (s: string) => s.toLowerCase();

/** Search + filter the catalog; certified models rank first, then by adoption. */
export function rankCatalog(models: CatalogModel[], query: CatalogQuery = {}): CatalogModel[] {
  const terms = (query.q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const minLevel = query.level ? levelRank(query.level) : -1;
  return models
    .filter((m) => {
      if (query.category && norm(m.category) !== norm(query.category)) return false;
      if (query.protocol && !m.protocols.some((p) => norm(p) === norm(query.protocol!))) return false;
      if (query.connectivity && !m.connectivity.some((p) => norm(p) === norm(query.connectivity!))) return false;
      if (query.partnerId && m.partnerId !== query.partnerId) return false;
      if (levelRank(m.certification.level) < minLevel) return false;
      if (terms.length) {
        const hay = norm([m.name, m.vendor, m.category, m.description, m.codecId ?? "", ...m.tags, ...m.protocols, ...m.connectivity].join(" "));
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        levelRank(b.certification.level) - levelRank(a.certification.level) ||
        b.adoption.devices - a.adoption.devices ||
        b.adoption.customers - a.adoption.customers ||
        a.name.localeCompare(b.name),
    );
}

export interface Adoption {
  tenantId: string;
  tenantName?: string;
  modelId: string;
  devices: number;
  adoptedAt?: string;
}
export interface GraphRelation {
  source: string;
  target: string;
  kind: string;
}

const modelNode = (id: string) => `model:${id}`;
const codecNode = (id: string) => `codec:${id}`;
const customerNode = (id: string) => `customer:${id}`;
const productNode = (id: string) => `product:${id}`;

/** Partner → model → codec → customer (+ #8 products and partner relations). */
export function buildEcosystemGraph(
  partners: EcosystemPartner[],
  models: CatalogModel[],
  adoptions: Adoption[],
  relations: GraphRelation[] = [],
): EcosystemGraph {
  const nodes = new Map<string, EcosystemGraph["nodes"][number]>();
  const links: EcosystemGraph["links"] = [];
  const linkKeys = new Set<string>();
  const size = (n: number, base: number) => Math.round((base + Math.sqrt(Math.max(0, n)) * 0.6) * 10) / 10;
  const node = (id: string, label: string, kind: EcosystemGraph["nodes"][number]["kind"], s: number) => {
    const ex = nodes.get(id);
    if (ex) ex.size = Math.max(ex.size, s);
    else nodes.set(id, { id, label, kind, size: s });
  };
  const link = (source: string, target: string, kind: string) => {
    const k = `${source}|${target}|${kind}`;
    if (linkKeys.has(k) || !nodes.has(source) || !nodes.has(target)) return;
    linkKeys.add(k);
    links.push({ source, target, kind });
  };

  for (const p of partners) node(p.id, p.name, "partner", size(p.modelsCount * 400, 14));
  const codecDevices = new Map<string, number>();
  for (const m of models) {
    node(modelNode(m.id), m.name, "model", size(m.adoption.devices, 8));
    link(m.partnerId, modelNode(m.id), "lists");
    if (m.codecId) codecDevices.set(m.codecId, (codecDevices.get(m.codecId) ?? 0) + m.adoption.devices);
  }
  for (const [c, d] of codecDevices) node(codecNode(c), c, "codec", size(d, 7));
  for (const m of models) {
    if (m.codecId) link(modelNode(m.id), codecNode(m.codecId), "decoded-by");
    for (const e of m.compatibility) {
      if (e.kind !== "hash8-product" || e.status !== "certified") continue;
      node(productNode(e.target), e.label, "product", 16);
      link(modelNode(m.id), productNode(e.target), "integrates");
    }
  }
  const byModel = new Map(models.map((m) => [m.id, m]));
  const custDevices = new Map<string, { name: string; devices: number }>();
  for (const a of adoptions) {
    if (!byModel.has(a.modelId)) continue;
    const c = custDevices.get(a.tenantId) ?? { name: a.tenantName ?? a.tenantId, devices: 0 };
    c.devices += a.devices;
    custDevices.set(a.tenantId, c);
  }
  for (const [id, c] of custDevices) node(customerNode(id), c.name, "customer", size(c.devices, 9));
  for (const a of adoptions) {
    const m = byModel.get(a.modelId);
    if (!m) continue;
    if (m.codecId) link(codecNode(m.codecId), customerNode(a.tenantId), "subscribed");
    else link(modelNode(m.id), customerNode(a.tenantId), "adopted");
  }
  for (const r of relations) {
    const resolve = (id: string) => (nodes.has(id) ? id : nodes.has(modelNode(id)) ? modelNode(id) : id);
    link(resolve(r.source), resolve(r.target), r.kind);
  }
  return { nodes: [...nodes.values()], links };
}

/** Headline KPIs for the ecosystem landing page. */
export function ecosystemOverview(
  partners: EcosystemPartner[],
  models: CatalogModel[],
  runs: Pick<CertificationRun, "status">[],
  releases: CodecRelease[],
  now: Date = new Date(),
): EcosystemOverview {
  const certified = models.filter((m) => isCertified(m.certification.level));
  const cutoff = now.getTime() - 30 * 86_400_000;
  return {
    partners: partners.length,
    oems: partners.filter((p) => p.kind === "oem").length,
    certifiedModels: certified.length,
    catalogModels: models.length,
    codecs: new Set(models.map((m) => m.codecId).filter(Boolean)).size,
    pluginDownloads: models.reduce((s, m) => s + m.adoption.pluginDownloads, 0),
    devicesOnCertifiedModels: certified.reduce((s, m) => s + m.adoption.devices, 0),
    releases30d: releases.filter((r) => {
      const t = Date.parse(r.publishedAt);
      return t >= cutoff && t <= now.getTime();
    }).length,
    pendingCertifications: runs.filter((r) => r.status === "submitted" || r.status === "running").length,
  };
}

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  Alert,
  Asset,
  AssetAssociation,
  AuditEntry,
  Automation,
  ConfigTemplate,
  Connectivity,
  Device,
  DeviceModel,
  Integration,
  LifecycleState,
  SimInfo,
  Tenant,
  TimelineEvent,
} from "@hash8/sdk-ts";
import { parseSpec, type DeviceCodecSpec } from "@hash8/dcs-schema";
import type { Platform } from "../platform";
import { DEFAULT_TENANT_ID } from "../context";
import type { CredentialRecord, FirmwareRow, StoredMessage, UnknownPayload } from "../db/repos";
import { newId } from "../util/ids";
import { PayloadGenerator, rng } from "./generator";
import { expectedIntervalSec } from "../services/vitals";
import { makeUdi } from "../modules/inventory";

export const TENANTS = {
  acme: "tn_oem_acme",
  voltix: "tn_oem_voltix",
  envio: "tn_oem_envio",
  trackunit: "tn_oem_trackunit",
  ztr: "tn_oem_ztr",
  anova: "tn_oem_anova",
  solution: DEFAULT_TENANT_ID,
  metro: "tn_customer_metro",
  buildright: "tn_customer_buildright",
  coldchain: "tn_customer_coldchain",
} as const;

const ORGS = [
  { tenantId: TENANTS.metro, name: "Metro Utilities", share: 0.36 },
  { tenantId: TENANTS.buildright, name: "BuildRight Infra", share: 0.34 },
  { tenantId: TENANTS.coldchain, name: "ColdChain Logistics", share: 0.3 },
] as const;
type Org = (typeof ORGS)[number];
type OrgName = Org["name"];

const BRANCHES = [
  { name: "Chennai", lat: 13.0827, lng: 80.2707 },
  { name: "Bengaluru", lat: 12.9716, lng: 77.5946 },
  { name: "Hyderabad", lat: 17.385, lng: 78.4867 },
  { name: "Mumbai", lat: 19.076, lng: 72.8777 },
  { name: "Pune", lat: 18.5204, lng: 73.8567 },
  { name: "Delhi", lat: 28.6139, lng: 77.209 },
];
type Branch = (typeof BRANCHES)[number];

interface ModelSeed {
  model: Omit<DeviceModel, "createdAt">;
  specFile: string;
  prefix: string;
  firmware: string[];
  cellular: boolean;
  oemName: string;
}

const MODELS: ModelSeed[] = [
  { model: { id: "acme-gt200", tenantId: TENANTS.acme, vendor: "Acme Devices", name: "GT200 Asset Tracker", category: "tracker", protocols: ["mqtt", "nbiot"] }, specFile: "acme.tracker-gt200.json", prefix: "ACM-GT200", firmware: ["2.1.0", "2.2.0", "2.3.0"], cellular: true, oemName: "Acme Devices" },
  { model: { id: "trackunit-raw", tenantId: TENANTS.trackunit, vendor: "Trackunit", name: "Raw Telematics Unit", category: "tracker", protocols: ["mqtt", "lte-m"] }, specFile: "acme.tracker-gt200.json", prefix: "TU-RAW", firmware: ["2.2.0", "2.3.0"], cellular: true, oemName: "Trackunit" },
  { model: { id: "voltix-em3", tenantId: TENANTS.voltix, vendor: "Voltix Energy", name: "EM3 Three-Phase Meter", category: "energy-meter", protocols: ["mqtt"] }, specFile: "voltix.energy-em3.json", prefix: "VLX-EM3", firmware: ["1.3.0", "1.4.0"], cellular: true, oemName: "Voltix Energy" },
  { model: { id: "ztr-gentrack", tenantId: TENANTS.ztr, vendor: "ZTR Control Systems", name: "GenTrack Generator Monitor", category: "energy-meter", protocols: ["mqtt", "lte-m"] }, specFile: "voltix.energy-em3.json", prefix: "ZTR-GEN", firmware: ["1.3.0", "1.4.0"], cellular: true, oemName: "ZTR Control Systems" },
  { model: { id: "envio-th-sense", tenantId: TENANTS.envio, vendor: "Envio Sensors", name: "TH-Sense LoRaWAN", category: "environment-sensor", protocols: ["lorawan"] }, specFile: "envio.th-sense.json", prefix: "ENV-TH", firmware: ["1.0.0", "1.1.0"], cellular: false, oemName: "Envio Sensors" },
  { model: { id: "anova-coldtrack", tenantId: TENANTS.anova, vendor: "Anova Telemetry", name: "ColdTrack Cellular Probe", category: "environment-sensor", protocols: ["nbiot"] }, specFile: "envio.th-sense.json", prefix: "ANV-CT", firmware: ["1.0.0", "1.1.0"], cellular: true, oemName: "Anova Telemetry" },
];

/** Which models / asset types each organization operates. */
const ORG_FLEET: Record<OrgName, { modelId: string; assetType: string; make: string; weight: number }[]> = {
  "Metro Utilities": [
    { modelId: "voltix-em3", assetType: "meter-point", make: "Metro Grid", weight: 0.5 },
    { modelId: "ztr-gentrack", assetType: "generator", make: "Kirloskar", weight: 0.25 },
    { modelId: "acme-gt200", assetType: "truck", make: "Tata Motors", weight: 0.25 },
  ],
  "BuildRight Infra": [
    { modelId: "trackunit-raw", assetType: "excavator", make: "JCB", weight: 0.45 },
    { modelId: "ztr-gentrack", assetType: "generator", make: "Cummins", weight: 0.25 },
    { modelId: "acme-gt200", assetType: "truck", make: "Ashok Leyland", weight: 0.3 },
  ],
  "ColdChain Logistics": [
    { modelId: "envio-th-sense", assetType: "cold-room", make: "Blue Star", weight: 0.4 },
    { modelId: "anova-coldtrack", assetType: "cold-room", make: "Voltas", weight: 0.25 },
    { modelId: "acme-gt200", assetType: "truck", make: "Eicher", weight: 0.35 },
  ],
};
const ASSET_LABEL: Record<string, string> = { excavator: "Excavator", generator: "Generator", truck: "Truck", "cold-room": "Cold Room", "meter-point": "Meter Point" };
const ASSET_MODEL: Record<string, string> = { excavator: "JS205", generator: "125 kVA DG", truck: "LPT 1613", "cold-room": "CR-40", "meter-point": "LT 3-phase" };

const LIFECYCLE_MIX: [LifecycleState, number][] = [
  ["registered", 0.09],
  ["assigned", 0.05],
  ["installing", 0.04],
  ["pending_activation", 0.04],
  ["activated", 0.66],
  ["maintenance", 0.04],
  ["suspended", 0.03],
  ["swap", 0.02],
  ["retired", 0.03],
];
const PATH: LifecycleState[] = ["registered", "assigned", "installing", "pending_activation", "activated"];
const TECHS = ["Ravi Kumar", "Priya Sharma", "Arjun Nair", "Meena Iyer", "Sandeep Rao", "Farhan Sheikh"];
const CARRIERS: { carrier: string; weight: number; plan: string; limit: number; mcc: string }[] = [
  { carrier: "Airtel", weight: 0.34, plan: "Airtel IoT 1GB", limit: 1024, mcc: "445" },
  { carrier: "Jio", weight: 0.3, plan: "JioThings 500MB", limit: 500, mcc: "486" },
  { carrier: "Vodafone Idea", weight: 0.16, plan: "Vi Business IoT 500MB", limit: 500, mcc: "420" },
  { carrier: "1NCE", weight: 0.2, plan: "1NCE Lifetime 500MB", limit: 500, mcc: "901" },
];

/** Seeds the demo dataset once (idempotent: no-op when tenants exist). */
export async function seedIfEmpty(p: Platform): Promise<boolean> {
  const existing = await p.repos.tenants.list();
  const done = await p.repos.kv.get("seed");
  if (existing.length && done) return false;
  const t0 = Date.now();
  // Tenants without the completion marker = an interrupted seed: wipe and start over.
  const stats = existing.length ? await resetDemo(p) : await seed(p);
  p.core.log.info(`Seeded demo data in ${Date.now() - t0}ms: ${JSON.stringify(stats)}`);
  return true;
}

const WIPE_TABLES = [
  "asset_associations", "assets", "credentials", "bulk_jobs", "campaign_devices", "campaigns", "integration_deliveries", "integrations", "automations",
  "alerts", "audit", "agent_runs", "commands", "device_configs", "config_templates", "timeline", "unknown_payloads", "messages", "firmware",
  "spec_imports", "codec_access", "codec_versions", "devices", "batches", "models", "kv", "tenants",
];

/** Wipe all domain data (schema + migrations kept), then re-seed. */
export async function resetDemo(p: Platform) {
  await p.pipeline.drain();
  await p.db.exec(`TRUNCATE ${WIPE_TABLES.join(", ")} CASCADE`);
  if (p.config.db !== "memory" && existsSync(p.config.firmwareDir)) rmSync(p.config.firmwareDir, { recursive: true, force: true });
  p.core.invalidateTenants();
  p.codecs.invalidate();
  p.devices.invalidateModels();
  p.automations.invalidate();
  return seed(p);
}

function loadSpecs(dir: string): Map<string, DeviceCodecSpec> {
  const out = new Map<string, DeviceCodecSpec>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      out.set(f, parseSpec(JSON.parse(readFileSync(join(dir, f), "utf8"))));
    } catch {
      /* skip invalid sample */
    }
  }
  return out;
}

function pick<T>(items: [T, number][], r: number): T {
  let acc = 0;
  for (const [v, w] of items) {
    acc += w;
    if (r < acc) return v;
  }
  return items[items.length - 1]![0];
}
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const DAY = 86_400_000;
const HOUR = 3_600_000;

export async function seed(p: Platform) {
  const { repos, config } = p;
  const rand = rng(8);
  const R = (a: number, b: number) => a + rand() * (b - a);
  const choice = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const now = new Date();
  const nowMs = now.getTime();
  const iso = (ms: number) => new Date(Math.min(ms, nowMs)).toISOString();
  const created = iso(nowMs - 180 * DAY);

  // ── Tenants ──────────────────────────────────────────────────────────────
  const oemTenants = MODELS.filter((m, i, a) => a.findIndex((x) => x.model.tenantId === m.model.tenantId) === i);
  const tenants: Tenant[] = [
    ...oemTenants.map((m) => ({ id: m.model.tenantId, name: m.oemName, kind: "oem" as const, createdAt: created })),
    { id: TENANTS.solution, name: "#8 Demo Solutions", kind: "solution", createdAt: created },
    ...ORGS.map((o) => ({ id: o.tenantId, name: o.name, kind: "customer" as const, parentId: TENANTS.solution, createdAt: created })),
  ];
  for (const t of tenants) await repos.tenants.insert(t);
  p.core.invalidateTenants();

  // ── Codecs, models, firmware ───────────────────────────────────────────
  const specs = loadSpecs(config.specsDir);
  const gens = new Map<string, PayloadGenerator>();
  const models = new Map<string, DeviceModel>();
  const specByModel = new Map<string, DeviceCodecSpec>();
  const firmware = new Map<string, FirmwareRow[]>();
  const audit: AuditEntry[] = [];
  const published = new Set<string>();
  for (const ms of MODELS) {
    const spec = specs.get(ms.specFile);
    const model: DeviceModel = { ...ms.model, createdAt: created };
    if (spec) {
      model.codecId = spec.id;
      specByModel.set(model.id, spec);
      if (!published.has(spec.id)) {
        published.add(spec.id);
        const stored = await p.codecs.save(spec, ms.model.tenantId, "published", new Date(nowMs - 120 * DAY));
        audit.push({ id: newId("aud"), tenantId: ms.model.tenantId, at: iso(nowMs - 120 * DAY), actor: "user:oem-engineer", action: "codec.publish", target: `codec:${spec.id}@${spec.version}`, detail: { vectors: `${stored.summary.vectorsPassed}/${stored.summary.vectorsTotal}` } });
      }
      for (const t of [TENANTS.solution, ...ORGS.map((o) => o.tenantId), ms.model.tenantId]) await repos.codecs.grant(spec.id, t);
      const { codec } = await p.codecs.get(spec.id, spec.version);
      gens.set(model.id, new PayloadGenerator(spec, codec));
    }
    models.set(model.id, model);
    await repos.models.insert(model);
    const rows: FirmwareRow[] = [];
    for (const v of ms.firmware) {
      const bin = Buffer.from(`#8 demo firmware ${model.id} ${v}\n`.repeat(1024));
      rows.push(await p.firmware.create(ms.model.tenantId, { modelId: model.id, version: v, ...(spec ? { codecVersion: spec.version } : {}), releaseNotes: `${model.name} ${v}: stability and power improvements.` }, new Uint8Array(bin), "user:oem-release"));
    }
    firmware.set(model.id, rows);
  }

  // ── Config profiles (templates) with versions ─────────────────────────────
  const profiles = new Map<string, ConfigTemplate[]>();
  const addProfile = async (modelId: string, name: string, versions: Record<string, unknown>[]) => {
    const list: ConfigTemplate[] = versions.map((values, i) => ({ id: `cfgt_${modelId}_v${i + 1}`, tenantId: TENANTS.solution, modelId, name, version: i + 1, values, createdAt: iso(nowMs - (90 - i * 40) * DAY) }));
    await repos.templates.insertMany(list);
    profiles.set(modelId, list);
  };
  await addProfile("acme-gt200", "Fleet tracking", [{ interval: 120 }, { interval: 60 }]);
  await addProfile("trackunit-raw", "Construction telematics", [{ interval: 300 }, { interval: 180 }]);
  await addProfile("voltix-em3", "Meter standard", [{ reportInterval: 900, relay: "on" }, { reportInterval: 600, relay: "on" }]);
  await addProfile("ztr-gentrack", "Genset monitoring", [{ reportInterval: 600 }]);
  await addProfile("envio-th-sense", "Cold-chain standard", [{ interval: 15 }, { interval: 10 }]);
  await addProfile("anova-coldtrack", "Cold-chain cellular", [{ interval: 15 }]);

  // ── Devices ──────────────────────────────────────────────────────────────
  const total = config.seedDevices;
  const devices: Device[] = [];
  const timeline: (TimelineEvent & { tenantId: string })[] = [];
  const tl = (d: Device, at: number, kind: TimelineEvent["kind"], title: string, detail?: Record<string, unknown>) =>
    timeline.push({ id: newId("tl"), tenantId: d.tenantId, deviceId: d.id, at: iso(at), kind, title, ...(detail ? { detail } : {}) });
  const serials = new Map<string, number>();

  const makeDevice = (ms: ModelSeed, lifecycle: LifecycleState, org: Org | undefined, branch: Branch | undefined): Device => {
    const model = models.get(ms.model.id)!;
    const n = (serials.get(ms.prefix) ?? 1000) + 1;
    serials.set(ms.prefix, n);
    const serial = `${ms.prefix}-${String(n).padStart(6, "0")}`;
    const createdAtMs = nowMs - R(35, 120) * DAY;
    const d: Device = {
      id: `dev_${createHash("sha1").update(serial).digest("hex").slice(0, 12)}`,
      udi: makeUdi(model, serial),
      tenantId: org?.tenantId ?? TENANTS.solution,
      oemTenantId: model.tenantId,
      oem: model.vendor,
      modelId: model.id,
      model: model.name,
      serial,
      lifecycle,
      provisioning: lifecycle === "registered" ? pick([["provisioned", 0.6], ["flashed", 0.3], ["unprovisioned", 0.1]], rand()) : "provisioned",
      tags: [],
      health: { score: 0, level: "normal", connectivity: "never_seen", issues: ["Never communicated"] },
      shadow: {},
      createdAt: iso(createdAtMs),
      updatedAt: iso(createdAtMs),
    };
    if (model.codecId) d.codecId = model.codecId;
    const spec = specByModel.get(model.id);
    if (spec) d.codecVersion = spec.version;
    d.firmwareVersion = ms.firmware[Math.floor(rand() * ms.firmware.length)]!;
    if (ms.cellular) d.imei = `86${Math.floor(1e12 + rand() * 9e12)}`;
    if (org) d.organization = org.name;
    if (branch) {
      d.branch = branch.name;
      d.name = `${branch.name} ${model.category === "tracker" ? "Tracker" : model.category === "energy-meter" ? "Meter" : "Probe"} ${n - 1000}`;
    } else d.name = `${model.name} #${n - 1000}`;
    if (rand() < 0.15) d.tags.push("critical-site");
    if (rand() < 0.1) d.tags.push("pilot");
    return d;
  };

  for (let i = 0; i < total; i++) {
    const lifecycle = pick(LIFECYCLE_MIX, rand());
    if (lifecycle === "registered") {
      devices.push(makeDevice(choice(MODELS), lifecycle, undefined, undefined));
      continue;
    }
    const org = pick(ORGS.map((o) => [o, o.share] as [Org, number]), rand());
    const fleet = ORG_FLEET[org.name];
    const f = pick(fleet.map((x) => [x, x.weight] as [(typeof fleet)[number], number]), rand());
    const ms = MODELS.find((m) => m.model.id === f.modelId)!;
    devices.push(makeDevice(ms, lifecycle, org, choice(BRANCHES)));
  }

  // ── Lifecycle history, SIMs, connectivity targets ─────────────────────────
  const technicianOf = new Map<string, string>();
  const connTarget = new Map<string, Connectivity>();
  for (const d of devices) {
    const ms = MODELS.find((m) => m.model.id === d.modelId)!;
    let t = Date.parse(d.createdAt);
    tl(d, t, "lifecycle", "Registered in inventory", { to: "registered", actor: "user:warehouse" });
    if (ms.cellular) d.sim = makeSim(rand);
    const target = ["maintenance", "suspended", "swap", "retired"].includes(d.lifecycle) ? "activated" : d.lifecycle;
    const steps = PATH.slice(1, PATH.indexOf(target) + 1);
    const tech = choice(TECHS);
    technicianOf.set(d.id, tech);
    for (const s of steps) {
      t += s === "assigned" ? R(3, 15) * DAY : s === "installing" ? R(1, 6) * DAY : s === "pending_activation" ? R(2, 8) * HOUR : R(1, 40) * HOUR;
      if (t > nowMs - HOUR) t = nowMs - R(1, 5) * HOUR;
      if (s === "assigned") tl(d, t - 1000, "ownership", `Ownership transferred to ${d.organization}`, { from: TENANTS.solution, to: d.tenantId, actor: "user:ops-lead" });
      if (s === "installing") {
        d.installedAt = iso(t);
        tl(d, t, "technician", `${tech} started installation`, { technician: tech, branch: d.branch, workOrder: `WO-${Math.floor(R(10000, 99999))}` });
      }
      if (s === "pending_activation") tl(d, t - 60_000, "technician", `${tech} completed installation — photos & checklist uploaded`, { technician: tech, checklist: "passed" });
      if (s === "activated") d.activatedAt = iso(t);
      tl(d, t, "lifecycle", `Lifecycle → ${s}`, { to: s, actor: s === "activated" ? "system" : `user:${tech.split(" ")[0]!.toLowerCase()}` });
    }
    if (["maintenance", "suspended", "swap", "retired"].includes(d.lifecycle)) {
      t = Math.max(t + DAY, nowMs - R(1, 12) * DAY);
      const why = d.lifecycle === "maintenance" ? "scheduled maintenance" : d.lifecycle === "suspended" ? "customer contract on hold" : d.lifecycle === "swap" ? "faulty unit replaced" : "end of life";
      tl(d, t, "lifecycle", `Lifecycle → ${d.lifecycle}`, { to: d.lifecycle, note: why, actor: "user:ops-lead" });
      if (d.lifecycle === "maintenance") tl(d, t + HOUR, "technician", `${tech} on site: ${choice(["antenna re-seated", "battery pack replaced", "wiring harness inspection", "enclosure resealed"])}`, { technician: tech });
    }
    d.updatedAt = iso(t);
    let c: Connectivity = "never_seen";
    if (d.lifecycle === "activated") c = pick<Connectivity>([["online", 0.68], ["stale", 0.12], ["offline", 0.14], ["never_seen", 0.06]], rand());
    else if (d.lifecycle === "maintenance") c = pick<Connectivity>([["stale", 0.4], ["offline", 0.4], ["online", 0.2]], rand());
    else if (d.lifecycle === "pending_activation") c = rand() < 0.35 ? "online" : "never_seen";
    else if (["suspended", "swap", "retired"].includes(d.lifecycle)) c = "offline";
    connTarget.set(d.id, c);
    if (d.sim) {
      if (d.lifecycle === "activated" || d.lifecycle === "maintenance") d.sim = { ...d.sim, status: rand() < 0.03 ? "suspended" : "active", activatedAt: d.activatedAt ?? d.updatedAt };
      else if (d.lifecycle === "suspended") d.sim = { ...d.sim, status: "suspended", activatedAt: d.activatedAt ?? d.updatedAt };
      else if (d.lifecycle === "retired") d.sim = { ...d.sim, status: "terminated" };
      else if (d.lifecycle === "swap") d.sim = { ...d.sim, status: "active", activatedAt: d.activatedAt ?? d.updatedAt };
      if (d.sim.status === "active") {
        const heavy = d.modelId === "acme-gt200" || d.modelId === "trackunit-raw";
        d.sim.usageMbMonth = rand() < 0.04 ? Math.round((d.sim.planLimitMb ?? 500) * R(1.05, 1.4)) : Math.round(R(heavy ? 120 : 15, heavy ? 650 : 160) * 10) / 10;
      }
    }
  }

  // ── Assets & associations (incl. swap history) ───────────────────────────
  const assets: Asset[] = [];
  const associations: (AssetAssociation & { tenantId: string })[] = [];
  const deployed = devices.filter((d) => !["registered", "retired"].includes(d.lifecycle));
  const assetTarget = Math.round(total * 0.4);
  const assetCounters = new Map<string, number>();
  for (const d of deployed) {
    const fleet = ORG_FLEET[d.organization as OrgName];
    const f = fleet?.find((x) => x.modelId === d.modelId) ?? fleet?.[0];
    if (!f || !d.branch) continue;
    const sameKind = assets.filter((a) => a.organization === d.organization && a.type === f.assetType && a.branch === d.branch);
    let asset: Asset;
    if (assets.length < assetTarget || !sameKind.length) {
      const k = (assetCounters.get(f.assetType) ?? 0) + 1;
      assetCounters.set(f.assetType, k);
      const branch = BRANCHES.find((b) => b.name === d.branch)!;
      const code = d.branch.slice(0, 3).toUpperCase();
      asset = {
        id: `ast_${createHash("sha1").update(`${f.assetType}-${k}-${d.organization}`).digest("hex").slice(0, 10)}`,
        tenantId: d.tenantId,
        name: f.assetType === "meter-point" ? `MP-${code}-${String(k).padStart(4, "0")}` : `${ASSET_LABEL[f.assetType]} ${code}-${String(k).padStart(3, "0")}`,
        type: f.assetType,
        make: f.make,
        model: ASSET_MODEL[f.assetType] ?? "",
        serial: `${f.make.slice(0, 3).toUpperCase()}${Math.floor(R(100000, 999999))}`,
        organization: d.organization!,
        branch: d.branch,
        site: { name: `${d.branch} ${choice(["Depot", "Yard", "Substation", "Warehouse", "Site Office", "Hub"])}`, lat: round4(branch.lat + R(-0.12, 0.12)), lng: round4(branch.lng + R(-0.12, 0.12)) },
        deviceIds: [],
        createdAt: iso(Date.parse(d.createdAt) + DAY),
      };
      assets.push(asset);
    } else asset = choice(sameKind);
    const role: AssetAssociation["role"] = asset.deviceIds.length ? "secondary" : "primary";
    asset.deviceIds.push(d.id);
    d.assetId = asset.id;
    d.assetName = asset.name;
    if (asset.site) d.site = asset.site;
    const from = Date.parse(timeline.find((e) => e.deviceId === d.id && e.detail?.to === "assigned")?.at ?? d.createdAt);
    const assoc: AssetAssociation & { tenantId: string } = { id: newId("asc"), tenantId: d.tenantId, assetId: asset.id, deviceId: d.id, role, from: iso(from), reason: "install", actor: `user:${(technicianOf.get(d.id) ?? "ops").split(" ")[0]!.toLowerCase()}` };
    if (d.lifecycle === "swap") {
      const to = nowMs - R(1, 10) * DAY;
      associations.push({ ...assoc, to: iso(to), reason: "swap" });
      asset.deviceIds = asset.deviceIds.filter((x) => x !== d.id);
      delete d.assetId;
      delete d.assetName;
      tl(d, to, "association", `Swapped out of ${asset.name}`, { assetId: asset.id });
    } else {
      associations.push(assoc);
      tl(d, from + 60_000, "association", `Associated with ${asset.name} (${role})`, { assetId: asset.id, role });
    }
    if (asset.type === "excavator" || asset.type === "generator") d.health.engineHours = Math.round(R(250, 8200));
  }
  // Historical swaps: retired devices that once served an asset, replaced by the current unit.
  const retired = devices.filter((d) => d.lifecycle === "retired");
  for (const [i, old] of retired.entries()) {
    const target = assets.filter((a) => a.deviceIds.length && devices.find((x) => x.id === a.deviceIds[0])?.modelId === old.modelId)[i];
    if (!target) continue;
    const current = devices.find((x) => x.id === target.deviceIds[0])!;
    old.organization = target.organization!;
    old.branch = target.branch!;
    old.tenantId = current.tenantId;
    const from = Date.parse(old.createdAt) + 5 * DAY;
    const to = Math.max(from + 20 * DAY, Date.parse(current.installedAt ?? current.createdAt));
    associations.push({ id: newId("asc"), tenantId: old.tenantId, assetId: target.id, deviceId: old.id, role: "primary", from: iso(from), to: iso(to), reason: "swap", actor: "user:ops-lead" });
    const currentAssoc = associations.find((a) => a.deviceId === current.id && !a.to);
    if (currentAssoc) currentAssoc.reason = "swap";
    tl(old, to, "association", `Swapped out of ${target.name} — replaced by ${current.udi}`, { assetId: target.id, newDeviceId: current.id });
    tl(current, to + 60_000, "association", `Swapped into ${target.name} replacing ${old.udi}`, { assetId: target.id, oldDeviceId: old.id });
  }
  for (const e of timeline) e.tenantId = devices.find((d) => d.id === e.deviceId)?.tenantId ?? e.tenantId;

  // ── 30 days of history: messages ENCODED with the real codecs ─────────────
  const talking = devices.filter((d) => connTarget.get(d.id) !== "never_seen");
  const perDevice = Math.max(4, Math.round(config.seedMessages / Math.max(1, talking.length)));
  const messages: StoredMessage[] = [];
  const unknown: UnknownPayload[] = [];
  for (const d of talking) {
    const model = models.get(d.modelId)!;
    const gen = gens.get(model.id);
    if (!gen?.usable) continue;
    const interval = expectedIntervalSec(model.category) * 1000;
    const c = connTarget.get(d.id)!;
    const activeFrom = Math.max(nowMs - 30 * DAY, Date.parse(d.activatedAt ?? d.installedAt ?? d.createdAt));
    let lastSeen =
      c === "online" ? nowMs - R(0.05, 0.85) * interval
      : c === "stale" ? nowMs - R(1.2, 2.8) * interval
      : d.lifecycle === "retired" ? Date.parse(d.updatedAt) - R(1, 5) * DAY
      : nowMs - R(5 * interval, 9 * DAY);
    if (c !== "online" && c !== "stale") lastSeen = Math.max(lastSeen, activeFrom + HOUR);
    if (lastSeen > nowMs) lastSeen = nowMs - 60_000;
    const n = d.lifecycle === "activated" ? perDevice : Math.ceil(perDevice / 2);
    const times: number[] = [];
    for (let k = 0; k < Math.min(6, n); k++) times.push(lastSeen - k * interval * R(0.9, 1.1));
    for (let k = times.length; k < n; k++) times.push(R(Math.min(activeFrom, lastSeen - DAY), lastSeen));
    times.sort((a, b) => a - b);
    const phase0 = rand() < 0.12 ? R(0.85, 1) : R(0, 0.6);
    const anomalous = rand() < 0.06;
    const batch: StoredMessage[] = [];
    for (const [k, at] of times.entries()) {
      const up = gen.next({ serial: d.serial, ...(d.site?.lat !== undefined ? { lat: d.site.lat, lng: d.site.lng! } : {}), phase: Math.min(1, phase0 + (k / n) * 0.08), anomaly: anomalous && rand() < 0.15 }, rand);
      const m: StoredMessage = { id: newId("msg"), tenantId: d.tenantId, deviceId: d.id, receivedAt: iso(at), transport: model.protocols.includes("lorawan") ? "lorawan" : "mqtt", payloadHex: up.hex, status: "decoded", message: up.message, data: up.data, warnings: [], codecId: d.codecId!, codecVersion: d.codecVersion! };
      if (up.port !== undefined) m.port = up.port;
      if (up.topic !== undefined) m.topic = up.topic;
      batch.push(m);
    }
    if (!batch.length) continue;
    if (rand() < 0.07) {
      const at = R(lastSeen - 5 * DAY, lastSeen);
      const u: UnknownPayload = { id: newId("msg"), tenantId: d.tenantId, deviceId: d.id, serial: d.serial, receivedAt: iso(at), transport: "mqtt", payloadHex: `ee${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0")}0a${Math.floor(rand() * 0xffff).toString(16).padStart(4, "0")}`, port: 77, codecId: d.codecId!, codecVersion: d.codecVersion!, reason: "no_matching_message", errors: [{ code: "NO_MATCHING_MESSAGE", message: "No uplink message matches the payload" }] };
      unknown.push(u);
      messages.push({ id: u.id, tenantId: d.tenantId, deviceId: d.id, receivedAt: u.receivedAt, transport: u.transport, port: 77, payloadHex: u.payloadHex, status: "unknown", warnings: [], errors: ["NO_MATCHING_MESSAGE: No uplink message matches the payload"], codecId: d.codecId!, codecVersion: d.codecVersion! });
    }
    for (const m of batch) d.shadow = { ...d.shadow, ...m.data };
    const last = batch[batch.length - 1]!;
    d.health = { ...d.health, lastSeenAt: last.receivedAt, lastHeartbeatAt: last.receivedAt };
    const withGps = [...batch].reverse().find((m) => typeof m.data?.lat === "number" && typeof m.data?.lng === "number");
    if (withGps?.data) d.health.gps = { lat: withGps.data.lat as number, lng: withGps.data.lng as number, at: withGps.receivedAt, fix: (withGps.data.flags as { gpsFix?: boolean } | undefined)?.gpsFix ?? true };
    const hourAgo = nowMs - HOUR;
    d.health = await p.devices.healthFor(d, now, { total: batch.filter((m) => Date.parse(m.receivedAt) >= hourAgo).length, errors: 0 });
    messages.push(...batch);
    for (const m of batch.slice(-4)) tl(d, Date.parse(m.receivedAt), "message", `${m.message} via ${m.transport}`, { messageId: m.id });
  }
  for (let i = 0; i < 6; i++) {
    unknown.push({ id: newId("msg"), tenantId: TENANTS.solution, serial: `UNREG-${Math.floor(R(1000, 9999))}`, receivedAt: iso(nowMs - R(1, 72) * HOUR), transport: "udp", payloadHex: Math.floor(rand() * 0xffffffffff).toString(16).padStart(10, "0"), reason: "unknown_device", errors: [] });
  }

  // ── Config versions + drift ────────────────────────────────────────────
  const configRows: Parameters<typeof repos.configs.upsert>[0][] = [];
  for (const d of devices) {
    if (!["activated", "maintenance", "pending_activation", "suspended"].includes(d.lifecycle)) continue;
    const versions = profiles.get(d.modelId);
    if (!versions?.length) continue;
    const latest = versions[versions.length - 1]!;
    const tpl = versions.length > 1 && rand() < 0.2 ? versions[0]! : latest;
    d.configProfileId = tpl.id;
    d.configVersion = tpl.version;
    const drift = rand() < 0.14;
    const reported = !drift
      ? { ...tpl.values }
      : versions.length > 1 && tpl === latest
        ? { ...versions[0]!.values }
        : Object.fromEntries(Object.entries(tpl.values).map(([k, v]) => [k, typeof v === "number" ? v * 2 : v]));
    const at = Date.parse(d.activatedAt ?? d.updatedAt) + HOUR;
    configRows.push({ deviceId: d.id, tenantId: d.tenantId, desired: { ...tpl.values }, reported, templateId: tpl.id, updatedAt: iso(at) });
    tl(d, at, "config", `Config profile "${tpl.name}" v${tpl.version} applied`, { templateId: tpl.id, version: tpl.version, drift: drift ? Object.keys(tpl.values) : [] });
  }

  // ── Credentials (X.509 from the dev CA) ───────────────────────────────────
  const creds: CredentialRecord[] = [];
  for (const d of devices) {
    if (!["activated", "maintenance", "suspended", "swap", "pending_activation", "retired"].includes(d.lifecycle)) continue;
    const r = rand();
    let issuedAt = Date.parse(d.installedAt ?? d.createdAt);
    let days = 365;
    if (d.lifecycle !== "retired" && r < 0.05) {
      days = 90;
      issuedAt = nowMs - (90 - R(3, 25)) * DAY;
    } else if (d.lifecycle !== "retired" && r < 0.075) {
      days = 90;
      issuedAt = nowMs - (90 + R(2, 20)) * DAY;
    }
    const { record } = p.credentials.build(d, new Date(issuedAt), days);
    if (d.lifecycle === "retired") {
      record.revokedAt = d.updatedAt;
      record.revokedReason = "device retired";
      record.status = "revoked";
    } else if (d.lifecycle === "activated" && rand() < 0.012) {
      record.revokedAt = iso(nowMs - R(1, 6) * DAY);
      record.revokedReason = "key compromise suspected";
      record.status = "revoked";
      tl(d, Date.parse(record.revokedAt), "security", "Credential revoked: key compromise suspected", { credentialId: record.id });
    }
    creds.push(record);
    tl(d, issuedAt, "security", "X.509 credential issued", { fingerprint: record.fingerprint.slice(0, 23), expiresAt: record.expiresAt });
  }

  // ── Persist core inventory ───────────────────────────────────────────────
  await repos.devices.insertMany(devices);
  await repos.assets.insertMany(assets);
  await repos.associations.insertMany(associations);
  await repos.messages.insertMany(messages);
  await repos.unknown.insertMany(unknown);
  for (const c of configRows) await repos.configs.upsert(c);
  await repos.credentials.insertMany(creds);
  await repos.timeline.insertMany(timeline);

  // ── Integrations & automations ───────────────────────────────────────────
  const integ = (id: string, kind: Integration["kind"], name: string, events: string[], cfg: Record<string, unknown>, delivered: number): Integration => ({
    id, tenantId: TENANTS.solution, kind, name, enabled: true, events, config: cfg,
    stats: { delivered, failed: Math.floor(delivered * 0.01), lastDeliveryAt: iso(nowMs - R(1, 50) * 60_000) }, createdAt: created,
  });
  await repos.integrations.insertMany([
    integ("int_hash8_crm", "hash8-crm", "#8 CRM — usage metering", ["usage.metered", "device.lifecycle"], { account: "demo-solutions", plan: "iot-standard" }, 1240),
    integ("int_hash8_ticketing", "hash8-ticketing", "#8 Ticketing — field ops", ["alert.critical"], { queue: "field-ops", priority: "P2" }, 87),
    integ("int_hash8_installation", "hash8-installation", "#8 Installation app", ["device.lifecycle"], { workflow: "standard-install", photoChecklist: true }, 312),
    integ("int_hash8_sim", "hash8-sim", "#8 SIM Management", ["sim.*", "device.lifecycle"], { accounts: ["airtel-iot", "jio-things", "vi-business", "1nce"] }, 198),
    integ("int_webhook_ops", "webhook", "Ops data lake webhook", ["ota.*", "alert.created"], { secretRef: "WEBHOOK_OPS_SECRET" }, 455),
  ]);
  const auto = (id: string, name: string, trigger: Automation["trigger"], condition: string | undefined, actions: Automation["actions"], runs: number): Automation => ({
    id, tenantId: TENANTS.solution, name, enabled: true, trigger, ...(condition ? { condition } : {}), actions,
    stats: { runs, failures: 0, lastRunAt: iso(nowMs - R(5, 300) * 60_000) }, createdAt: created,
  });
  await repos.automations.insertMany([
    auto("aut_high_temp", "Temperature above 30 °C", { type: "message" }, "data.temperature > 30", [{ type: "alert", severity: "warning", title: "Temperature above threshold" }], 41),
    auto("aut_low_battery", "Low battery tag", { type: "message" }, "device.health.battery != null && device.health.battery < 20", [{ type: "tag", add: ["low-battery"] }], 133),
    auto("aut_offline_60", "Offline for 60 minutes", { type: "offline", minutes: 60 }, undefined, [{ type: "alert", severity: "warning", title: "Device offline for 60+ minutes" }], 58),
    auto("aut_tamper_ticket", "Tamper alarm → field ticket", { type: "message", codecId: "acme.tracker-gt200" }, 'data.alarmType == "tamper"', [{ type: "alert", severity: "critical", title: "Tamper alarm" }, { type: "webhook", integrationId: "int_hash8_ticketing" }], 6),
    auto("aut_overvoltage", "Meter power-quality event", { type: "message", codecId: "voltix.energy-em3" }, 'data.alarm == "overvoltage" || data.alarm == "phase_loss"', [{ type: "alert", severity: "critical", title: "Power quality event" }], 12),
    auto("aut_activated_crm", "Activation → CRM billing start", { type: "lifecycle", to: "activated" }, undefined, [{ type: "webhook", integrationId: "int_hash8_crm" }], 296),
  ]);

  // ── Alerts: every category, several severities & statuses ────────────────
  const alerts: Alert[] = [];
  const pool = (f: (d: Device) => boolean) => devices.filter(f);
  const mk = (d: Device | undefined, category: Alert["category"], severity: Alert["severity"], title: string, source: string, detail?: string) => {
    const st = pick<Alert["status"]>([["open", 0.5], ["acknowledged", 0.2], ["resolved", 0.3]], rand());
    const at = nowMs - R(0.2, 29) * DAY;
    const a: Alert = { id: newId("alr"), tenantId: d?.tenantId ?? TENANTS.solution, severity, category, title, status: st, source, createdAt: iso(at), updatedAt: iso(at + R(0.1, 20) * HOUR) };
    if (d) {
      a.deviceId = d.id;
      if (d.assetId) a.assetId = d.assetId;
    }
    if (detail) a.detail = detail;
    if (st !== "open") a.acknowledgedBy = choice(["user:ops-lead", "user:demo", "user:field-tech"]);
    if (st === "resolved") {
      a.resolvedBy = a.acknowledgedBy!;
      a.resolution = choice(["Technician visit — fixed on site", "Transient; recovered automatically", "Configuration corrected", "Unit swapped", "Carrier outage resolved"]);
    }
    alerts.push(a);
  };
  for (const d of pool((d) => d.lifecycle === "activated" && d.health.connectivity === "offline").slice(0, 14)) mk(d, "communication_loss", "warning", "Device offline for 60+ minutes", "automation:aut_offline_60", `${d.name ?? d.udi} last seen ${d.health.lastSeenAt}`);
  for (const d of pool((x) => x.health.connectivity === "stale").slice(0, 5)) mk(d, "communication_loss", "info", "Telemetry stale", "health");
  const sensors = pool((d) => (d.modelId === "envio-th-sense" || d.modelId === "anova-coldtrack") && d.lifecycle === "activated");
  for (const d of sensors.slice(0, 10)) mk(d, "abnormal_telemetry", rand() < 0.3 ? "critical" : "warning", "Cold room temperature above threshold", "automation:aut_high_temp", `Temperature ${R(9, 14).toFixed(1)} °C for ${Math.round(R(10, 50))} min`);
  for (const d of sensors.slice(10, 13)) mk(d, "device_failure", "critical", "Temperature sensor error", "health", "Probe reports sensor_error flag");
  const meters = pool((d) => (d.modelId === "voltix-em3" || d.modelId === "ztr-gentrack") && d.lifecycle === "activated");
  for (const d of meters.slice(0, 6)) mk(d, "abnormal_telemetry", "critical", choice(["Overvoltage on L1", "Phase loss on L2", "Frequency deviation"]), "automation:aut_overvoltage");
  for (const d of meters.slice(6, 9)) mk(d, "device_failure", "warning", "Meter relay did not confirm state", "commands");
  const trackers = pool((d) => (d.modelId === "acme-gt200" || d.modelId === "trackunit-raw") && d.lifecycle === "activated");
  for (const d of trackers.slice(0, 4)) mk(d, "security", "critical", "Tamper alarm", "automation:aut_tamper_ticket", "Enclosure opened outside maintenance window");
  for (const d of trackers.slice(4, 8)) mk(d, "device_failure", "warning", "GNSS fix lost for > 2 hours", "health");
  for (const c of creds.filter((x) => x.revokedReason === "key compromise suspected")) mk(devices.find((x) => x.id === c.deviceId), "security", "critical", "Device credential revoked — key compromise suspected", "security");
  for (const d of pool((x) => (x.sim?.usageMbMonth ?? 0) > (x.sim?.planLimitMb ?? Infinity)).slice(0, 5)) mk(d, "other", "warning", "SIM data usage over plan limit", "hash8-sim", `${d.sim!.usageMbMonth} MB of ${d.sim!.planLimitMb} MB`);
  for (const d of pool((x) => (x.health.battery ?? 100) < 20 && x.lifecycle === "activated").slice(0, 6)) mk(d, "abnormal_telemetry", "warning", "Low battery", "health", `Battery ${Math.round(d.health.battery ?? 0)}%`);
  mk(undefined, "other", "info", "Codec voltix.energy-em3 published", "codec-registry");
  await repos.alerts.insertMany(alerts);

  // ── OTA: completed, rolled back, running ─────────────────────────────────
  const scope = await p.core.scope(TENANTS.solution);
  const saveRand = p.ota.rand;
  const saveRate = p.ota.simFailureRate;
  p.ota.rand = rng(42);
  const runFor = async (c: Awaited<ReturnType<typeof p.ota.create>>, maxTicks: number) => {
    let cur = await p.ota.start(c, "user:ops-lead");
    for (let i = 0; i < maxTicks && cur.status === "running"; i++) cur = await p.ota.tickCampaign(cur);
    return cur;
  };
  const em3Fw = firmware.get("voltix-em3")?.find((f) => f.version === "1.4.0");
  if (em3Fw) {
    p.ota.simFailureRate = 0;
    const c = await p.ota.create(TENANTS.solution, scope, { name: "EM3 1.4.0 fleet upgrade", firmwareId: em3Fw.id, fromVersions: [">=1.3.0 <1.4.0"], cohort: { modelId: "voltix-em3", lifecycle: "activated", connectivity: "online" } }, "user:ops-lead");
    await runFor(c, 40);
  }
  const envioSpec = specByModel.get("envio-th-sense");
  const badFw = await p.firmware.create(TENANTS.envio, { modelId: "envio-th-sense", version: "1.2.0", ...(envioSpec ? { codecVersion: envioSpec.version } : {}), releaseNotes: "1.2.0: new radio stack (recalled — boot loop on some units)." }, new Uint8Array(Buffer.from("#8 demo firmware envio 1.2.0\n".repeat(1024))), "user:oem-release");
  p.ota.simFailureRate = 1;
  {
    const c = await p.ota.create(TENANTS.solution, scope, { name: "TH-Sense 1.2.0 radio stack", firmwareId: badFw.id, fromVersions: [">=1.0.0 <1.2.0"], cohort: { modelId: "envio-th-sense", lifecycle: "activated", connectivity: "online" } }, "user:ops-lead");
    await runFor(c, 10);
  }
  const acmeSpec = specByModel.get("acme-gt200");
  const fw24 = await p.firmware.create(TENANTS.acme, { modelId: "acme-gt200", version: "2.4.0", ...(acmeSpec ? { codecVersion: acmeSpec.version } : {}), releaseNotes: "2.4.0: faster GNSS fix, geofence hysteresis, parked power-save." }, new Uint8Array(Buffer.from("#8 demo firmware acme-gt200 2.4.0\n".repeat(2048))), "user:oem-release");
  p.ota.simFailureRate = 0; // keep the demo rollout healthy & running (canary + first wave)
  {
    const c = await p.ota.create(TENANTS.solution, scope, { name: "GT200 2.4.0 fleet rollout", firmwareId: fw24.id, fromVersions: [">=2.1.0 <2.4.0"], cohort: { modelId: "acme-gt200", lifecycle: "activated", connectivity: "online" } }, "user:ops-lead");
    await runFor(c, 2);
  }
  p.ota.rand = saveRand;
  p.ota.simFailureRate = saveRate;

  // ── Audit history ─────────────────────────────────────────────────────────
  const actors = ["user:demo", "user:ops-lead", "user:field-tech", "agent:rollout-guardian", "system"];
  for (const d of devices.slice(0, Math.min(80, devices.length))) {
    audit.push({ id: newId("aud"), tenantId: d.tenantId, at: d.updatedAt, actor: choice(actors), action: "device.lifecycle.update", target: `device:${d.id}`, detail: { to: d.lifecycle } });
  }
  for (const a of assets.slice(0, 30)) audit.push({ id: newId("aud"), tenantId: a.tenantId, at: a.createdAt, actor: "user:ops-lead", action: "asset.create", target: `asset:${a.id}`, detail: { name: a.name, type: a.type } });
  for (const c of creds.slice(0, 30)) audit.push({ id: newId("aud"), tenantId: c.tenantId, at: c.issuedAt, actor: "system", action: "device.credential.issue", target: `device:${c.deviceId}`, detail: { fingerprint: c.fingerprint.slice(0, 23) } });
  audit.push({ id: newId("aud"), tenantId: TENANTS.solution, at: iso(nowMs - 5 * DAY), actor: "user:demo", action: "integration.create", target: "integration:int_hash8_ticketing", detail: { kind: "hash8-ticketing" } });
  await repos.audit.insertMany(audit);

  const stats = { devices: devices.length, assets: assets.length, messages: messages.length, unknown: unknown.length, credentials: creds.length, alerts: alerts.length };
  await repos.kv.set("seed", { at: now.toISOString(), ...stats });
  p.codecs.invalidate();
  p.automations.invalidate();
  return stats;
}

function makeSim(rand: () => number): SimInfo {
  const c = pick(CARRIERS.map((x) => [x, x.weight] as [(typeof CARRIERS)[number], number]), rand());
  const iccid = `8991${c.carrier === "1NCE" ? "88" : "10"}${String(Math.floor(1e12 + rand() * 9e12))}`;
  return {
    iccid,
    imsi: `40${c.mcc}${String(Math.floor(1e9 + rand() * 9e9))}`,
    msisdn: `+91${Math.floor(6e9 + rand() * 3.9e9)}`,
    carrier: c.carrier,
    status: "inactive",
    plan: c.plan,
    planLimitMb: c.limit,
    usageMbMonth: 0,
    externalUrl: `https://sim.hash8.io/sims/${iccid}`,
  };
}

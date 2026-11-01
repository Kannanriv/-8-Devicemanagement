/**
 * Deterministic ecosystem seed: fictional partners, ~30 catalog models backed by
 * real DCS codecs (the three sample specs plus derived variants), codec release
 * history with genuine `diffSpecs` output, adoptions, subscriptions and
 * certification runs produced by actually running the pipeline.
 */
import { parseSpec, type DeviceCodecSpec, type Field } from "@hash8/dcs-schema";
import type {
  CatalogModel,
  CertificationLevel,
  CertificationRun,
  CodecRelease,
  CodecSubscription,
  EcosystemPartner,
  PluginTarget,
} from "@hash8/sdk-ts";
import acmeJson from "../../../samples/specs/acme.tracker-gt200.json";
import voltixJson from "../../../samples/specs/voltix.energy-em3.json";
import envioJson from "../../../samples/specs/envio.th-sense.json";
import { diffSpecs } from "./diff";
import { computeCompatibility } from "./compatibility";
import { badgesFor, levelRank } from "./levels";
import { achievedLevel, runCertificationSync } from "./certification";
import type { Adoption, GraphRelation } from "./catalog";

export interface EcosystemSeed {
  partners: EcosystemPartner[];
  models: CatalogModel[];
  /** Current spec of every catalog codec. */
  specs: DeviceCodecSpec[];
  /** Every spec version ever released (including current). */
  history: DeviceCodecSpec[];
  releases: CodecRelease[];
  runs: CertificationRun[];
  adoptions: Adoption[];
  subscriptions: CodecSubscription[];
  relations: GraphRelation[];
  /** Tenant id → display name for adopters. */
  customers: Record<string, string>;
}

const DAY = 86_400_000;
const ALL_TARGETS: PluginTarget[] = ["ts", "ts013", "python", "go", "java", "c"];
const SPEC_PROTOCOLS = new Set(["lorawan", "mqtt", "coap", "lwm2m", "http", "udp", "tcp", "nbiot", "sigfox"]);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

type Template = "acme" | "voltix" | "envio";
const TEMPLATES: Record<Template, DeviceCodecSpec> = {
  acme: parseSpec(clone(acmeJson)),
  voltix: parseSpec(clone(voltixJson)),
  envio: parseSpec(clone(envioJson)),
};

/* ── partners ─────────────────────────────────────────────────────────── */

type PartnerSeed = Omit<EcosystemPartner, "modelsCount" | "joinedAt"> & { joinedDaysAgo: number };
const PARTNERS: PartnerSeed[] = [
  { id: "ptn_acme", name: "Acme Devices", kind: "oem", tier: "premier", country: "IN", website: "https://acme-devices.example", tenantId: "tn_oem_acme", description: "Cellular GNSS trackers for fleets and high-value assets.", joinedDaysAgo: 420 },
  { id: "ptn_voltix", name: "Voltix Energy", kind: "oem", tier: "premier", country: "DE", website: "https://voltix.example", tenantId: "tn_oem_voltix", description: "DIN-rail and clamp energy meters with latching relays.", joinedDaysAgo: 390 },
  { id: "ptn_envio", name: "Envio Sensors", kind: "oem", tier: "verified", country: "NL", website: "https://envio.example", tenantId: "tn_oem_envio", description: "Battery LoRaWAN sensors for cold chain and buildings.", joinedDaysAgo: 360 },
  { id: "ptn_orbiq", name: "Orbiq Telematics", kind: "oem", tier: "verified", country: "SG", website: "https://orbiq.example", description: "Vehicle telematics boxes with CAN and OBD-II.", joinedDaysAgo: 300 },
  { id: "ptn_nimbara", name: "Nimbara Metering", kind: "oem", tier: "verified", country: "IN", website: "https://nimbara.example", description: "Smart electricity and gas meters for utilities.", joinedDaysAgo: 280 },
  { id: "ptn_halvane", name: "Halvane Sensing", kind: "oem", tier: "registered", country: "FI", website: "https://halvane.example", description: "Air-quality and acoustic sensing for smart buildings.", joinedDaysAgo: 75 },
  { id: "ptn_kestro", name: "Kestro Trackers", kind: "oem", tier: "verified", country: "AE", website: "https://kestro.example", description: "Container, asset and micromobility trackers.", joinedDaysAgo: 240 },
  { id: "ptn_aquelle", name: "Aquelle Water", kind: "oem", tier: "verified", country: "ES", website: "https://aquelle.example", description: "Ultrasonic water meters and tank-level sensors.", joinedDaysAgo: 220 },
  { id: "ptn_lumaro", name: "Lumaro Lighting", kind: "oem", tier: "registered", country: "IT", website: "https://lumaro.example", description: "Connected street-lighting controllers and gateways.", joinedDaysAgo: 120 },
  { id: "ptn_tessaro", name: "Tessaro Distribution", kind: "distributor", tier: "premier", country: "IN", website: "https://tessaro.example", description: "Pan-India IoT hardware distribution with bonded warehousing.", joinedDaysAgo: 330 },
  { id: "ptn_brindle", name: "Brindlefield Supply", kind: "distributor", tier: "verified", country: "GB", website: "https://brindlefield.example", description: "Utility-grade metering distribution across EMEA.", joinedDaysAgo: 260 },
  { id: "ptn_fieldwise", name: "Fieldwise Installers", kind: "installer", tier: "verified", country: "IN", website: "https://fieldwise.example", description: "Certified vehicle and asset installation crews in 40 cities.", joinedDaysAgo: 210 },
  { id: "ptn_rapidmount", name: "Rapidmount Services", kind: "installer", tier: "registered", country: "IN", website: "https://rapidmount.example", description: "Meter and sensor commissioning for utilities and facilities.", joinedDaysAgo: 140 },
  { id: "ptn_velora", name: "Velora Connect", kind: "connectivity", tier: "premier", country: "DE", website: "https://velora.example", description: "Multi-carrier IoT SIMs and eSIM profiles with pooled data.", joinedDaysAgo: 310 },
  { id: "ptn_quillon", name: "Quillon Apps", kind: "app_developer", tier: "verified", country: "IN", website: "https://quillon.example", description: "Cold-chain and fleet dashboards built on #8 codecs.", joinedDaysAgo: 160 },
  { id: "ptn_corvane", name: "Corvane Integrators", kind: "solution_provider", tier: "verified", country: "AU", website: "https://corvane.example", description: "End-to-end utility and smart-building deployments.", joinedDaysAgo: 190 },
];

/* ── catalog models ───────────────────────────────────────────────────── */

interface ModelSeed {
  id: string;
  partnerId: string;
  name: string;
  category: string;
  description: string;
  protocols: string[];
  connectivity: string[];
  powerSource: CatalogModel["powerSource"];
  ipRating?: string;
  firmware?: string;
  /** Sample spec this model uses verbatim, or a template to derive its own codec from. */
  sample?: Template;
  template?: Template;
  /** Derived codec gets a 1.0.0 → 1.1.0 release history. */
  twoReleases?: boolean;
  /** Seed a deliberately wrong vector (to demo a failing certification). */
  brokenVector?: boolean;
  level: CertificationLevel;
  scale: number;
  tags: string[];
  createdDaysAgo: number;
  targets?: PluginTarget[];
}

const MODELS: ModelSeed[] = [
  // Acme Devices
  { id: "acme-gt200", partnerId: "ptn_acme", name: "GT200 Asset Tracker", category: "tracker", description: "4G/NB-IoT GPS asset tracker with ignition sense and tamper switch.", protocols: ["mqtt"], connectivity: ["nb-iot", "lte-m"], powerSource: "vehicle", ipRating: "IP67", firmware: "2.3.0", sample: "acme", level: "hash8_certified", scale: 9, tags: ["mtls", "x509", "gnss", "fleet"], createdDaysAgo: 400 },
  { id: "acme-gt300", partnerId: "ptn_acme", name: "GT300 Fleet Tracker", category: "tracker", description: "Next-gen fleet tracker with CAN-lite input and harsh-driving detection.", protocols: ["mqtt"], connectivity: ["4g", "lte-m"], powerSource: "vehicle", ipRating: "IP67", firmware: "1.1.0", template: "acme", twoReleases: true, level: "secure", scale: 6, tags: ["mtls", "x509", "gnss", "fleet"], createdDaysAgo: 150 },
  { id: "acme-minitag", partnerId: "ptn_acme", name: "MiniTag Personal Tracker", category: "tracker", description: "Pocket-size NB-IoT tracker with BLE beacon and SOS button.", protocols: ["mqtt"], connectivity: ["nb-iot", "ble"], powerSource: "battery", ipRating: "IP66", firmware: "1.0.0", template: "acme", level: "ota_ready", scale: 3, tags: ["tls", "token", "gnss", "workforce"], createdDaysAgo: 90 },
  // Voltix Energy
  { id: "voltix-em3", partnerId: "ptn_voltix", name: "EM3 Three-Phase Meter", category: "energy-meter", description: "DIN-rail three-phase energy meter with latching relay, MQTT over Ethernet/LTE-M.", protocols: ["mqtt"], connectivity: ["lte-m", "ethernet"], powerSource: "mains", ipRating: "IP51", firmware: "1.4.0", sample: "voltix", level: "hash8_certified", scale: 8, tags: ["tls", "x509", "din-rail", "utility"], createdDaysAgo: 380 },
  { id: "voltix-em1", partnerId: "ptn_voltix", name: "EM1 Single-Phase Meter", category: "energy-meter", description: "Residential single-phase meter with prepaid relay control.", protocols: ["mqtt"], connectivity: ["nb-iot"], powerSource: "mains", ipRating: "IP54", firmware: "1.1.0", template: "voltix", twoReleases: true, level: "hash8_certified", scale: 10, tags: ["tls", "x509", "prepaid", "utility"], createdDaysAgo: 260 },
  { id: "voltix-ctx", partnerId: "ptn_voltix", name: "CT-X Clamp Monitor", category: "energy-meter", description: "Non-invasive clamp-on CT monitor for sub-metering.", protocols: ["mqtt"], connectivity: ["wifi", "lte-m"], powerSource: "mains", ipRating: "IP40", firmware: "1.0.0", template: "voltix", level: "codec_verified", scale: 4, tags: ["tls", "psk", "sub-metering"], createdDaysAgo: 110 },
  { id: "voltix-solar", partnerId: "ptn_voltix", name: "SolarString S2", category: "energy-meter", description: "String-level PV production meter with export limiting.", protocols: ["mqtt"], connectivity: ["wifi", "4g"], powerSource: "solar", ipRating: "IP65", firmware: "1.0.0", template: "voltix", level: "secure", scale: 4, tags: ["mtls", "x509", "solar"], createdDaysAgo: 70 },
  // Envio Sensors
  { id: "envio-th-sense", partnerId: "ptn_envio", name: "TH-Sense LoRaWAN", category: "environment", description: "Battery LoRaWAN indoor temperature & humidity sensor with on-board history buffer.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP65", firmware: "1.1.0", sample: "envio", level: "hash8_certified", scale: 9, tags: ["otaa", "cold-chain", "buildings"], createdDaysAgo: 350 },
  { id: "envio-co2-pro", partnerId: "ptn_envio", name: "CO2 Pro", category: "environment", description: "NDIR CO₂, temperature and humidity for occupied spaces.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP30", firmware: "1.1.0", template: "envio", twoReleases: true, level: "secure", scale: 6, tags: ["otaa", "buildings", "iaq"], createdDaysAgo: 200 },
  { id: "envio-coldprobe", partnerId: "ptn_envio", name: "ColdProbe NB", category: "environment", description: "NB-IoT probe for reefers and cold rooms down to −40 °C.", protocols: ["lwm2m"], connectivity: ["nb-iot"], powerSource: "battery", ipRating: "IP68", firmware: "1.0.0", template: "envio", level: "ota_ready", scale: 5, tags: ["dtls", "psk", "cold-chain"], createdDaysAgo: 130 },
  { id: "envio-leak", partnerId: "ptn_envio", name: "LeakSense", category: "environment", description: "Water-leak rope sensor with tamper detection.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP67", firmware: "1.0.0", template: "envio", level: "codec_verified", scale: 3, tags: ["otaa", "buildings"], createdDaysAgo: 45 },
  // Orbiq Telematics
  { id: "orbiq-ot500", partnerId: "ptn_orbiq", name: "OT-500 Telematics Box", category: "telematics", description: "Heavy-vehicle telematics with fuel, CAN J1939 and driver ID.", protocols: ["mqtt"], connectivity: ["4g", "lte-m"], powerSource: "vehicle", ipRating: "IP67", firmware: "1.1.0", template: "acme", twoReleases: true, level: "hash8_certified", scale: 8, tags: ["mtls", "x509", "can", "fleet"], createdDaysAgo: 280 },
  { id: "orbiq-canlink", partnerId: "ptn_orbiq", name: "CANLink OBD", category: "telematics", description: "Plug-and-play OBD-II dongle for light commercial vehicles.", protocols: ["mqtt"], connectivity: ["lte-m"], powerSource: "vehicle", ipRating: "IP40", firmware: "4.0.0", template: "acme", level: "secure", scale: 5, tags: ["tls", "x509", "obd", "fleet"], createdDaysAgo: 180 },
  { id: "orbiq-assetlite", partnerId: "ptn_orbiq", name: "AssetLite LR", category: "tracker", description: "LoRaWAN GNSS tracker for yards and campuses.", protocols: ["lorawan"], connectivity: ["lorawan", "ble"], powerSource: "battery", ipRating: "IP67", firmware: "1.0.0", template: "envio", level: "codec_verified", scale: 3, tags: ["otaa", "gnss"], createdDaysAgo: 95 },
  // Nimbara Metering
  { id: "nimbara-sm1", partnerId: "ptn_nimbara", name: "SM-1 Smart Meter", category: "energy-meter", description: "Utility smart meter with LwM2M over NB-IoT and DLMS bridge.", protocols: ["lwm2m"], connectivity: ["nb-iot"], powerSource: "mains", ipRating: "IP54", firmware: "1.1.0", template: "voltix", twoReleases: true, level: "hash8_certified", scale: 10, tags: ["dtls", "psk", "utility", "dlms"], createdDaysAgo: 270 },
  { id: "nimbara-g4", partnerId: "ptn_nimbara", name: "GasSense G4", category: "gas-meter", description: "Battery gas meter module with valve control.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP65", firmware: "1.0.0", template: "voltix", level: "ota_ready", scale: 5, tags: ["otaa", "utility"], createdDaysAgo: 160 },
  { id: "nimbara-dc", partnerId: "ptn_nimbara", name: "DC Charger Meter", category: "energy-meter", description: "MID DC meter for EV fast chargers.", protocols: ["mqtt"], connectivity: ["4g"], powerSource: "mains", ipRating: "IP54", firmware: "1.0.0", template: "voltix", level: "codec_verified", scale: 3, tags: ["tls", "x509", "ev-charging"], createdDaysAgo: 60 },
  // Halvane Sensing
  { id: "halvane-aq9", partnerId: "ptn_halvane", name: "AQ-9 Air Quality", category: "environment", description: "PM2.5 / PM10 / VOC sensor for classrooms and offices.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "mains", ipRating: "IP30", firmware: "0.9.0", template: "envio", brokenVector: true, level: "listed", scale: 0, tags: ["otaa", "iaq", "buildings"], createdDaysAgo: 40 },
  { id: "halvane-n2", partnerId: "ptn_halvane", name: "SoundLevel N2", category: "environment", description: "Acoustic level monitor (dBA) for noise compliance.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP54", level: "listed", scale: 0, tags: ["otaa", "noise"], createdDaysAgo: 20 },
  // Kestro Trackers
  { id: "kestro-k1", partnerId: "ptn_kestro", name: "K1 Asset Tag", category: "tracker", description: "Ultra-low-power LoRaWAN asset tag with BLE indoor positioning.", protocols: ["lorawan"], connectivity: ["lorawan", "ble"], powerSource: "battery", ipRating: "IP67", firmware: "1.1.0", template: "envio", twoReleases: true, level: "hash8_certified", scale: 9, tags: ["otaa", "indoor-positioning", "logistics"], createdDaysAgo: 230 },
  { id: "kestro-k5", partnerId: "ptn_kestro", name: "K5 Container Tracker", category: "tracker", description: "Solar container tracker with door and shock sensing.", protocols: ["mqtt"], connectivity: ["nb-iot", "lte-m"], powerSource: "solar", ipRating: "IP69K", firmware: "1.0.0", template: "acme", level: "secure", scale: 6, tags: ["mtls", "x509", "logistics", "gnss"], createdDaysAgo: 170 },
  { id: "kestro-ride", partnerId: "ptn_kestro", name: "Kestro Ride", category: "tracker", description: "Micromobility IoT module with immobiliser for e-bikes and scooters.", protocols: ["mqtt"], connectivity: ["lte-m", "ble"], powerSource: "battery", ipRating: "IP67", firmware: "1.0.0", template: "acme", level: "ota_ready", scale: 4, tags: ["tls", "x509", "micromobility"], createdDaysAgo: 85 },
  { id: "kestro-pet", partnerId: "ptn_kestro", name: "PawTrack", category: "tracker", description: "Consumer pet tracker with geofence alerts.", protocols: ["mqtt"], connectivity: ["lte-m"], powerSource: "battery", ipRating: "IP67", firmware: "1.0.0", template: "acme", level: "codec_verified", scale: 2, tags: ["tls", "token", "consumer"], createdDaysAgo: 30 },
  // Aquelle Water
  { id: "aquelle-u3", partnerId: "ptn_aquelle", name: "Ultrasonic Water Meter U3", category: "water-meter", description: "Ultrasonic DN15–DN40 meter with leak and backflow alarms.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP68", firmware: "1.1.0", template: "envio", twoReleases: true, level: "hash8_certified", scale: 9, tags: ["otaa", "utility", "water"], createdDaysAgo: 250 },
  { id: "aquelle-l2", partnerId: "ptn_aquelle", name: "TankLevel L2", category: "water-meter", description: "Radar tank-level sensor for overhead and sump tanks.", protocols: ["lwm2m"], connectivity: ["nb-iot"], powerSource: "battery", ipRating: "IP68", firmware: "1.0.0", template: "envio", level: "codec_verified", scale: 4, tags: ["dtls", "psk", "water"], createdDaysAgo: 100 },
  { id: "aquelle-p1", partnerId: "ptn_aquelle", name: "PressurePoint P1", category: "water-meter", description: "Network pressure logger for district metered areas.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "battery", ipRating: "IP68", level: "listed", scale: 0, tags: ["otaa", "water"], createdDaysAgo: 25 },
  { id: "aquelle-valve", partnerId: "ptn_aquelle", name: "FieldFlow Valve", category: "actuator", description: "Irrigation valve controller with flow feedback.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "solar", ipRating: "IP67", firmware: "1.0.0", template: "envio", level: "listed", scale: 0, tags: ["otaa", "agritech"], createdDaysAgo: 12 },
  // Lumaro Lighting
  { id: "lumaro-sl4", partnerId: "ptn_lumaro", name: "StreetLight Node SL4", category: "lighting", description: "Zhaga-socket street-light controller with dimming and metering.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "mains", ipRating: "IP66", firmware: "1.0.0", template: "envio", level: "ota_ready", scale: 6, tags: ["otaa", "smart-city"], createdDaysAgo: 110 },
  { id: "lumaro-g8", partnerId: "ptn_lumaro", name: "Lumaro Gateway G8", category: "gateway", description: "Outdoor LoRaWAN gateway with 4G backhaul.", protocols: ["mqtt"], connectivity: ["4g", "ethernet"], powerSource: "mains", ipRating: "IP67", firmware: "2.0.0", level: "listed", scale: 0, tags: ["tls", "smart-city"], createdDaysAgo: 18 },
  { id: "lumaro-sl5", partnerId: "ptn_lumaro", name: "StreetLight Node SL5", category: "lighting", description: "SL4 successor with tilt and pole-vibration sensing.", protocols: ["lorawan"], connectivity: ["lorawan"], powerSource: "mains", ipRating: "IP66", firmware: "1.0.0", template: "envio", level: "listed", scale: 0, tags: ["otaa", "smart-city"], createdDaysAgo: 8 },
];

/* ── customers (adopting solution companies / their customers) ───────── */

const CUSTOMERS: { id: string; name: string; likes: string[] }[] = [
  { id: "tn_solution_demo", name: "#8 Demo Solutions", likes: ["tracker", "energy-meter", "environment", "telematics"] },
  { id: "tn_customer_metro", name: "Metro Utilities", likes: ["energy-meter", "gas-meter", "water-meter"] },
  { id: "tn_customer_buildright", name: "BuildRight Infra", likes: ["tracker", "telematics", "energy-meter"] },
  { id: "tn_customer_coldchain", name: "ColdChain Logistics", likes: ["environment", "tracker"] },
  { id: "tn_ext_harborline", name: "Harborline Freight", likes: ["tracker", "telematics"] },
  { id: "tn_ext_greenacre", name: "Greenacre Agritech", likes: ["water-meter", "environment", "actuator"] },
  { id: "tn_ext_citadel", name: "Citadel Water Board", likes: ["water-meter"] },
  { id: "tn_ext_solenne", name: "Solenne Facilities", likes: ["environment", "energy-meter", "lighting"] },
];
/** Tenants that exist on the platform (get real codec subscriptions). */
const PLATFORM_TENANTS = new Set(["tn_solution_demo", "tn_customer_metro", "tn_customer_buildright", "tn_customer_coldchain"]);

/* ── spec helpers ─────────────────────────────────────────────────────── */

function walkScalars(fields: Field[], fn: (f: Field & { kind: "scalar" }) => boolean | void): boolean {
  for (const f of fields) {
    if (f.kind === "scalar" && fn(f)) return true;
    if ((f.kind === "group" || f.kind === "repeat") && walkScalars(f.fields, fn)) return true;
    if (f.kind === "switch") {
      for (const c of Object.values(f.cases)) if (walkScalars(c, fn)) return true;
      if (f.default && walkScalars(f.default, fn)) return true;
    }
  }
  return false;
}

/** Previous minor: drop the last enum value of the first enum field (so the next version "adds" it). */
function previousMinor(spec: DeviceCodecSpec): DeviceCodecSpec {
  const prev = clone(spec);
  const found = [...prev.uplink, ...(prev.downlink ?? [])].some((m) =>
    walkScalars(m.fields, (f) => {
      if (!f.enum) return false;
      const keys = Object.keys(f.enum);
      if (keys.length < 3) return false;
      delete f.enum[keys[keys.length - 1]!];
      return true;
    }),
  );
  if (!found) prev.uplink[0]!.description = `${prev.uplink[0]!.description ?? ""} (draft)`;
  return prev;
}

function deriveSpec(m: ModelSeed, vendor: string, version: string): DeviceCodecSpec {
  const t = clone(TEMPLATES[m.template!]);
  const major = (m.firmware ?? "1.0.0").split(".")[0] ?? "1";
  t.id = `${slug(vendor).split("-")[0]}.${slug(m.name)}`;
  t.version = version;
  t.device = {
    vendor,
    model: m.name,
    description: m.description,
    firmware: m.id === "orbiq-canlink" ? ">=3.0.0 <4.0.0" : `>=${major}.0.0 <${Number(major) + 1}.0.0`,
    protocols: m.protocols.filter((p) => SPEC_PROTOCOLS.has(p)) as DeviceCodecSpec["device"]["protocols"],
    category: m.category,
  };
  t.meta = { createdBy: "ecosystem-seed", sourceDocument: `${slug(vendor)}-${slug(m.name)}-payload-spec.xlsx`, license: "Apache-2.0" };
  if (m.brokenVector) {
    const v = t.vectors[0];
    if (v) (v.data as Record<string, unknown>).humidity = 51;
  }
  return t;
}

/* ── seed ─────────────────────────────────────────────────────────────── */

export function buildSeed(now: Date = new Date()): EcosystemSeed {
  const nowMs = now.getTime();
  const iso = (daysAgo: number) => new Date(nowMs - Math.round(daysAgo * DAY)).toISOString();
  const rand = rng(8008);
  const partnerById = new Map(PARTNERS.map((p) => [p.id, p]));

  const specs: DeviceCodecSpec[] = [];
  const history: DeviceCodecSpec[] = [];
  const releases: CodecRelease[] = [];
  const releaseAt = new Map<string, string[]>(); // codecId -> [publishedAt...]

  const addRelease = (prev: DeviceCodecSpec | undefined, next: DeviceCodecSpec, daysAgo: number) => {
    history.push(next);
    const r: CodecRelease = prev
      ? (() => {
          const d = diffSpecs(prev, next);
          return { codecId: next.id, version: next.version, previous: prev.version, breaking: d.breaking, changes: d.changes, publishedAt: iso(daysAgo), subscribers: 0 };
        })()
      : { codecId: next.id, version: next.version, breaking: false, changes: ["Initial release"], publishedAt: iso(daysAgo), subscribers: 0 };
    if (next.device.firmware) r.firmware = next.device.firmware;
    releases.push(r);
    releaseAt.set(next.id, [...(releaseAt.get(next.id) ?? []), r.publishedAt]);
  };

  // Sample codecs with hand-crafted history → real diffs.
  {
    const cur = clone(TEMPLATES.envio);
    const v10 = clone(cur);
    v10.version = "1.0.0";
    v10.uplink = v10.uplink.filter((m) => m.name !== "history");
    v10.downlink = (v10.downlink ?? []).filter((m) => m.name !== "request_history");
    v10.vectors = v10.vectors.filter((v) => v.message !== "history" && v.message !== "request_history");
    walkScalars(v10.uplink.find((m) => m.name === "config_ack")!.fields, (f) => {
      if (f.name === "command" && f.enum) delete f.enum["2"];
    });
    addRelease(undefined, v10, 300);
    addRelease(v10, cur, 41);
    specs.push(cur);
  }
  {
    const cur = clone(TEMPLATES.acme);
    const v20 = clone(cur);
    v20.version = "2.0.0";
    const report = v20.uplink[0]!;
    walkScalars(report.fields, (f) => {
      if (f.name === "alarmType" && f.enum) delete f.enum["5"];
    });
    const v14 = clone(v20);
    v14.version = "1.4.0";
    v14.device.firmware = ">=1.0.0 <2.0.0";
    const sw = v14.uplink[0]!.fields.find((f) => f.kind === "switch");
    if (sw?.kind === "switch") {
      const loc = sw.cases["0x01"]!;
      const speed = loc.find((f) => f.name === "speed");
      if (speed?.kind === "scalar") {
        speed.bits = 8;
        speed.scale = 1;
        speed.description = "Ground speed (km/h, integer)";
      }
      sw.cases["0x01"] = loc.filter((f) => f.name !== "satellites");
    }
    addRelease(undefined, v14, 380);
    addRelease(v14, v20, 200);
    addRelease(v20, cur, 12);
    specs.push(cur);
  }
  {
    const cur = clone(TEMPLATES.voltix);
    const v13 = clone(cur);
    v13.version = "1.3.0";
    v13.uplink = v13.uplink.filter((m) => m.name !== "daily_summary");
    v13.vectors = v13.vectors.filter((v) => v.message !== "daily_summary" && !String(v.name).startsWith("daily"));
    addRelease(undefined, v13, 330);
    addRelease(v13, cur, 8);
    specs.push(cur);
  }

  // Models
  const models: CatalogModel[] = [];
  const sampleSpec: Record<Template, DeviceCodecSpec> = { envio: specs[0]!, acme: specs[1]!, voltix: specs[2]! };
  for (const [i, m] of MODELS.entries()) {
    const partner = partnerById.get(m.partnerId)!;
    let spec: DeviceCodecSpec | undefined;
    if (m.sample) spec = sampleSpec[m.sample];
    else if (m.template) {
      const cur = deriveSpec(m, partner.name.split(" ")[0]!, m.twoReleases ? "1.1.0" : "1.0.0");
      if (m.twoReleases) {
        const prev = previousMinor(cur);
        prev.version = "1.0.0";
        addRelease(undefined, prev, m.createdDaysAgo - 5);
        addRelease(prev, cur, Math.max(2, Math.round(m.createdDaysAgo / 6) + (i % 4) * 7));
      } else addRelease(undefined, cur, Math.max(1, m.createdDaysAgo - 3));
      specs.push(cur);
      spec = cur;
    }
    const createdAt = iso(m.createdDaysAgo);
    const cm: CatalogModel = {
      id: m.id,
      partnerId: m.partnerId,
      vendor: partner.name,
      name: m.name,
      category: m.category,
      description: m.description,
      protocols: m.protocols,
      connectivity: m.connectivity,
      powerSource: m.powerSource,
      pluginTargets: m.targets ?? (spec ? (m.protocols.includes("lorawan") ? ALL_TARGETS : ALL_TARGETS.filter((t) => t !== "ts013")) : []),
      certification: { level: m.level, badges: badgesFor(m.level) },
      compatibility: [],
      adoption: { devices: 0, customers: 0, pluginDownloads: 0 },
      tags: m.tags,
      createdAt,
    };
    if (m.ipRating) cm.ipRating = m.ipRating;
    if (m.firmware) cm.latestFirmware = m.firmware;
    if (spec) {
      cm.codecId = spec.id;
      cm.codecVersion = spec.version;
    }
    if (m.level !== "listed") {
      cm.certification.certifiedAt = iso(Math.max(1, m.createdDaysAgo - 14));
      cm.certification.expiresAt = new Date(Date.parse(cm.certification.certifiedAt) + 365 * DAY).toISOString();
    }
    cm.compatibility = computeCompatibility(cm);
    models.push(cm);
  }

  // Adoptions (deterministic, category affinity × model scale)
  const adoptions: Adoption[] = [];
  for (const [mi, m] of models.entries()) {
    const seedM = MODELS[mi]!;
    if (!seedM.scale) continue;
    const fans = CUSTOMERS.filter((c) => c.likes.includes(m.category));
    const n = Math.min(fans.length, 1 + Math.floor(rand() * Math.min(4, Math.ceil(seedM.scale / 2.5))));
    const start = Math.floor(rand() * Math.max(1, fans.length));
    for (let k = 0; k < n; k++) {
      const c = fans[(start + k) % fans.length]!;
      const devices = Math.round(seedM.scale * seedM.scale * (40 + rand() * 160));
      adoptions.push({ tenantId: c.id, tenantName: c.name, modelId: m.id, devices, adoptedAt: iso(Math.max(1, seedM.createdDaysAgo - 20 - k * 9)) });
    }
  }
  // The demo solution tenant has adopted the three sample-backed models.
  for (const id of ["acme-gt200", "voltix-em3", "envio-th-sense"]) {
    if (!adoptions.some((a) => a.modelId === id && a.tenantId === "tn_solution_demo")) {
      adoptions.push({ tenantId: "tn_solution_demo", tenantName: "#8 Demo Solutions", modelId: id, devices: 60, adoptedAt: iso(120) });
    }
  }
  for (const m of models) {
    const mine = adoptions.filter((a) => a.modelId === m.id);
    m.adoption = {
      devices: mine.reduce((s, a) => s + a.devices, 0),
      customers: new Set(mine.map((a) => a.tenantId)).size,
      pluginDownloads: m.codecId ? Math.round(mine.length * 37 + (MODELS.find((x) => x.id === m.id)!.scale * 23) + rand() * 40) : 0,
    };
  }

  // Subscriptions for platform tenants
  const subscriptions: CodecSubscription[] = [];
  let subN = 0;
  for (const a of adoptions) {
    if (!PLATFORM_TENANTS.has(a.tenantId)) continue;
    const m = models.find((x) => x.id === a.modelId)!;
    if (!m.codecId || subscriptions.some((s) => s.tenantId === a.tenantId && s.codecId === m.codecId)) continue;
    subN++;
    subscriptions.push({
      id: `sub_seed_${String(subN).padStart(3, "0")}`,
      tenantId: a.tenantId,
      codecId: m.codecId,
      channel: subN % 3 === 0 ? "webhook" : subN % 3 === 1 ? "in_app" : "email",
      autoUpgrade: subN % 4 === 0 ? "none" : subN % 4 === 3 ? "all" : "minor",
      createdAt: a.adoptedAt ?? iso(60),
    });
  }
  for (const r of releases) {
    const m = models.find((x) => x.codecId === r.codecId);
    r.subscribers = m ? new Set(adoptions.filter((a) => a.modelId === m.id).map((a) => a.tenantId)).size : 0;
  }

  // Certification runs — produced by actually running the pipeline.
  const specFor = (m: CatalogModel) => specs.find((s) => s.id === m.codecId && s.version === m.codecVersion);
  const runPlan: { modelId: string; target: CertificationLevel; daysAgo: number; queued?: "submitted" | "running" }[] = [
    { modelId: "acme-gt200", target: "hash8_certified", daysAgo: 21 },
    { modelId: "voltix-em3", target: "hash8_certified", daysAgo: 16 },
    { modelId: "envio-th-sense", target: "hash8_certified", daysAgo: 33 },
    { modelId: "orbiq-ot500", target: "hash8_certified", daysAgo: 9 },
    { modelId: "halvane-aq9", target: "codec_verified", daysAgo: 4 },
    { modelId: "orbiq-canlink", target: "hash8_certified", daysAgo: 6 },
    { modelId: "acme-minitag", target: "secure", daysAgo: 3 },
    { modelId: "kestro-pet", target: "secure", daysAgo: 0.2, queued: "submitted" },
    { modelId: "lumaro-sl5", target: "codec_verified", daysAgo: 0.1, queued: "submitted" },
    { modelId: "envio-leak", target: "hash8_certified", daysAgo: 0.05, queued: "running" },
  ];
  const runs: CertificationRun[] = [];
  for (const [i, plan] of runPlan.entries()) {
    const m = models.find((x) => x.id === plan.modelId)!;
    const at = nowMs - Math.round(plan.daysAgo * DAY);
    const id = `cert_seed_${String(i + 1).padStart(2, "0")}`;
    if (plan.queued) {
      runs.push({
        id,
        modelId: m.id,
        partnerId: m.partnerId,
        targetLevel: plan.target,
        status: plan.queued,
        steps: ["spec_import", "codec_vectors", "plugin_conformance", "ota_dry_run", "security_review", "interop"].map((name, k) =>
          plan.queued === "running" && k === 0
            ? { name: name as CertificationRun["steps"][number]["name"], status: "passed" as const, detail: "Queued spec snapshot validated", at: new Date(at).toISOString() }
            : { name: name as CertificationRun["steps"][number]["name"], status: "pending" as const },
        ),
        createdAt: new Date(at).toISOString(),
        updatedAt: new Date(at).toISOString(),
      });
      continue;
    }
    let tick = 0;
    const run = runCertificationSync(m, specFor(m), plan.target, {
      id: () => id,
      now: () => new Date(at + tick++ * 2_300),
    });
    runs.push(run);
    const got = achievedLevel(run);
    if (run.status === "passed" && levelRank(got) > levelRank(m.certification.level)) {
      m.certification = { level: got, badges: badgesFor(got), certifiedAt: run.updatedAt, expiresAt: new Date(Date.parse(run.updatedAt) + 365 * DAY).toISOString() };
      m.compatibility = computeCompatibility(m);
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Partner relations for the graph
  const relations: GraphRelation[] = [];
  const rel = (source: string, pred: (m: CatalogModel) => boolean, kind: string) => {
    for (const m of models) if (pred(m)) relations.push({ source, target: m.id, kind });
  };
  rel("ptn_tessaro", (m) => ["ptn_acme", "ptn_orbiq", "ptn_kestro"].includes(m.partnerId) && m.certification.level !== "listed", "distributes");
  rel("ptn_brindle", (m) => ["ptn_voltix", "ptn_nimbara", "ptn_aquelle"].includes(m.partnerId) && m.certification.level !== "listed", "distributes");
  rel("ptn_fieldwise", (m) => (m.category === "tracker" || m.category === "telematics") && m.adoption.devices > 2000, "installs");
  rel("ptn_rapidmount", (m) => (m.category.endsWith("meter") || m.category === "lighting") && m.adoption.devices > 1500, "installs");
  rel("ptn_velora", (m) => m.connectivity.some((c) => ["nb-iot", "lte-m", "4g"].includes(c)) && m.adoption.devices > 3000, "connects");
  rel("ptn_quillon", (m) => m.tags.includes("cold-chain") || m.tags.includes("fleet"), "builds-on");
  rel("ptn_corvane", (m) => m.tags.includes("utility") || m.tags.includes("buildings"), "integrates");

  const partners: EcosystemPartner[] = PARTNERS.map(({ joinedDaysAgo, ...p }) => ({
    ...p,
    modelsCount: models.filter((m) => m.partnerId === p.id).length,
    joinedAt: iso(joinedDaysAgo),
  }));

  return {
    partners,
    models,
    specs,
    history,
    releases: releases.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    runs,
    adoptions,
    subscriptions,
    relations,
    customers: Object.fromEntries(CUSTOMERS.map((c) => [c.id, c.name])),
  };
}

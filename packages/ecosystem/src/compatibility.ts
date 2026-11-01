import type { CatalogModel, CompatibilityEntry, CompatibilityStatus } from "@hash8/sdk-ts";
import { isCertified } from "./levels";

const CELLULAR = new Set(["lte-m", "nb-iot", "4g", "5g", "2g", "cat-1", "lte"]);
const IP_PROTOCOLS = new Set(["mqtt", "http", "coap", "lwm2m", "udp", "tcp"]);

/** Fictional-neutral carrier support per radio access technology. */
const CARRIERS: { target: string; label: string; rat: Record<string, CompatibilityStatus> }[] = [
  { target: "airtel", label: "Airtel", rat: { "nb-iot": "certified", "lte-m": "compatible", "4g": "certified", "cat-1": "compatible", lte: "certified", "2g": "compatible" } },
  { target: "jio", label: "Jio", rat: { "nb-iot": "compatible", "lte-m": "untested", "4g": "certified", "cat-1": "certified", lte: "certified" } },
  { target: "vi", label: "Vi", rat: { "nb-iot": "compatible", "lte-m": "compatible", "4g": "compatible", "cat-1": "compatible", lte: "compatible", "2g": "compatible" } },
  { target: "1nce", label: "1NCE", rat: { "nb-iot": "compatible", "lte-m": "certified", "4g": "compatible", "cat-1": "compatible", lte: "compatible", "2g": "compatible" } },
];
const RANK: Record<CompatibilityStatus, number> = { certified: 3, compatible: 2, untested: 1, incompatible: 0 };

/**
 * Derive the compatibility matrix for a catalog model from its protocols,
 * connectivity, codec and certification. "certified" requires a codec-verified model;
 * anything else is capped at "compatible".
 */
export function computeCompatibility(model: CatalogModel): CompatibilityEntry[] {
  const protocols = new Set(model.protocols.map((p) => p.toLowerCase()));
  const conn = new Set(model.connectivity.map((c) => c.toLowerCase()));
  const lorawan = protocols.has("lorawan") || conn.has("lorawan");
  const ip = [...protocols].some((p) => IP_PROTOCOLS.has(p));
  const cellular = [...conn].filter((c) => CELLULAR.has(c));
  const hasCodec = Boolean(model.codecId);
  const certified = hasCodec && isCertified(model.certification.level);
  const ts013 = model.pluginTargets.includes("ts013");
  const cap = (s: CompatibilityStatus): CompatibilityStatus => (s === "certified" && !certified ? "compatible" : s);
  const out: CompatibilityEntry[] = [];
  const push = (target: string, label: string, kind: CompatibilityEntry["kind"], status: CompatibilityStatus, note?: string) =>
    out.push({ target, label, kind, status: cap(status), ...(note ? { note } : {}) });

  // Networks (LoRaWAN network servers)
  for (const [target, label] of [["ttn", "The Things Stack"], ["chirpstack", "ChirpStack"]] as const) {
    if (!lorawan) push(target, label, "network", "incompatible", "No LoRaWAN radio");
    else if (!hasCodec) push(target, label, "network", "untested", "No codec — payload formatter missing");
    else push(target, label, "network", ts013 ? "certified" : "compatible", ts013 ? "TS013 payload formatter generated from the codec" : "Add the ts013 plugin target for a native formatter");
  }

  // #8 Device Gateway
  if (ip) push("hash8-gateway", "#8 Device Gateway", "gateway", hasCodec ? "certified" : "compatible", `Native ${[...protocols].filter((p) => IP_PROTOCOLS.has(p)).join(", ").toUpperCase()} ingest`);
  else if (lorawan) push("hash8-gateway", "#8 Device Gateway", "gateway", "compatible", "Via LNS bridge (TTN / ChirpStack webhook)");
  else push("hash8-gateway", "#8 Device Gateway", "gateway", "untested");

  // Carriers
  for (const c of CARRIERS) {
    if (!cellular.length) {
      push(c.target, c.label, "carrier", "incompatible", "No cellular modem");
      continue;
    }
    let best: CompatibilityStatus = "untested";
    for (const rat of cellular) {
      const s = c.rat[rat] ?? "untested";
      if (RANK[s] > RANK[best]) best = s;
    }
    push(c.target, c.label, "carrier", best, cellular.map((r) => r.toUpperCase()).join(" · "));
  }

  // Platform
  push("hash8-dm", "#8 Device Management", "platform", hasCodec ? "certified" : "compatible", hasCodec ? "Auto-decoding with the verified codec" : "Inventory & lifecycle only until a codec is attached");

  // #8 products
  const product = (target: string, label: string, needsCodec: boolean, note: string) =>
    push(target, label, "hash8-product", needsCodec && !hasCodec ? "untested" : "certified", needsCodec && !hasCodec ? "Needs a decoded telemetry stream" : note);
  product("hash8-crm", "#8 IoT CRM & Billing", true, "Usage-based billing from decoded telemetry");
  product("hash8-ticketing", "#8 Ticketing", true, "Alerts open tickets with decoded context");
  product("hash8-install", "#8 Installation App", false, model.connectivity.includes("ble") ? "BLE commissioning + QR onboarding" : "QR onboarding and install checklist");
  if (cellular.length) push("hash8-sim", "#8 SIM Management", "hash8-product", "certified", "ICCID lifecycle, data usage and suspend/activate");
  else push("hash8-sim", "#8 SIM Management", "hash8-product", "incompatible", "No SIM");
  return out;
}

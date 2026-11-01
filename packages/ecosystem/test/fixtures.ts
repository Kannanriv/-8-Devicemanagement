import { parseSpec, type DeviceCodecSpec } from "@hash8/dcs-schema";
import acme from "../../../samples/specs/acme.tracker-gt200.json";
import voltix from "../../../samples/specs/voltix.energy-em3.json";
import envio from "../../../samples/specs/envio.th-sense.json";
import type { CatalogModel } from "@hash8/sdk-ts";

export const acmeSpec = (): DeviceCodecSpec => parseSpec(structuredClone(acme));
export const voltixSpec = (): DeviceCodecSpec => parseSpec(structuredClone(voltix));
export const envioSpec = (): DeviceCodecSpec => parseSpec(structuredClone(envio));

export function model(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "envio-th-sense",
    partnerId: "ptn_envio",
    vendor: "Envio Sensors",
    name: "TH-Sense LoRaWAN",
    category: "environment",
    description: "Indoor temperature & humidity sensor",
    protocols: ["lorawan"],
    connectivity: ["lorawan"],
    powerSource: "battery",
    latestFirmware: "1.1.0",
    codecId: "envio.th-sense",
    codecVersion: "1.1.0",
    pluginTargets: ["ts", "ts013", "python", "c"],
    certification: { level: "listed", badges: ["listed"] },
    compatibility: [],
    adoption: { devices: 0, customers: 0, pluginDownloads: 0 },
    tags: ["otaa"],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

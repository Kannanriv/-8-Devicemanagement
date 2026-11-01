import type { Device, DeviceHealth, OtaCampaign } from "@hash8/sdk-ts";

export const NOW = new Date("2026-10-31T12:00:00.000Z");

export function makeDevice(over: Partial<Device> = {}, health: Partial<DeviceHealth> = {}): Device {
  return {
    id: "dev-1",
    udi: "UDI-0001",
    tenantId: "t-1",
    oemTenantId: "oem-1",
    oem: "Acme",
    modelId: "m-1",
    model: "Tracker X",
    serial: "SN1",
    lifecycle: "activated",
    provisioning: "provisioned",
    firmwareVersion: "1.2.0",
    codecId: "acme-tracker",
    codecVersion: "2.1.0",
    tags: [],
    health: { score: 90, level: "normal", connectivity: "online", battery: 80, issues: [], ...health },
    shadow: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

export function makeCampaign(over: Partial<OtaCampaign> = {}): OtaCampaign {
  return {
    id: "c-1",
    tenantId: "t-1",
    name: "fw 1.3.0",
    firmwareId: "fw-1",
    fromVersions: ["^1.2.0"],
    cohort: {},
    status: "draft",
    waves: [
      { name: "canary", percent: 1, status: "pending", targeted: 2, succeeded: 0, failed: 0 },
      { name: "100%", percent: 100, status: "pending", targeted: 10, succeeded: 0, failed: 0 },
    ],
    healthGate: { maxFailureRate: 0.05, minHealthScore: 60 },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

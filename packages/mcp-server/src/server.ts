import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LIFECYCLE_TRANSITIONS,
  type AgentName,
  type AgentRun,
  type Alert,
  type Asset,
  type AssetAssociation,
  type BulkOp,
  type BulkPreview,
  type DeviceCredential,
  type DeviceQuery,
  type FleetReport,
  type InventoryKpis,
  type TimelineKind,
  type CodecVersionSummary,
  type Command,
  type Device,
  type DeviceMessage,
  type FleetStats,
  type LifecycleState,
  type OpsItem,
  type OtaCampaign,
  type Page,
  type TimelineEvent,
} from "@hash8/sdk-ts";

/** The subset of Hash8Client the MCP server needs — lets tests pass a fake. */
export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export const SERVER_NAME = "hash8-dm";
export const SERVER_VERSION = "0.1.0";
/** Hard cap on characters returned per tool call so a single call can't flood the model context. */
export const CHARACTER_LIMIT = 25_000;

const LIFECYCLE_STATES = Object.keys(LIFECYCLE_TRANSITIONS) as [LifecycleState, ...LifecycleState[]];
export const AGENT_NAMES = [
  "spec-extractor",
  "codec-verifier",
  "payload-triage",
  "rollout-guardian",
  "fleet-copilot",
  "anomaly-sentinel",
  "integration-builder",
] as const satisfies readonly AgentName[];

export const TIMELINE_KINDS = [
  "message",
  "lifecycle",
  "command",
  "config",
  "ota",
  "alert",
  "audit",
  "association",
  "ownership",
  "technician",
  "security",
] as const satisfies readonly TimelineKind[];

export const BULK_OPS = [
  "assign",
  "lifecycle",
  "apply_config",
  "start_ota",
  "suspend",
  "reactivate",
  "diagnostics",
  "command",
  "tag",
  "transfer",
  "export",
] as const satisfies readonly BulkOp[];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown, note?: string): ToolResult {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n…[truncated ${text.length - CHARACTER_LIMIT} chars — narrow the query with filters or a smaller limit]`;
  }
  return { content: [{ type: "text", text: note ? `${note}\n\n${text}` : text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function errMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|fetch failed/i.test(msg)) {
    return `${msg}. Is the #8 API running? Start it with \`npm run dev:api\` or set HASH8_API_URL.`;
  }
  if (/→ 404/.test(msg)) return `${msg}. Check the id — use search_devices / list_codecs / list_campaigns to find valid ids.`;
  return msg;
}

/** Wrap a handler so API failures become actionable tool errors instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(errMessage(e));
    }
  };
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

/** Lists may come back as a bare array or a Page<T>; normalise. */
function items<T>(res: T[] | Page<T>): T[] {
  return Array.isArray(res) ? res : (res?.items ?? []);
}

function deviceSummary(d: Device) {
  return {
    id: d.id,
    udi: d.udi,
    serial: d.serial,
    name: d.name,
    oem: d.oem,
    model: d.model ?? d.modelId,
    organization: d.organization,
    branch: d.branch,
    // lifecycle, connectivity and health are separate axes
    lifecycle: d.lifecycle,
    connectivity: d.health?.connectivity,
    healthLevel: d.health?.level,
    healthScore: d.health?.score,
    battery: d.health?.battery,
    lastSeenAt: d.health?.lastSeenAt,
    firmwareVersion: d.firmwareVersion,
    otaStatus: d.otaStatus,
    asset: d.assetId ? { id: d.assetId, name: d.assetName } : undefined,
    sim: d.sim ? { iccid: d.sim.iccid, carrier: d.sim.carrier, status: d.sim.status } : undefined,
    codec: d.codecId ? `${d.codecId}@${d.codecVersion ?? "?"}` : undefined,
    tags: d.tags,
    site: d.site?.name,
  };
}

/** Accepts a device id, UDI, serial or IMEI. Tries the id route first, then an exact-match search. */
async function resolveDevice(client: ApiClient, idOrSerial: string): Promise<Device> {
  try {
    return await client.get<Device>(`/devices/${enc(idOrSerial)}`);
  } catch (e) {
    const page = await client.get<Page<Device> | Device[]>(`/devices${qs({ q: idOrSerial, limit: 20 })}`);
    const hit = items(page).find(
      (d) => d.serial === idOrSerial || d.id === idOrSerial || d.udi === idOrSerial || d.imei === idOrSerial,
    );
    if (hit) return hit;
    throw e;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

interface FieldLike {
  kind?: string;
  name: string;
  type?: string;
  bits?: number;
  length?: number | string;
  unit?: string;
  enum?: Record<string, string>;
  fields?: FieldLike[];
  cases?: Record<string, FieldLike[]>;
  default?: unknown;
}
interface SpecLike {
  id: string;
  version: string;
  device: Record<string, unknown>;
  uplink?: { name: string; description?: string; when?: unknown; fields: FieldLike[] }[];
  downlink?: { name: string; description?: string; when?: unknown; fields: FieldLike[] }[];
  vectors?: unknown[];
}

function describeField(f: FieldLike): string {
  const kind = f.kind ?? "scalar";
  if (kind === "group" || kind === "repeat") return `${f.name}{${(f.fields ?? []).map(describeField).join(", ")}}${kind === "repeat" ? "[]" : ""}`;
  if (kind === "switch") return `${f.name}<switch: ${Object.keys(f.cases ?? {}).join("|")}>`;
  if (kind === "const" || kind === "checksum") return `(${kind} ${f.name})`;
  const unit = f.unit ? ` ${f.unit}` : "";
  const en = f.enum ? ` enum{${Object.values(f.enum).join("|")}}` : "";
  return `${f.name}:${f.type}${f.bits ? f.bits : ""}${unit}${en}`;
}

export function summariseSpec(spec: SpecLike) {
  const msg = (m: { name: string; description?: string; when?: unknown; fields: FieldLike[] }) => ({
    name: m.name,
    description: m.description,
    when: m.when,
    fields: m.fields.map(describeField),
  });
  return {
    id: spec.id,
    version: spec.version,
    device: spec.device,
    uplink: (spec.uplink ?? []).map(msg),
    downlink: (spec.downlink ?? []).map(msg),
    vectors: spec.vectors?.length ?? 0,
  };
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createServer(client: ApiClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ── Operations ────────────────────────────────────────────────────────────
  server.registerTool(
    "ops_inbox",
    {
      title: "Ops inbox",
      description:
        "Start here. Returns the prioritised operations inbox for the tenant: stalled/failing OTA rollouts, unknown-payload spikes, offline cohorts, certificate expiry, codec specs awaiting review, config drift and open alerts. Each item has severity, a summary, a count, the console route and a suggested action (often an AI agent to run via run_agent).",
      inputSchema: {
        severity: z.enum(["info", "warning", "critical"]).optional().describe("Only return items at this severity."),
      },
      annotations: { ...READ, title: "Ops inbox" },
    },
    safe(async ({ severity }) => {
      const res = items(await client.get<OpsItem[] | Page<OpsItem>>("/ops/inbox"));
      const filtered = severity ? res.filter((i) => i.severity === severity) : res;
      return ok(filtered, `${filtered.length} inbox item(s).`);
    }),
  );

  server.registerTool(
    "fleet_stats",
    {
      title: "Fleet stats",
      description:
        "Fleet-wide KPIs: device count, online/offline, messages in the last 24h, decode success rate (0..1), average health score, active OTA campaigns and open alerts.",
      inputSchema: {},
      annotations: { ...READ, title: "Fleet stats" },
    },
    safe(async () => ok(await client.get<FleetStats>("/fleet/stats"))),
  );

  // ── Inventory ─────────────────────────────────────────────────────────────
  server.registerTool(
    "search_devices",
    {
      title: "Search devices",
      description:
        "Search the device inventory. Free-text `q` matches UDI, serial, IMEI, ICCID and name. Lifecycle (registered → assigned → installing → pending_activation → activated, maintenance/suspended/swap, retired), connectivity (online|stale|offline|never_seen) and health (normal|warning|critical) are independent filters. Also filter by organization, branch, OEM, model, firmware, asset, tag, install date or last-seen window. Returns compact summaries plus `total` and a `cursor`. Use get_device for the full record incl. shadow.",
      inputSchema: {
        q: z.string().optional().describe("Free text: UDI, serial, IMEI, ICCID or name fragment."),
        organization: z.string().optional(),
        branch: z.string().optional(),
        oem: z.string().optional(),
        modelId: z.string().optional(),
        lifecycle: z.enum(LIFECYCLE_STATES).optional(),
        connectivity: z.enum(["online", "stale", "offline", "never_seen"]).optional(),
        health: z.enum(["normal", "warning", "critical"]).optional(),
        firmwareVersion: z.string().optional(),
        assetId: z.string().optional(),
        tag: z.string().optional(),
        installedFrom: z.string().optional().describe("ISO date"),
        installedTo: z.string().optional().describe("ISO date"),
        lastSeenBefore: z.string().optional().describe("ISO datetime — e.g. find devices silent since then"),
        lastSeenAfter: z.string().optional().describe("ISO datetime"),
        sort: z.enum(["lastSeen", "health", "udi", "installedAt"]).optional(),
        limit: z.number().int().min(1).max(200).default(25),
        cursor: z.string().optional().describe("Pagination cursor from a previous call."),
      },
      annotations: { ...READ, title: "Search devices" },
    },
    safe(async (args) => {
      const page = await client.get<Page<Device> | Device[]>(`/devices${qs(args)}`);
      const list = items(page);
      const total = Array.isArray(page) ? list.length : page.total;
      const cursor = Array.isArray(page) ? undefined : page.cursor;
      return ok({ total, returned: list.length, cursor, hasMore: Boolean(cursor), devices: list.map(deviceSummary) });
    }),
  );

  server.registerTool(
    "get_device",
    {
      title: "Get device",
      description:
        "Full device record by id or serial: lifecycle, health (score, connectivity, battery, signal, issues), firmware, codec, tags, site and the shadow (latest decoded values), plus `allowedTransitions` — the lifecycle states change_lifecycle can move it to.",
      inputSchema: {
        device: z.string().min(1).describe("Device id or serial."),
      },
      annotations: { ...READ, title: "Get device" },
    },
    safe(async ({ device }) => {
      const d = await resolveDevice(client, device);
      return ok({ ...d, allowedTransitions: LIFECYCLE_TRANSITIONS[d.lifecycle] ?? [] });
    }),
  );

  server.registerTool(
    "device_messages",
    {
      title: "Device messages",
      description:
        "Most recent raw + decoded messages of a device (newest first): transport, port/topic, payload hex, decode status (decoded|unknown|error), message name, decoded data, warnings/errors and codec version. Use to debug decoding or inspect telemetry.",
      inputSchema: {
        device: z.string().min(1).describe("Device id or serial."),
        limit: z.number().int().min(1).max(200).default(20),
        status: z.enum(["decoded", "unknown", "error"]).optional().describe("Only return messages with this decode status."),
      },
      annotations: { ...READ, title: "Device messages" },
    },
    safe(async ({ device, limit, status }) => {
      const d = await resolveDevice(client, device);
      const res = items(await client.get<DeviceMessage[] | Page<DeviceMessage>>(`/devices/${enc(d.id)}/messages${qs({ limit })}`));
      const filtered = status ? res.filter((m) => m.status === status) : res;
      return ok(filtered, `${filtered.length} message(s) for ${d.serial} (${d.id}).`);
    }),
  );

  server.registerTool(
    "device_timeline",
    {
      title: "Device timeline",
      description:
        "Unified chronological history of a device: messages, lifecycle changes, commands, config, OTA, alerts, asset associations, ownership transfers, technician visits, security events and audit. Best tool for 'what happened to this device?'.",
      inputSchema: {
        device: z.string().min(1).describe("Device id, UDI or serial."),
        limit: z.number().int().min(1).max(500).default(50),
        kinds: z
          .array(z.enum(TIMELINE_KINDS))
          .optional()
          .describe("Only return events of these kinds."),
      },
      annotations: { ...READ, title: "Device timeline" },
    },
    safe(async ({ device, limit, kinds }) => {
      const d = await resolveDevice(client, device);
      const res = items(
        await client.get<TimelineEvent[] | Page<TimelineEvent>>(
          `/devices/${enc(d.id)}/timeline${qs({ limit, kinds: kinds?.join(",") })}`,
        ),
      );
      return ok(kinds?.length ? res.filter((e) => kinds.includes(e.kind)) : res);
    }),
  );

  server.registerTool(
    "change_lifecycle",
    {
      title: "Change lifecycle state",
      description:
        "Move a device to a new lifecycle state: registered → assigned → installing → pending_activation → activated, with maintenance / suspended / swap side-states and retired (terminal, history retained). Only transitions allowed by the lifecycle graph succeed; the tool checks first and lists valid targets on rejection. Connectivity and health are separate axes and are not changed by this. Audited as the configured actor.",
      inputSchema: {
        device: z.string().min(1).describe("Device id or serial."),
        to: z.enum(LIFECYCLE_STATES).describe("Target lifecycle state."),
        note: z.string().max(500).optional().describe("Reason, recorded in the audit log and timeline."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: "Change lifecycle" },
    },
    safe(async ({ device, to, note }) => {
      const d = await resolveDevice(client, device);
      const allowed = LIFECYCLE_TRANSITIONS[d.lifecycle] ?? [];
      if (!allowed.includes(to)) {
        return fail(
          `cannot move ${d.serial} from "${d.lifecycle}" to "${to}". Allowed from ${d.lifecycle}: ${allowed.join(", ") || "(none — terminal state)"}.`,
        );
      }
      const updated = await client.post<Device>(`/devices/${enc(d.id)}/lifecycle`, { to, note });
      return ok(deviceSummary(updated), `${d.serial}: ${d.lifecycle} → ${updated.lifecycle ?? to}.`);
    }),
  );

  server.registerTool(
    "send_command",
    {
      title: "Send downlink command",
      description:
        "Queue a downlink command for a device. `message` must be a downlink message name from the device's codec (see get_codec); `data` holds its fields in physical units / enum labels. The API encodes it with the codec and delivers it on the device's transport. Returns the Command (status queued|sent|acked|failed…, payloadHex, port).",
      inputSchema: {
        device: z.string().min(1).describe("Device id or serial."),
        message: z.string().min(1).describe("DCS downlink message name, e.g. 'set_interval'."),
        data: z.record(z.string(), z.unknown()).default({}).describe("Field values for the downlink message."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: "Send command" },
    },
    safe(async ({ device, message, data }) => {
      const d = await resolveDevice(client, device);
      const cmd = await client.post<Command>(`/devices/${enc(d.id)}/commands`, { message, data });
      return ok(cmd, `Command ${cmd.id} for ${d.serial}: ${cmd.status}.`);
    }),
  );

  // ── Codecs ────────────────────────────────────────────────────────────────
  server.registerTool(
    "decode_payload",
    {
      title: "Decode payload",
      description:
        "Decode a hex payload with a codec (diagnostics, no side effects). Provide the codecId (from list_codecs), optional version (defaults to latest published), the hex string and the LoRaWAN fPort / MQTT topic when the codec selects messages by port or topic. Returns {ok, message, data, warnings} or {ok:false, errors}.",
      inputSchema: {
        codecId: z.string().min(1),
        version: z.string().optional(),
        hex: z
          .string()
          .min(2)
          .regex(/^(0x)?[0-9a-fA-F\s:-]+$/, "hex string expected")
          .describe("Payload as hex, e.g. '01A2FF'. Whitespace/colons allowed."),
        port: z.number().int().min(0).max(255).optional(),
        topic: z.string().optional(),
      },
      annotations: { ...READ, title: "Decode payload" },
    },
    safe(async (args) => ok(await client.post("/diagnostics/decode", args))),
  );

  server.registerTool(
    "list_codecs",
    {
      title: "List codecs",
      description:
        "List codec versions (Device Codec Specs): codecId, version, status (draft|in_review|published|deprecated), vendor/model, message & field counts and test-vector pass rate.",
      inputSchema: {
        status: z.enum(["draft", "in_review", "published", "deprecated"]).optional(),
        q: z.string().optional().describe("Filter by codecId/vendor/model substring (case-insensitive)."),
      },
      annotations: { ...READ, title: "List codecs" },
    },
    safe(async ({ status, q }) => {
      let res = items(await client.get<CodecVersionSummary[] | Page<CodecVersionSummary>>("/codecs"));
      if (status) res = res.filter((c) => c.status === status);
      if (q) {
        const needle = q.toLowerCase();
        res = res.filter((c) => `${c.codecId} ${c.vendor} ${c.model}`.toLowerCase().includes(needle));
      }
      return ok(res);
    }),
  );

  server.registerTool(
    "get_codec",
    {
      title: "Get codec",
      description:
        "Fetch a codec spec (DCS). `detail: \"summary\"` (default) returns messages with a one-line field layout each — enough to build send_command data. `detail: \"full\"` returns the complete DCS JSON incl. test vectors. Version defaults to the latest.",
      inputSchema: {
        codecId: z.string().min(1),
        version: z.string().optional(),
        detail: z.enum(["summary", "full"]).default("summary"),
      },
      annotations: { ...READ, title: "Get codec" },
    },
    safe(async ({ codecId, version, detail }) => {
      let v = version;
      if (!v) {
        const all = items(await client.get<CodecVersionSummary[] | Page<CodecVersionSummary>>("/codecs")).filter(
          (c) => c.codecId === codecId,
        );
        if (!all.length) return fail(`unknown codec "${codecId}". Use list_codecs to see available codec ids.`);
        const published = all.filter((c) => c.status === "published");
        const pool = published.length ? published : all;
        v = pool.map((c) => c.version).sort(compareSemver).at(-1)!;
      }
      const spec = await client.get<SpecLike>(`/codecs/${enc(codecId)}/versions/${enc(v)}`);
      return ok(detail === "full" ? spec : summariseSpec(spec));
    }),
  );

  // ── OTA ───────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_campaigns",
    {
      title: "List OTA campaigns",
      description:
        "List firmware OTA campaigns with status, rollout waves (targeted/succeeded/failed per wave) and the health gate (max failure rate, min health score).",
      inputSchema: {
        status: z.enum(["draft", "running", "paused", "completed", "rolled_back", "failed"]).optional(),
      },
      annotations: { ...READ, title: "List campaigns" },
    },
    safe(async ({ status }) => {
      const res = items(await client.get<OtaCampaign[] | Page<OtaCampaign>>("/ota/campaigns"));
      return ok(status ? res.filter((c) => c.status === status) : res);
    }),
  );

  server.registerTool(
    "pause_campaign",
    {
      title: "Pause OTA campaign",
      description:
        "Pause a running OTA campaign: no new devices are targeted until it is resumed (in the console or via the API). Devices mid-update finish their current download. Safe brake when failure rates climb. Audited.",
      inputSchema: {
        campaignId: z.string().min(1),
        reason: z.string().max(500).optional().describe("Why — recorded in the audit trail."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Pause campaign" },
    },
    safe(async ({ campaignId, reason }) => {
      const c = await client.post<OtaCampaign>(`/ota/campaigns/${enc(campaignId)}/pause`, reason ? { reason } : {});
      return ok(c, `Campaign ${c.name ?? campaignId} is now ${c.status ?? "paused"}.`);
    }),
  );

  // ── Alerts & agents ───────────────────────────────────────────────────────
  server.registerTool(
    "list_alerts",
    {
      title: "List alerts",
      description:
        "List alerts/incidents, newest first, optionally filtered by status, severity, category (device_failure, abnormal_telemetry, communication_loss, security, ota, other) or device.",
      inputSchema: {
        status: z.enum(["open", "acknowledged", "resolved"]).optional(),
        severity: z.enum(["info", "warning", "critical"]).optional(),
        category: z
          .enum(["device_failure", "abnormal_telemetry", "communication_loss", "security", "ota", "other"])
          .optional(),
        deviceId: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { ...READ, title: "List alerts" },
    },
    safe(async ({ status, severity, category, deviceId, limit }) => {
      let res = items(await client.get<Alert[] | Page<Alert>>(`/alerts${qs({ status, severity, category, deviceId })}`));
      if (status) res = res.filter((a) => a.status === status);
      if (severity) res = res.filter((a) => a.severity === severity);
      if (category) res = res.filter((a) => a.category === category);
      if (deviceId) res = res.filter((a) => a.deviceId === deviceId);
      res = [...res].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
      return ok(res, `${res.length} alert(s).`);
    }),
  );

  // ── Inventory KPIs, assets, bulk, reports, security ───────────────────────
  server.registerTool(
    "inventory_kpis",
    {
      title: "Inventory KPIs",
      description:
        "Inventory KPI cards: total devices; among activated devices how many are connected / stale / offline; not commissioned (never seen); attention required (health warning/critical or open critical alert — overlaps other counts); pending installation; activation in progress; OTA in progress; suspended; retired. Lifecycle and connectivity counts are separate axes and do not sum to the total.",
      inputSchema: {},
      annotations: { ...READ, title: "Inventory KPIs" },
    },
    safe(async () => ok(await client.get<InventoryKpis>("/inventory/kpis"))),
  );

  server.registerTool(
    "list_assets",
    {
      title: "List assets",
      description:
        "List assets (excavators, generators, trucks, cold rooms, meter points…) with their associated device ids. Filter by free text (name/serial/make/model), type, organization or branch. Pass `assetId` to get one asset with its full device-association history (who was installed when, swaps, removals).",
      inputSchema: {
        assetId: z.string().optional().describe("Return this asset plus its association history."),
        q: z.string().optional(),
        type: z.string().optional().describe("e.g. excavator, generator, truck, cold-room, meter-point"),
        organization: z.string().optional(),
        branch: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { ...READ, title: "List assets" },
    },
    safe(async ({ assetId, q, type, organization, branch, limit }) => {
      if (assetId) {
        const [asset, associations] = await Promise.all([
          client.get<Asset>(`/assets/${enc(assetId)}`),
          client.get<AssetAssociation[] | Page<AssetAssociation>>(`/assets/${enc(assetId)}/associations`),
        ]);
        return ok({ asset, associations: items(associations) });
      }
      let res = items(await client.get<Asset[] | Page<Asset>>(`/assets${qs({ q, type, organization, branch, limit })}`));
      if (q) {
        const needle = q.toLowerCase();
        res = res.filter((a) => `${a.name} ${a.serial ?? ""} ${a.make ?? ""} ${a.model ?? ""}`.toLowerCase().includes(needle));
      }
      if (type) res = res.filter((a) => a.type === type);
      if (organization) res = res.filter((a) => a.organization === organization);
      if (branch) res = res.filter((a) => a.branch === branch);
      res = res.slice(0, limit);
      return ok(res, `${res.length} asset(s).`);
    }),
  );

  server.registerTool(
    "swap_device",
    {
      title: "Swap device on asset",
      description:
        "Replace a device on an asset with another device (field swap). Closes the old device's association, opens one for the new device with reason 'swap', and moves the old device into the `swap` lifecycle state. Asset defaults to the old device's current asset. Both devices accept id, UDI or serial. Audited.",
      inputSchema: {
        oldDevice: z.string().min(1).describe("Device being removed (id, UDI or serial)."),
        newDevice: z.string().min(1).describe("Replacement device (id, UDI or serial)."),
        assetId: z.string().optional().describe("Defaults to the old device's assetId."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: "Swap device" },
    },
    safe(async ({ oldDevice, newDevice, assetId }) => {
      const [oldD, newD] = await Promise.all([resolveDevice(client, oldDevice), resolveDevice(client, newDevice)]);
      if (oldD.id === newD.id) return fail("old and new device are the same device.");
      const asset = assetId ?? oldD.assetId;
      if (!asset) return fail(`${oldD.serial} is not associated with an asset — pass assetId, or use list_assets to find it.`);
      if (newD.assetId && newD.assetId !== asset) {
        return fail(`${newD.serial} is already associated with asset ${newD.assetName ?? newD.assetId}; remove it there first.`);
      }
      if (newD.lifecycle === "retired" || newD.lifecycle === "suspended") {
        return fail(`${newD.serial} is ${newD.lifecycle} and cannot be installed as a replacement.`);
      }
      const res = await client.post<unknown>(`/assets/${enc(asset)}/swap`, { oldDeviceId: oldD.id, newDeviceId: newD.id });
      return ok(res, `Swapped ${oldD.serial} → ${newD.serial} on asset ${oldD.assetName ?? asset}.`);
    }),
  );

  server.registerTool(
    "bulk_preview",
    {
      title: "Preview bulk operation",
      description:
        "Dry-run a bulk operation (assign, lifecycle, apply_config, start_ota, suspend, reactivate, diagnostics, command, tag, transfer, export) on explicit device ids or a device query. Returns which devices are eligible, which are not and why, the permission required and warnings. No side effects — the operator confirms the actual bulk job in the console.",
      inputSchema: {
        op: z.enum(BULK_OPS),
        deviceIds: z.array(z.string()).max(10_000).optional(),
        query: z
          .object({
            q: z.string().optional(),
            organization: z.string().optional(),
            branch: z.string().optional(),
            oem: z.string().optional(),
            modelId: z.string().optional(),
            lifecycle: z.enum(LIFECYCLE_STATES).optional(),
            connectivity: z.enum(["online", "stale", "offline", "never_seen"]).optional(),
            health: z.enum(["normal", "warning", "critical"]).optional(),
            firmwareVersion: z.string().optional(),
            assetId: z.string().optional(),
            tag: z.string().optional(),
          })
          .optional()
          .describe("Device filter (same as search_devices) used when deviceIds is omitted."),
        params: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Op parameters, e.g. {to:'suspended'} for lifecycle, {firmwareId} for start_ota, {add:['x']} for tag."),
      },
      annotations: { ...READ, title: "Bulk preview" },
    },
    safe(async ({ op, deviceIds, query, params }) => {
      if (!deviceIds?.length && !query) return fail("pass deviceIds or a query.");
      const body: { op: BulkOp; params: Record<string, unknown>; deviceIds?: string[]; query?: DeviceQuery } = { op, params };
      if (deviceIds?.length) body.deviceIds = deviceIds;
      else if (query) body.query = query;
      const p = await client.post<BulkPreview>("/devices/bulk/preview", body);
      const summary = {
        op: p.op,
        eligibleCount: p.eligible?.length ?? 0,
        ineligibleCount: p.ineligible?.length ?? 0,
        requiresPermission: p.requiresPermission,
        warnings: p.warnings ?? [],
        ineligibleReasons: Object.entries(
          (p.ineligible ?? []).reduce<Record<string, number>>((acc, x) => ((acc[x.reason] = (acc[x.reason] ?? 0) + 1), acc), {}),
        ).map(([reason, count]) => ({ reason, count })),
        eligible: p.eligible?.slice(0, 200),
        ineligible: p.ineligible?.slice(0, 200),
      };
      return ok(summary, `${summary.eligibleCount} eligible, ${summary.ineligibleCount} ineligible for ${op}.`);
    }),
  );

  server.registerTool(
    "fleet_report",
    {
      title: "Fleet report",
      description:
        "Fleet report for a period: reliability (uptime %, MTBF, online series), deployment (installs, success rate, avg activation hours), OTA (campaigns, success rate, rollbacks), failures by cause and by model, connectivity (signal, data usage, by carrier) and utilization (messages, decode rate, active devices %). Defaults to the last 30 days.",
      inputSchema: {
        from: z.string().optional().describe("ISO date/time; default 30 days ago."),
        to: z.string().optional().describe("ISO date/time; default now."),
        includeSeries: z.boolean().default(false).describe("Include the reliability time series (can be long)."),
      },
      annotations: { ...READ, title: "Fleet report" },
    },
    safe(async ({ from, to, includeSeries }) => {
      const r = await client.get<FleetReport>(`/reports/fleet${qs({ from, to })}`);
      if (includeSeries || !r?.reliability) return ok(r);
      const { series, ...rel } = r.reliability;
      return ok({ ...r, reliability: { ...rel, seriesPoints: series?.length ?? 0 } });
    }),
  );

  server.registerTool(
    "revoke_credential",
    {
      title: "Revoke device credential",
      description:
        "Revoke a device credential (X.509 certificate, PSK or token) — the device can no longer authenticate and active sessions are dropped. Irreversible: a new credential must be issued to restore access. Pass `credentialId`, or `device` to revoke its single active credential (if it has several, the tool lists them and asks you to choose). A reason is required and audited.",
      inputSchema: {
        credentialId: z.string().optional(),
        device: z.string().optional().describe("Device id, UDI or serial (used when credentialId is omitted)."),
        reason: z.string().min(3).max(500).describe("Why — e.g. 'device reported stolen', 'key compromise'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: "Revoke credential" },
    },
    safe(async ({ credentialId, device, reason }) => {
      let id = credentialId;
      if (!id) {
        if (!device) return fail("pass credentialId or device.");
        const d = await resolveDevice(client, device);
        const creds = items(await client.get<DeviceCredential[] | Page<DeviceCredential>>(`/devices/${enc(d.id)}/credentials`));
        const live = creds.filter((c) => c.status === "active" || c.status === "expiring");
        if (!live.length) return fail(`${d.serial} has no active credentials.`);
        if (live.length > 1) {
          return fail(
            `${d.serial} has ${live.length} active credentials — pass credentialId: ` +
              live.map((c) => `${c.id} (${c.kind} ${c.fingerprint.slice(0, 16)}…, expires ${c.expiresAt ?? "never"})`).join("; "),
          );
        }
        id = live[0]!.id;
      }
      const c = await client.post<DeviceCredential>(`/credentials/${enc(id)}/revoke`, { reason });
      return ok(c, `Credential ${id} is now ${c.status ?? "revoked"}.`);
    }),
  );

  server.registerTool(
    "run_agent",
    {
      title: "Run #8 AI agent",
      description:
        "Run one of the platform's AI agents: spec-extractor (Excel → DCS), codec-verifier (vectors + round-trip), payload-triage (cluster unknown payloads, propose codec patches), rollout-guardian (watch OTA health gates), fleet-copilot (natural-language fleet questions), anomaly-sentinel (telemetry anomalies), integration-builder (webhook/CRM mappings). Returns the AgentRun; runs that change state stop at `awaiting_approval` for a human.",
      inputSchema: {
        agent: z.enum(AGENT_NAMES),
        input: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Agent input, e.g. {question} for fleet-copilot, {campaignId} for rollout-guardian, {codecId, version} for codec-verifier."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: "Run agent" },
    },
    safe(async ({ agent, input }) => {
      const run = await client.post<AgentRun>(`/agents/${enc(agent)}/run`, input);
      return ok(run, `Agent ${agent} run ${run.id ?? ""}: ${run.status ?? "started"}.`);
    }),
  );

  return server;
}

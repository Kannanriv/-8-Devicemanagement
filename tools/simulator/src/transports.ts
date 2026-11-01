/** Uplink publishers for the three dev ingestion paths of apps/api. */
import dgram from "node:dgram";
import mqtt, { type MqttClient } from "mqtt";
import { toHex } from "@hash8/dcs-schema";

export interface Downlink {
  serial: string;
  payload: Buffer;
  topic: string;
}

export interface Publisher {
  /** Resolves when the transport confirms the send (MQTT PUBACK, HTTP 2xx, UDP flush). */
  publish(serial: string, port: number | undefined, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
export function httpPublisher(api: string): Publisher {
  const base = `${api}/api/v1/ingest/http/`;
  return {
    async publish(serial, port, bytes) {
      const res = await fetch(base + encodeURIComponent(serial), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(port === undefined ? { hex: toHex(bytes) } : { hex: toHex(bytes), port }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
      }
      await res.arrayBuffer().catch(() => undefined);
    },
    async close() {},
  };
}

// ── UDP ─────────────────────────────────────────────────────────────────────
export function udpPublisher(host: string, port: number): Publisher {
  const sock = dgram.createSocket("udp4");
  sock.unref();
  return {
    publish(serial, fport, bytes) {
      const msg = Buffer.from(`${serial}|${fport ?? ""}|${toHex(bytes)}`);
      return new Promise((resolve, reject) => sock.send(msg, port, host, (err) => (err ? reject(err) : resolve())));
    },
    async close() {
      await new Promise<void>((r) => sock.close(() => r()));
    },
  };
}

// ── MQTT ────────────────────────────────────────────────────────────────────
export const upTopic = (serial: string, port?: number) => (port === undefined ? `dev/${serial}/up` : `dev/${serial}/up/${port}`);
export const DOWN_FILTER = "dev/+/down";

/** Parse `dev/{serial}/down[/...]` → serial. */
export function serialFromDownTopic(topic: string): string | undefined {
  const m = /^dev\/([^/]+)\/down(?:\/.*)?$/.exec(topic);
  return m?.[1];
}

/**
 * Downlinks may arrive as raw codec bytes, or as JSON `{id|commandId, hex, port}`.
 * Returns the command id (if any) and the payload bytes.
 */
export function parseDownlink(payload: Buffer): { commandId?: string; hex: string; port?: number } {
  const text = payload.toString("utf8").trim();
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { id?: string; commandId?: string; hex?: string; payloadHex?: string; port?: number };
      return { commandId: j.commandId ?? j.id, hex: (j.hex ?? j.payloadHex ?? "").toLowerCase(), port: j.port };
    } catch {
      /* fall through: binary that happens to start with '{' */
    }
  }
  return { hex: toHex(payload) };
}

export async function mqttPublisher(
  url: string,
  connections: number,
  onDownlink?: (d: Downlink) => void,
): Promise<Publisher> {
  const clients: MqttClient[] = [];
  for (let i = 0; i < connections; i++) {
    clients.push(
      await mqtt.connectAsync(url, {
        clientId: `hash8-sim-${process.pid}-${i}`,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 5000,
      }),
    );
  }
  const pick = (serial: string) => {
    let h = 0;
    for (let i = 0; i < serial.length; i++) h = (h * 31 + serial.charCodeAt(i)) | 0;
    return clients[Math.abs(h) % clients.length]!;
  };
  if (onDownlink && clients[0]) {
    const c0 = clients[0];
    await c0.subscribeAsync(DOWN_FILTER, { qos: 1 });
    c0.on("message", (topic, payload) => {
      const serial = serialFromDownTopic(topic);
      if (!serial) return;
      onDownlink({ serial, payload, topic });
    });
  }
  return {
    async publish(serial, port, bytes) {
      await pick(serial).publishAsync(upTopic(serial, port), Buffer.from(bytes), { qos: 1 });
    },
    async close() {
      await Promise.all(clients.map((c) => c.endAsync()));
    },
  };
}

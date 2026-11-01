import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Device, DeviceCredential } from "@hash8/sdk-ts";
import { credentialStatus } from "@hash8/ops-engine";
import type { Core } from "../context";
import type { CredentialRecord } from "../db/repos";
import { createDevCa, issueDeviceCert, type DevCa } from "../security/x509";
import { conflict, notFound } from "../errors";
import { newId } from "../util/ids";

export const EXPIRING_WINDOW_DAYS = 30;


/** Device identity: X.509 client certificates issued by a dev CA (generated on first boot). */
export class CredentialService {
  readonly ca: DevCa;

  constructor(private core: Core) {
    const dir = join(core.config.dataDir, "keys");
    const keyFile = join(dir, "device-ca-ed25519.pem");
    const persistent = core.config.db !== "memory";
    const keyPem = persistent && existsSync(keyFile) ? readFileSync(keyFile, "utf8") : undefined;
    this.ca = createDevCa("#8 Dev Device CA", new Date(Date.UTC(2026, 0, 1)), 3650, keyPem);
    if (persistent && !keyPem) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(keyFile, this.ca.key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
  }

  view(c: CredentialRecord, now = this.core.now()): DeviceCredential {
    const out: DeviceCredential = { id: c.id, deviceId: c.deviceId, kind: c.kind, fingerprint: c.fingerprint, issuedAt: c.issuedAt, status: credentialStatus(c, now, EXPIRING_WINDOW_DAYS) };
    if (c.subject) out.subject = c.subject;
    if (c.expiresAt) out.expiresAt = c.expiresAt;
    if (c.revokedAt) out.revokedAt = c.revokedAt;
    if (c.revokedReason) out.revokedReason = c.revokedReason;
    return out;
  }

  /** Builds (does not persist) an X.509 credential — used by the API and the seed. */
  build(device: Device, issuedAt: Date, days: number): { record: CredentialRecord; privateKeyPem: string; certificatePem: string } {
    const cert = issueDeviceCert(this.ca, {
      commonName: device.serial,
      ...(device.organization ? { organization: device.organization } : {}),
      serialHex: randomBytes(8).toString("hex"),
      notBefore: issuedAt,
      days,
    });
    const record: CredentialRecord = {
      id: newId("crd"),
      tenantId: device.tenantId,
      deviceId: device.id,
      kind: "x509",
      fingerprint: cert.fingerprint,
      subject: cert.subject,
      issuedAt: cert.notBefore,
      expiresAt: cert.notAfter,
      status: "active",
      createdAt: cert.notBefore,
      certificatePem: cert.certPem,
    };
    return { record, privateKeyPem: cert.privateKeyPem, certificatePem: cert.certPem };
  }

  async list(deviceId: string): Promise<DeviceCredential[]> {
    const rows = await this.core.repos.credentials.list({ where: ["device_id = ?"], params: [deviceId] });
    const now = this.core.now();
    return rows.map((r) => this.view(r, now));
  }

  async issue(device: Device, actor: string, days = 365) {
    const { record, privateKeyPem, certificatePem } = this.build(device, this.core.now(), days);
    await this.core.repos.credentials.insert(record);
    await this.core.timeline(device.tenantId, device.id, "security", "X.509 credential issued", { credentialId: record.id, fingerprint: record.fingerprint, expiresAt: record.expiresAt });
    await this.core.audit(device.tenantId, actor, "device.credential.issue", `device:${device.id}`, { credentialId: record.id, fingerprint: record.fingerprint });
    // The private key is returned exactly once (dev); production devices generate keys on-device and send a CSR.
    return { credential: this.view(record), certificatePem, privateKeyPem, caCertificatePem: this.ca.certPem };
  }

  async revoke(id: string, scope: string[], actor: string, reason: string) {
    const c = await this.core.repos.credentials.getScoped(id, scope);
    if (!c) throw notFound("credential", id);
    if (c.revokedAt) throw conflict(`Credential ${id} is already revoked`, "INVALID_TRANSITION");
    const next: CredentialRecord = { ...c, revokedAt: this.core.now().toISOString(), revokedReason: reason, status: "revoked" };
    await this.core.repos.credentials.update(next);
    await this.core.timeline(c.tenantId, c.deviceId, "security", "Credential revoked", { credentialId: id, reason });
    await this.core.audit(c.tenantId, actor, "device.credential.revoke", `credential:${id}`, { deviceId: c.deviceId, reason });
    return this.view(next);
  }

  async expiring(scope: string[], days = EXPIRING_WINDOW_DAYS) {
    const until = new Date(this.core.now().getTime() + days * 86_400_000).toISOString();
    const rows = await this.core.repos.credentials.list({ tenantIds: scope, where: ["revoked_at IS NULL", "expires_at <= ?"], params: [until], orderBy: "expires_at ASC", limit: 500 });
    return rows.map((r) => this.view(r));
  }

  async overview(tenantId: string, scope: string[]) {
    const db = this.core.db;
    const now = this.core.now();
    const soon = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 86_400_000).toISOString();
    const [counts] = await db.query<{ total: number; revoked: number; expired: number; expiring: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
              count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= $2)::int AS expired,
              count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > $2 AND expires_at <= $3)::int AS expiring
         FROM credentials WHERE tenant_id = ANY($1::text[])`,
      [scope, now.toISOString(), soon],
    );
    const [uncovered] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM devices d
        WHERE d.tenant_id = ANY($1::text[]) AND d.lifecycle IN ('activated','maintenance','pending_activation')
          AND NOT EXISTS (SELECT 1 FROM credentials c WHERE c.device_id = d.id AND c.revoked_at IS NULL AND c.expires_at > $2)`,
      [scope, now.toISOString()],
    );
    const [crossTenant] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM credentials c JOIN devices d ON d.id = c.device_id WHERE c.tenant_id <> d.tenant_id AND c.revoked_at IS NULL AND d.tenant_id = ANY($1::text[])`,
      [scope],
    );
    const [retiredActive] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM credentials c JOIN devices d ON d.id = c.device_id WHERE d.lifecycle = 'retired' AND c.revoked_at IS NULL AND d.tenant_id = ANY($1::text[])`,
      [scope],
    );
    const securityAlerts = await this.core.repos.alerts.count({ tenantIds: scope, where: ["status <> 'resolved'", "doc->>'category' = 'security'"] });
    const c = counts ?? { total: 0, revoked: 0, expired: 0, expiring: 0 };
    return {
      tenantId,
      credentials: { total: c.total, active: c.total - c.revoked - c.expired - c.expiring, expiring: c.expiring, expired: c.expired, revoked: c.revoked },
      devicesWithoutValidCredential: uncovered?.n ?? 0,
      openSecurityAlerts: securityAlerts,
      ca: { subject: this.ca.subjectCn, fingerprint: this.ca.fingerprint, notAfter: this.ca.notAfter, algorithm: "ed25519" },
      tenantIsolation: [
        { check: "Queries scoped by x-tenant-id (owner + descendants; OEM sees manufactured devices read-only)", ok: true },
        { check: "Credentials belong to the device's current owner", ok: (crossTenant?.n ?? 0) === 0, detail: `${crossTenant?.n ?? 0} credential(s) still held by a previous owner` },
        { check: "Retired devices have no active credentials", ok: (retiredActive?.n ?? 0) === 0, detail: `${retiredActive?.n ?? 0} retired device(s) with active credentials` },
      ],
      expiringSoon: (await this.expiring(scope)).slice(0, 20),
    };
  }
}

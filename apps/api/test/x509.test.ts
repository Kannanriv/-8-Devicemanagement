import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { createDevCa, issueDeviceCert } from "../src/security/x509";

describe("dev CA X.509 issuance", () => {
  it("creates a self-signed CA that parses and verifies", () => {
    const ca = createDevCa("#8 Dev Device CA", new Date("2026-01-01T00:00:00Z"), 3650);
    const x = new X509Certificate(ca.certPem);
    expect(x.subject).toContain("#8 Dev Device CA");
    expect(x.ca).toBe(true);
    expect(x.verify(x.publicKey)).toBe(true);
  });

  it("issues a device leaf cert signed by the CA with the requested validity", () => {
    const ca = createDevCa("#8 Dev Device CA", new Date("2026-01-01T00:00:00Z"), 3650);
    const notBefore = new Date("2026-10-01T00:00:00Z");
    const leaf = issueDeviceCert(ca, { commonName: "ACM-GT200-001000", organization: "Metro Utilities", serialHex: "0a1b2c", notBefore, days: 365 });
    const x = new X509Certificate(leaf.certPem);
    expect(x.subject).toContain("CN=ACM-GT200-001000");
    expect(x.issuer).toContain("#8 Dev Device CA");
    expect(x.ca).toBe(false);
    expect(x.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2027);
    expect(leaf.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(leaf.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("encodes serials with leading zero bytes as minimal DER integers", () => {
    const ca = createDevCa("#8 Dev Device CA", new Date("2026-01-01T00:00:00Z"), 3650);
    for (const serialHex of ["0001ab", "00ff", "80", "0000000000000001"]) {
      const leaf = issueDeviceCert(ca, { commonName: "X", serialHex, notBefore: new Date("2026-10-01T00:00:00Z"), days: 30 });
      expect(new X509Certificate(leaf.certPem).serialNumber.replace(/^0+/, "")).toBe(serialHex.replace(/^0+/, "").toUpperCase());
    }
  });

  it("re-creates the same CA from a persisted key", () => {
    const a = createDevCa("#8 Dev Device CA", new Date("2026-01-01T00:00:00Z"), 3650);
    const pem = a.key.export({ type: "pkcs8", format: "pem" }).toString();
    const b = createDevCa("#8 Dev Device CA", new Date("2026-01-01T00:00:00Z"), 3650, pem);
    expect(new X509Certificate(b.certPem).publicKey.export({ type: "spki", format: "pem" })).toEqual(
      new X509Certificate(a.certPem).publicKey.export({ type: "spki", format: "pem" }),
    );
  });
});

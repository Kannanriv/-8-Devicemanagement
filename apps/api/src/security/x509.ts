import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from "node:crypto";

/**
 * Minimal DER / X.509 v3 writer (Ed25519 only) so the dev CA can issue real,
 * standards-conformant device certificates with nothing but node:crypto.
 * Production replaces this with a managed PKI / HSM-backed CA.
 */
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function integer(hex: string): Buffer {
  let b = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  // DER INTEGER must be minimal: drop redundant leading zero bytes, then pad if the sign bit is set.
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const octet = (b: Buffer) => tlv(0x04, b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
function time(d: Date): Buffer {
  const y = d.getUTCFullYear();
  const p = (n: number) => String(n).padStart(2, "0");
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${body}`)) : tlv(0x18, Buffer.from(`${y}${body}`));
}

const OID = {
  cn: "2.5.4.3",
  o: "2.5.4.10",
  ou: "2.5.4.11",
  ed25519: "1.3.101.112",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  clientAuth: "1.3.6.1.5.5.7.3.2",
};

function name(attrs: { cn: string; o?: string; ou?: string }): Buffer {
  const rdns = [set(seq(oid(OID.cn), utf8(attrs.cn)))];
  if (attrs.o) rdns.push(set(seq(oid(OID.o), utf8(attrs.o))));
  if (attrs.ou) rdns.push(set(seq(oid(OID.ou), utf8(attrs.ou))));
  return seq(...rdns);
}

function buildCert(opts: { serialHex: string; issuer: Buffer; subject: Buffer; notBefore: Date; notAfter: Date; subjectKey: KeyObject; signer: KeyObject; ca: boolean }): string {
  const algo = seq(oid(OID.ed25519));
  const spki = opts.subjectKey.export({ type: "spki", format: "der" });
  // keyUsage BIT STRING: CA → keyCertSign|cRLSign (unused bits 1, 0x06); leaf → digitalSignature (unused 7, 0x80)
  const keyUsageBits = opts.ca ? Buffer.from([0x01, 0x06]) : Buffer.from([0x07, 0x80]);
  const exts = [
    seq(oid(OID.basicConstraints), bool(true), octet(seq(...(opts.ca ? [bool(true)] : [])))),
    seq(oid(OID.keyUsage), bool(true), octet(tlv(0x03, keyUsageBits))),
  ];
  if (!opts.ca) exts.push(seq(oid(OID.extKeyUsage), octet(seq(oid(OID.clientAuth)))));
  const tbs = seq(
    tlv(0xa0, integer("02")),
    integer(opts.serialHex),
    algo,
    opts.issuer,
    seq(time(opts.notBefore), time(opts.notAfter)),
    opts.subject,
    spki,
    tlv(0xa3, seq(...exts)),
  );
  const sig = sign(null, tbs, opts.signer);
  const der = seq(tbs, algo, bitString(sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

const CA_ORG = "#8 Device Management (dev)";

export interface DevCa {
  certPem: string;
  key: KeyObject;
  subjectCn: string;
  fingerprint: string;
  notAfter: string;
}

export function createDevCa(commonName: string, now: Date, days: number, keyPem?: string): DevCa {
  const key = keyPem ? createPrivateKey(keyPem) : generateKeyPairSync("ed25519").privateKey;
  const n = name({ cn: commonName, o: CA_ORG });
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  const certPem = buildCert({ serialHex: "01", issuer: n, subject: n, notBefore: now, notAfter, subjectKey: createPublicKey(key), signer: key, ca: true });
  return { certPem, key, subjectCn: commonName, fingerprint: new X509Certificate(certPem).fingerprint256, notAfter: notAfter.toISOString() };
}

export interface IssuedCert {
  certPem: string;
  privateKeyPem: string;
  fingerprint: string;
  subject: string;
  notBefore: string;
  notAfter: string;
}

export function issueDeviceCert(ca: DevCa, o: { commonName: string; organization?: string; serialHex: string; notBefore: Date; days: number }): IssuedCert {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const notAfter = new Date(o.notBefore.getTime() + o.days * 86_400_000);
  const subject = name({ cn: o.commonName, ...(o.organization ? { o: o.organization } : {}), ou: "devices" });
  const issuer = name({ cn: ca.subjectCn, o: CA_ORG });
  const certPem = buildCert({ serialHex: o.serialHex, issuer, subject, notBefore: o.notBefore, notAfter, subjectKey: publicKey, signer: ca.key, ca: false });
  const x = new X509Certificate(certPem);
  return {
    certPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: x.fingerprint256,
    subject: x.subject.replace(/\n/g, ", "),
    notBefore: o.notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
  };
}

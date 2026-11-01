import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Firmware } from "@hash8/sdk-ts";
import type { Core } from "../context";
import type { FirmwareRow } from "../db/repos";
import { conflict, notFound } from "../errors";
import { newId } from "../util/ids";

/**
 * Firmware store: binaries on disk (`data/firmware`), sha256 + ed25519 signature.
 * Dev signing key is generated on first boot (persisted next to the data dir); in
 * production the key lives in a KMS/HSM and only the public key ships to devices.
 */
export class FirmwareService {
  private priv: KeyObject;
  readonly publicKeyPem: string;

  constructor(private core: Core) {
    const keyDir = join(core.config.dataDir, "keys");
    const keyFile = join(keyDir, "firmware-signing-ed25519.pem");
    if (core.config.db !== "memory" && existsSync(keyFile)) {
      this.priv = createPrivateKey(readFileSync(keyFile));
    } else {
      this.priv = generateKeyPairSync("ed25519").privateKey;
      if (core.config.db !== "memory") {
        mkdirSync(keyDir, { recursive: true });
        writeFileSync(keyFile, this.priv.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      }
    }
    this.publicKeyPem = createPublicKey(this.priv).export({ type: "spki", format: "pem" }).toString();
  }

  sign(bytes: Uint8Array): string {
    return sign(null, bytes, this.priv).toString("base64");
  }
  verify(bytes: Uint8Array, signature: string): boolean {
    return verify(null, bytes, createPublicKey(this.priv), Buffer.from(signature, "base64"));
  }

  async create(
    tenantId: string,
    input: { modelId: string; version: string; codecVersion?: string; releaseNotes?: string; fileName?: string },
    bytes: Uint8Array,
    actor: string,
  ): Promise<Firmware> {
    const model = await this.core.repos.models.get(input.modelId);
    if (!model) throw notFound("model", input.modelId);
    const dup = await this.core.repos.firmware.list({ where: ["model_id = ?", "version = ?"], params: [input.modelId, input.version], limit: 1 });
    if (dup.length) throw conflict(`Firmware ${input.version} already exists for model ${input.modelId}`);
    const id = newId("fw");
    mkdirSync(this.core.config.firmwareDir, { recursive: true });
    const filePath = join(this.core.config.firmwareDir, `${id}.bin`);
    writeFileSync(filePath, bytes);
    const fw: FirmwareRow = {
      id,
      tenantId,
      modelId: input.modelId,
      version: input.version,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature: this.sign(bytes),
      createdAt: this.core.now().toISOString(),
      filePath,
    };
    if (input.codecVersion) fw.codecVersion = input.codecVersion;
    if (input.releaseNotes) fw.releaseNotes = input.releaseNotes;
    await this.core.repos.firmware.insert(fw);
    this.core.codecs.invalidate("fw");
    await this.core.audit(tenantId, actor, "firmware.upload", `firmware:${id}`, { modelId: fw.modelId, version: fw.version, sha256: fw.sha256, sizeBytes: fw.sizeBytes });
    return publicFirmware(fw);
  }
}

export function publicFirmware(f: FirmwareRow): Firmware {
  const { filePath: _p, ...rest } = f;
  return rest;
}

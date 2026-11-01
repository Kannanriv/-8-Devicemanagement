import type { CertificationLevel, CertificationStepName } from "@hash8/sdk-ts";

export const LEVELS: CertificationLevel[] = ["listed", "codec_verified", "ota_ready", "secure", "hash8_certified"];

export const LEVEL_LABEL: Record<CertificationLevel, string> = {
  listed: "Listed",
  codec_verified: "Codec verified",
  ota_ready: "OTA ready",
  secure: "Secure",
  hash8_certified: "#8 Certified",
};

export const STEP_ORDER: CertificationStepName[] = ["spec_import", "codec_vectors", "plugin_conformance", "ota_dry_run", "security_review", "interop"];

/** Steps each level adds on top of the previous one. */
const ADDS: Record<CertificationLevel, CertificationStepName[]> = {
  listed: ["spec_import"],
  codec_verified: ["codec_vectors", "plugin_conformance"],
  ota_ready: ["ota_dry_run"],
  secure: ["security_review"],
  hash8_certified: ["interop"],
};

export function levelRank(l: CertificationLevel | undefined): number {
  return l ? LEVELS.indexOf(l) : -1;
}

/** Cumulative steps required to reach `level`, in pipeline order. */
export function requiredSteps(level: CertificationLevel): CertificationStepName[] {
  const set = new Set(LEVELS.slice(0, levelRank(level) + 1).flatMap((l) => ADDS[l]));
  return STEP_ORDER.filter((s) => set.has(s));
}

/** All badges earned up to and including `level`. */
export function badgesFor(level: CertificationLevel): CertificationLevel[] {
  return LEVELS.slice(0, levelRank(level) + 1);
}

/** True for models that cleared at least codec verification. */
export function isCertified(level: CertificationLevel): boolean {
  return levelRank(level) >= levelRank("codec_verified");
}

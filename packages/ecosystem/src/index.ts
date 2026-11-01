/**
 * @hash8/ecosystem — partner network, certified device catalog, certification
 * pipeline, compatibility matrix, codec releases & subscriptions, ecosystem graph.
 * Pure logic: no I/O. The API persists; the console renders.
 */
export { diffSpecs, bumpVersion, compareSemver, actualBump, type SpecDiff, type SemverBump } from "./diff";
export { LEVELS, LEVEL_LABEL, STEP_ORDER, levelRank, requiredSteps, badgesFor, isCertified } from "./levels";
export { computeCompatibility } from "./compatibility";
export {
  certificationSteps,
  certificationStepsSync,
  runCertification,
  runCertificationSync,
  achievedLevel,
  securityReview,
  satisfies,
  type CertificationDeps,
} from "./certification";
export { rankCatalog, buildEcosystemGraph, ecosystemOverview, type CatalogQuery, type Adoption, type GraphRelation } from "./catalog";
export { buildSeed, type EcosystemSeed } from "./seed";

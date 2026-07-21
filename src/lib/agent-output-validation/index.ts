// ABOUTME: Public API for Verified Agent Output finalization.
// ABOUTME: Central export keeps all finalization paths on the same contract.

export { extractClaims } from "./claims";
export {
  extractEvidenceFromAgentMessages,
  extractEvidenceFromToolLoopMessages,
  extractEvidenceFromUnifiedMessages,
} from "./evidence";
export { INITIAL_FINALIZATION_RULES } from "./rules";
export type {
  ClaimKind,
  DiffEvidence,
  ExtractedClaim,
  FinalizationEvidence,
  FinalizationRule,
  FinalOutputValidationReport,
  ToolEvidence,
  ValidatedClaim,
} from "./types";
export {
  SUBSTITUTION_MARKER,
  validateFinalOutput,
} from "./validateFinalOutput";

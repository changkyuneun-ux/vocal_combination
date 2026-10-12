import type { ProfileDefinition } from "./registry.ts";


/**
 * 프로파일 2: AI 믹스 & 보이스 (AI Mix & Voice Performance) 프로파일.
 * 규격 6.9.5절 및 8.1절 예시 프로파일.
 */
export const AiMixProfile: ProfileDefinition = {
  id: "ai-mix",
  name: "AI Mixing and Voice Performance Profile",
  version: "1.0",
  asset_kinds: ["work", "recording", "stem_set", "mix_session", "model_run", "voice"],
  edge_kinds: [
    "PERFORMED_BY",
    "OWNED_BY",
    "CONTROLLED_BY",
    "WRITTEN_BY",
    "CONTRIBUTED_BY",
    "MIXED_BY",
    "MODEL_BY",
  ],
  claimant_roles: [
    "MASTER_OWNER",
    "WORK_AUTHOR",
    "CMO",
    "MIX_ENGINEER",
    "MODEL_PROVIDER",
    "AI_PROVIDER",
  ],

  party_kinds: [
    "LABEL",
    "PERFORMER",
    "AUTHOR",
    "PUBLISHER",
    "CMO",
    "AI_PROVIDER",
    "MODEL_OPERATOR",
    "MIX_ENGINEER",
  ],
  mandate_rights: ["MASTER", "WORK"],
  usage_metrics: ["SESSION_FIXED", "GAIN_WEIGHTED_MS"],
  vector_fns: ["graph", "contract", "model_share"],
  event_types: ["PRIMARY", "SUBSCRIPTION_SHARE", "TRAFFIC"],

  holding_reasons: ["RIGHTS_DISPUTE", "LICENSE_UNVERIFIED", "FRAUD_REVIEW", "MODEL_LICENSE_PENDING"],
  actions: [
    "AI_TRAIN",
    "AI_GENERATE",
    "MODEL_INFER",
    "PREVIEW",
    "STREAM",
    "DOWNLOAD",
    "COMMERCIAL",
  ],
};

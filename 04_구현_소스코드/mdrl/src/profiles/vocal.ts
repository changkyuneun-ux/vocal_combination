import type { ProfileDefinition } from "./registry.ts";


/**
 * 프로파일 1: 보컬 트랙 재배치 및 조합 (Vocal Combination) 프로파일.
 * 규격 6.9.5절 및 8.1절 예시 프로파일.
 */
export const VocalCombinationProfile: ProfileDefinition = {
  id: "vocal-combination",
  name: "Vocal Track Recombination Profile",
  version: "1.0",
  asset_kinds: ["work", "recording", "voice", "stem", "slot", "pack"],
  edge_kinds: [
    "PERFORMED_BY",
    "OWNED_BY",
    "IN_SLOT",
    "OF_RECORDING",
    "PART_OF",
    "CONTROLLED_BY",
    "OF_WORK",
    "WRITTEN_BY",
    "CONTRIBUTED_BY",
  ],
  claimant_roles: [
    "MASTER_OWNER",
    "WORK_AUTHOR",
    "CMO",
    "PERFORMER_FEATURED",
    "PERFORMER_NON_FEATURED",
    "AGENCY",
    "AI_PROVIDER",
    "RECORDING_CONTRIBUTOR",
  ],

  party_kinds: ["LABEL", "PERFORMER", "AUTHOR", "PUBLISHER", "CMO", "AGENCY", "AI_PROVIDER", "SESSION"],
  mandate_rights: ["MASTER", "WORK", "PERFORMER"],
  usage_metrics: ["ASSIGNED_LAYER_MS"],
  vector_fns: ["graph", "contract", "member_pct", "performance_pool", "mix", "cap", "floor_guarantee"],

  event_types: ["PRIMARY", "RESALE", "TRAFFIC"],
  holding_reasons: ["RIGHTS_DISPUTE", "LICENSE_UNVERIFIED", "FRAUD_REVIEW"],
  actions: [
    "PREVIEW",
    "COMBINE",
    "PERSONAL_HOLD",
    "SHARE_LINK",
    "PLATFORM_DISTRIBUTE",
    "LIMITED_USE",
    "RESALE",
    "COMMERCIAL",
    "DOWNLOAD",
  ],
};

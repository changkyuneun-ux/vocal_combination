export const ENUM_REGISTRY_VERSION = "1.0";

export const ENUMS = {
  module: ["core", "facts", "constraint", "grant", "approval", "allocation"],
  claimant_role: [
    "MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED",
    "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR",
  ],
  edge_type: [
    "PERFORMED_BY", "OWNED_BY", "IN_SLOT", "OF_RECORDING", "PART_OF",
    "CONTROLLED_BY", "OF_WORK", "WRITTEN_BY", "CONTRIBUTED_BY",
  ],
  claim_status: ["ASSERTED", "VERIFIED", "DISPUTED", "SUPERSEDED"],
  party_kind: ["LABEL", "PERFORMER", "AUTHOR", "PUBLISHER", "CMO", "AGENCY", "AI_PROVIDER", "SESSION"],
  voice_kind: ["HUMAN", "AI"],
  performer_role: ["FEATURED", "NON_FEATURED"],
  mandate_right: ["MASTER", "WORK", "PERFORMER"],
  decision: ["PERMIT", "PERMIT_WITH_OBLIGATION", "DENY", "REVIEW_REQUIRED"],
  approval_mode: ["AUTO", "LABEL", "AGENCY"],
  attestation_role: ["EDITOR", "APPROVER", "WORK_APPROVER", "ACTIVATOR", "SPACE_OPS", "SPACE_SETTLE"],
  action: [
    "PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK", "PLATFORM_DISTRIBUTE",
    "LIMITED_USE", "RESALE", "COMMERCIAL", "DOWNLOAD", "AI_TRAIN", "AI_GENERATE",
  ],
  stamp_clause: ["PERSONAL_HOLD", "PLATFORM_DISTRIBUTE", "LIMITED_USE", "COMMERCIAL", "DOWNLOAD"],
  uniqueness_scope: ["PACK", "FAN_PACK"],
  binding_time: ["ISSUE_TIME", "USAGE_TIME", "SALE_TIME", "REPORT_PERIOD"],
  event_type: ["PRIMARY", "RESALE", "TRAFFIC"],
  pool_mode: ["USAGE_WEIGHTED", "FIXED", "HYBRID", "MEMBER_PCT"],
  rounding_method: ["HIERARCHICAL_LRM_V1"],
  visibility: ["PUBLIC", "PARTIES", "PRIVATE"],
  vc_status: ["DRAFT", "VALIDATED", "RESERVED", "SUBMITTED", "ISSUED", "FLAGGED", "HIDDEN", "VOID"],
  holding_reason: ["RIGHTS_DISPUTE", "FRAUD_REVIEW"],
  integrity_status: ["CLEAR", "FLAGGED"],
  vector_fn: ["graph", "contract", "member_pct", "performance_pool", "mix", "cap", "floor_guarantee"],
} as const;

export type EnumName = keyof typeof ENUMS;
export type EnumValue<N extends EnumName> = (typeof ENUMS)[N][number];

export function isEnumValue<N extends EnumName>(name: N, v: unknown): v is EnumValue<N> {
  return typeof v === "string" && (ENUMS[name] as readonly string[]).includes(v);
}

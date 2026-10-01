import type {
  AuditRow, BatchRow, BatchRunRow, BatchView, ClockState, Claim, Dispute, EntryDetailData, EntryRow, EventSettlement, HoldRow,
  HoldSuggestion, InstructionDetailData, InstructionRow, IssueAudit, IssueRow, LedgerAccount, Mandate, PackDetailData, PackRow, Party,
  PayoutPolicyData, PayoutProfile, PayoutRunRow, PolicyRow, PolicyVersion, PolicyVersionDetail, QuarantineRow, Recording, ReversalRow,
  RevenueEventRow, RunDetailData, RunSums, Scope, ScopeFacts, Slot, StatementData, Stem, TrialBalance, UserRow, Voice, WebhookRow, Work,
} from "./types.ts";

/**
 * 계약 테스트(e2e/contract.spec.ts)가 백엔드 응답과 대조하는 필수 키 목록. 키가 types.ts의 타입에서 빠지거나 이름이 바뀌면
 * `satisfies`가 컴파일 오류를 낸다. 응답에는 null 값이어도 키가 있어야 한다. *_AMOUNT_KEYS는 10진 문자열이어야 하는 키다.
 */
export const USER_KEYS = ["userId", "displayName", "roles"] as const satisfies readonly (keyof UserRow)[];
export const CLOCK_KEYS = ["now", "realNow", "headroomMs"] as const satisfies readonly (keyof ClockState)[];

export const PARTY_KEYS = ["partyId", "partyType", "displayName", "isni", "ipiNo", "createdAt"] as const satisfies readonly (keyof Party)[];
export const WORK_KEYS = ["workId", "title", "iswc", "createdAt"] as const satisfies readonly (keyof Work)[];
export const SCOPE_KEYS = ["factsScopeId", "workId", "lastVersion", "createdAt", "sealedThrough", "latestFactsSeal"] as const satisfies readonly (keyof Scope)[];
export const SCOPE_FACTS_KEYS = ["recordings", "slots", "stems", "voices", "claims", "mandates", "disputes"] as const satisfies readonly (keyof ScopeFacts)[];
export const RECORDING_KEYS = ["recordingId", "workId", "masterOwnerPartyId", "isrc", "versionTitle", "createdAt"] as const satisfies readonly (keyof Recording)[];
export const SLOT_KEYS = ["slotId", "recordingId", "startMs", "endMs", "durationMs", "sortOrder"] as const satisfies readonly (keyof Slot)[];
export const STEM_KEYS = ["stemId", "slotId", "recordingId", "performerPartyId", "rightsBearing", "createdAt"] as const satisfies readonly (keyof Stem)[];
export const VOICE_KEYS = ["voiceId", "factsScopeId", "kind", "createdAt"] as const satisfies readonly (keyof Voice)[];
export const CLAIM_KEYS = [
  "claimId", "version", "factsScopeId", "sourceId", "edge", "targetId", "shareBps", "performerRole", "roleDetail", "status", "validFrom", "validTo",
  "recordedAt", "supersededAt", "evidenceDigest", "visibility", "sourceRef",
] as const satisfies readonly (keyof Claim)[];
export const MANDATE_KEYS = [
  "mandateId", "version", "factsScopeId", "fromPartyId", "toPartyId", "rightKind", "shareBps", "status", "validFrom", "validTo", "recordedAt",
  "supersededAt", "visibility", "sourceRef",
] as const satisfies readonly (keyof Mandate)[];
export const DISPUTE_KEYS = ["disputeId", "targetType", "targetId", "factsScopeId", "disputeReason", "status", "openedAt", "closedAt"] as const satisfies readonly (keyof Dispute)[];

export const POLICY_ROW_KEYS = ["policyId", "packId", "latestVersion", "activeVersion"] as const satisfies readonly (keyof PolicyRow)[];
export const POLICY_VERSION_KEYS = [
  "policyId", "version", "policyDigest", "factsDigest", "factsKnownAt", "status", "rebindOfVersion", "packId", "createdBy", "createdAt", "activatedAt",
  "approved", "approvedBy",
] as const satisfies readonly (keyof PolicyVersion)[];
export const POLICY_VERSION_DETAIL_KEYS = [
  "policyId", "version", "policyDigest", "factsDigest", "factsKnownAt", "status", "rebindOfVersion", "packId", "createdBy", "createdAt", "activatedAt",
  "sourceText", "approvals",
] as const satisfies readonly (keyof PolicyVersionDetail)[];

export const PACK_ROW_KEYS = ["packId", "packCode", "title", "factsScopeId", "status", "createdAt"] as const satisfies readonly (keyof PackRow)[];
export const PACK_DETAIL_KEYS = [...PACK_ROW_KEYS, "claimants", "activePolicy"] as const satisfies readonly (keyof PackDetailData)[];
export const ISSUE_ROW_KEYS = [
  "snapshotId", "vcId", "packId", "policyId", "policyVersion", "createdAt", "factsDigest", "policyDigest", "projectionDigest", "membersDigest", "asOf",
  "knownAt", "quarantined",
] as const satisfies readonly (keyof IssueRow)[];
export const ISSUE_AUDIT_KEYS = ["ok", "policyMatch", "expected", "recomputed"] as const satisfies readonly (keyof IssueAudit)[];

export const REVENUE_EVENT_KEYS = [
  "eventId", "sourceSystem", "sourceEventId", "sourceRevision", "eventType", "vcId", "relatedEventId", "netAmountKrw", "currency", "integrityStatus",
  "occurredAt", "recordedAt", "supersededBy",
] as const satisfies readonly (keyof RevenueEventRow)[];
export const REVENUE_EVENT_AMOUNT_KEYS = ["netAmountKrw"] as const satisfies readonly (keyof RevenueEventRow)[];
export const EVENT_SETTLEMENT_KEYS = ["runs", "reversals", "refunds"] as const satisfies readonly (keyof EventSettlement)[];

export const BATCH_ROW_KEYS = [
  "batchId", "periodStart", "periodEnd", "status", "executedBy", "createdAt", "confirmedBy", "confirmedAt", "batchManifestDigest", "runCounts",
] as const satisfies readonly (keyof BatchRow)[];
export const BATCH_VIEW_KEYS = ["batchId", "status", "runs", "progress", "skipped"] as const satisfies readonly (keyof BatchView)[];
export const BATCH_RUN_KEYS = [
  "runId", "batchId", "snapshotId", "status", "eventsDigest", "resultDigest", "diagnostics", "executedBy", "verifiedBy", "verifiedAt", "createdAt", "eventCount",
] as const satisfies readonly (keyof BatchRunRow)[];
export const RUN_DETAIL_KEYS = ["runId", "status", "eventsDigest", "resultDigest", "lines", "holdings"] as const satisfies readonly (keyof RunDetailData)[];
export const RUN_SUMS_KEYS = ["settle", "reversal", "net"] as const satisfies readonly (keyof RunSums)[];
export const QUARANTINE_KEYS = ["quarantineId", "snapshotId", "reason", "diagnostics", "createdAt", "releasedBy", "releasedAt"] as const satisfies readonly (keyof QuarantineRow)[];
export const HOLD_KEYS = [
  "holdingId", "runId", "eventId", "bucket", "reason", "lineSeq", "amountKrw", "reversalId", "status", "release",
] as const satisfies readonly (keyof HoldRow)[];
export const HOLD_AMOUNT_KEYS = ["amountKrw"] as const satisfies readonly (keyof HoldRow)[];
export const HOLD_SUGGESTION_KEYS = ["holdingId", "heldKrw", "remainingKrw", "allocation"] as const satisfies readonly (keyof HoldSuggestion)[];
export const HOLD_SUGGESTION_AMOUNT_KEYS = ["heldKrw", "remainingKrw"] as const satisfies readonly (keyof HoldSuggestion)[];
export const REVERSAL_KEYS = ["reversalId", "originalRunId", "eventId", "sequence", "refundEventId", "resultDigest", "createdAt"] as const satisfies readonly (keyof ReversalRow)[];

export const TRIAL_BALANCE_KEYS = ["accounts", "sum"] as const satisfies readonly (keyof TrialBalance)[];
export const TRIAL_BALANCE_AMOUNT_KEYS = ["sum"] as const satisfies readonly (keyof TrialBalance)[];
export const LEDGER_ACCOUNT_KEYS = ["accountId", "kind", "partyId", "reason", "bucket", "balance"] as const satisfies readonly (keyof LedgerAccount)[];
export const LEDGER_ACCOUNT_AMOUNT_KEYS = ["balance"] as const satisfies readonly (keyof LedgerAccount)[];
export const ENTRY_ROW_KEYS = ["entryId", "kind", "sourceRef", "occurredAt", "createdBy", "total"] as const satisfies readonly (keyof EntryRow)[];
export const ENTRY_ROW_AMOUNT_KEYS = ["total"] as const satisfies readonly (keyof EntryRow)[];
export const ENTRY_DETAIL_KEYS = [...ENTRY_ROW_KEYS, "postings"] as const satisfies readonly (keyof EntryDetailData)[];
export const POSTING_KEYS = ["postingId", "accountId", "amountKrw", "eventId", "runId"] as const satisfies readonly (keyof EntryDetailData["postings"][number])[];

export const PAYOUT_POLICY_KEYS = ["policyId", "minPayoutKrw", "initialHoldDays", "taxBps", "accountCoolingHours"] as const satisfies readonly (keyof PayoutPolicyData)[];
export const PAYOUT_POLICY_AMOUNT_KEYS = ["minPayoutKrw"] as const satisfies readonly (keyof PayoutPolicyData)[];
export const PAYOUT_PROFILE_KEYS = [
  "partyId", "taxType", "payoutAccountRef", "kycVerified", "firstPayableAt", "updatedAt", "accountChangedAt", "accountChangedBy", "coolingUntil",
] as const satisfies readonly (keyof PayoutProfile)[];
export const PAYOUT_RUN_KEYS = ["payoutRunId", "asOf", "createdBy", "createdAt", "statusCounts"] as const satisfies readonly (keyof PayoutRunRow)[];
export const INSTRUCTION_KEYS = [
  "instructionId", "payoutRunId", "partyId", "grossKrw", "withholdingKrw", "netKrw", "status", "holdReason", "idempotencyKey", "providerRef", "entryId",
  "settledEntryId", "submitAttemptedAt", "submitUnknownAt", "submittedAccountRef", "decidedAccountRef", "createdAt",
] as const satisfies readonly (keyof InstructionRow)[];
export const INSTRUCTION_AMOUNT_KEYS = ["grossKrw", "withholdingKrw", "netKrw"] as const satisfies readonly (keyof InstructionRow)[];
export const INSTRUCTION_DETAIL_KEYS = [...INSTRUCTION_KEYS, "webhooks", "audit"] as const satisfies readonly (keyof InstructionDetailData)[];
export const WEBHOOK_KEYS = ["providerEventId", "providerRef", "status", "payload", "receivedAt", "processedAt"] as const satisfies readonly (keyof WebhookRow)[];
export const AUDIT_KEYS = ["auditId", "occurredAt", "actor", "action", "entityType", "entityId", "after"] as const satisfies readonly (keyof AuditRow)[];
export const STATEMENT_KEYS = [
  "partyId", "from", "to", "opening", "settled", "reversed", "holdReleased", "payoutGross", "withholding", "payoutNet", "payoutFailedRestored",
  "withholdingRestored", "netRestored", "adjusted", "closing",
] as const satisfies readonly (keyof StatementData)[];
export const STATEMENT_AMOUNT_KEYS = [
  "opening", "settled", "reversed", "holdReleased", "payoutGross", "withholding", "payoutNet", "payoutFailedRestored", "withholdingRestored", "netRestored",
  "adjusted", "closing",
] as const satisfies readonly (keyof StatementData)[];

export type UserRow = { userId: string; displayName: string; roles: string[] };
export type ClockState = { now: string; realNow: string; headroomMs: number };
export type { Paged } from "./client.ts";

export type Party = { partyId: string; partyType: string; displayName: string; isni: string | null; ipiNo: string | null; createdAt: string };
export type Work = { workId: string; title: string; iswc: string | null; createdAt: string };
export type Scope = { factsScopeId: string; workId: string; lastVersion: number; createdAt: string; sealedThrough: string | null; latestFactsSeal: { digest: string; knownAt: string | null } | null };
export type Recording = { recordingId: string; workId: string; masterOwnerPartyId: string; isrc: string | null; versionTitle: string; createdAt: string };
export type Slot = { slotId: string; recordingId: string; startMs: number; endMs: number; durationMs: number; sortOrder: number };
export type Stem = { stemId: string; slotId: string; recordingId: string; performerPartyId: string | null; rightsBearing: boolean; createdAt: string };
export type Voice = { voiceId: string; factsScopeId: string; kind: string; createdAt: string };
export type Claim = {
  claimId: string; version: number; factsScopeId: string; sourceId: string; edge: string; targetId: string; shareBps: number;
  performerRole: string | null; roleDetail: string | null; status: string; validFrom: string; validTo: string | null;
  recordedAt: string; supersededAt: string | null; evidenceDigest: string | null; visibility: string | null; sourceRef: string | null;
};
export type Mandate = {
  mandateId: string; version: number; factsScopeId: string; fromPartyId: string; toPartyId: string; rightKind: string; shareBps: number;
  status: string; validFrom: string; validTo: string | null; recordedAt: string; supersededAt: string | null; visibility: string | null; sourceRef: string | null;
};
export type Dispute = { disputeId: string; targetType: string; targetId: string; factsScopeId: string; disputeReason: string; status: string; openedAt: string; closedAt: string | null };
export type ScopeFacts = { recordings: Recording[]; slots: Slot[]; stems: Stem[]; voices: Voice[]; claims: Claim[]; mandates: Mandate[]; disputes: Dispute[] };
export type PolicyRow = { policyId: string; packId: string; latestVersion: number; activeVersion: number | null };
export type PolicyVersion = {
  policyId: string; version: number; policyDigest: string; factsDigest: string; factsKnownAt: string; status: string;
  rebindOfVersion: number | null; packId: string; createdBy: string; createdAt: string; activatedAt: string | null; approved: boolean; approvedBy: string | null;
};
export type PolicyVersionDetail = Omit<PolicyVersion, "approved" | "approvedBy"> & { sourceText: string; approvals: { userId: string; role: string; at: string }[] };
export type CompileResult = { policyId: string; version: number; policyDigest: string; factsDigest: string; canonicalText: string };
export type SeedResult = { packId: string; factsScopeId: string; policyId: string; policyText: string };

export type PackRow = { packId: string; packCode: string; title: string; factsScopeId: string; status: string; createdAt: string };
export type PackDetailData = PackRow & {
  claimants: { partyId: string; claimantRole: string }[];
  activePolicy: { policyId: string; version: number } | null;
};
export type IssueRow = {
  snapshotId: string; vcId: string; packId: string; policyId: string; policyVersion: number; createdAt: string;
  factsDigest: string | null; policyDigest: string | null; projectionDigest: string | null; membersDigest: string | null;
  asOf: string | null; knownAt: string | null; quarantined: boolean;
};
export type IssueSeal = { snapshotId: string; factsDigest: string; policyDigest: string; projectionDigest: string; membersDigest: string; asOf: string; knownAt: string };
export type IssueAudit = {
  ok: boolean; policyMatch: boolean; expected: IssueSeal;
  recomputed: { projectionDigest: string; membersDigest: string };
};
export type IssueBody = { packId: string; vcId: string; assignments: { slotId: string; stemId: string }[]; members: Record<string, number> };
export type RevenueEventRow = {
  eventId: string; sourceSystem: string; sourceEventId: string; sourceRevision: number; eventType: string; vcId: string | null;
  relatedEventId: string | null; netAmountKrw: string; currency: string; integrityStatus: string; occurredAt: string; recordedAt: string;
  supersededBy: string | null;
};
export type RevenueBody = {
  eventId: string; sourceSystem: string; sourceEventId: string; sourceRevision?: number; eventType: "PURCHASE" | "RESALE" | "REFUND";
  vcId?: string; relatedEventId?: string; amountKrw: string; currency: "KRW"; integrity?: "CLEAR" | "FLAGGED"; occurredAt: string;
};
export type EventSettlement = {
  runs: { runId: string; batchId: string; status: string }[];
  reversals: { reversalId: string; createdAt: string }[];
  refunds: { eventId: string; netAmountKrw: string }[];
};

export type RunStatus = "PENDING" | "CALCULATED" | "VERIFIED" | "FAILED" | "VOIDED" | "CONFIRMED";
export type BatchRow = {
  batchId: string; periodStart: string; periodEnd: string; status: string; executedBy: string; createdAt: string;
  confirmedBy: string | null; confirmedAt: string | null; batchManifestDigest: string | null; runCounts: Record<RunStatus, number>;
};
export type BatchView = {
  batchId: string; status: string; runs: { runId: string; status: string; events: number }[];
  progress: "EMPTY" | "CALCULATING" | "VERIFYING" | "READY" | "CONFIRMED"; skipped: { eventId: string; reason: string }[];
};
export type BatchRunRow = {
  runId: string; batchId: string; snapshotId: string; status: string; eventsDigest: string | null; resultDigest: string | null;
  diagnostics: unknown; executedBy: string; verifiedBy: string | null; verifiedAt: string | null; createdAt: string; eventCount: number;
};
export type RunSums = { settle: string; reversal: string; net: string };
export type RunDetailData = { runId: string; status: string; eventsDigest: string | null; resultDigest: string | null; lines: RunSums; holdings: RunSums };
export type QuarantineRow = {
  quarantineId: number; snapshotId: string; reason: string; diagnostics: unknown; createdAt: string; releasedBy: string | null; releasedAt: string | null;
};
export type HoldRow = {
  holdingId: number; runId: string; eventId: string; bucket: string; reason: string; lineSeq: number; amountKrw: string;
  reversalId: string | null; status: string; release: { releaseId: number; releasedBy: string; releasedAt: string } | null;
};
export type HoldSuggestion = { holdingId: string; heldKrw: string; remainingKrw: string; allocation: Record<string, string> };
export type HoldReleaseResult = { holdingId: string; releasedKrw: string; entryId: string | number; allocation: Record<string, string> };
export type TrialBalance = { accounts: { accountId: string; kind: string; balance: string }[]; sum: string };
export type LedgerAccount = { accountId: string; kind: string; partyId: string | null; reason: string | null; bucket: string | null; balance: string };
export type EntryRow = { entryId: number; kind: string; sourceRef: string; occurredAt: string; createdBy: string; total: string };
export type EntryDetailData = EntryRow & { postings: { postingId: number; accountId: string; amountKrw: string; eventId: string | null; runId: string | null }[] };

export type TaxType = "DOMESTIC_INDIVIDUAL" | "DOMESTIC_CORP" | "FOREIGN" | "EXEMPT";
export type InstructionStatus = "PENDING" | "SUBMITTED" | "PAID" | "FAILED" | "CARRIED" | "HELD";
export type PayoutPolicyData = { policyId: string; minPayoutKrw: string; initialHoldDays: number; taxBps: unknown; accountCoolingHours: number };
export type PayoutProfile = {
  partyId: string; taxType: string; payoutAccountRef: string | null; kycVerified: boolean; firstPayableAt: string; updatedAt: string;
  accountChangedAt: string | null; accountChangedBy: string | null; coolingUntil: string | null;
};
export type ProfileInput = { partyId: string; taxType: string; kycVerified: boolean; payoutAccountRef?: string | null };
export type ProfileView = { partyId: string; taxType: string; hasAccount: boolean; kycVerified: boolean; firstPayableAt: string };
export type PayoutRunRow = { payoutRunId: string; asOf: string; createdBy: string; createdAt: string; statusCounts: Record<InstructionStatus, number> };
export type InstructionRow = {
  instructionId: string; payoutRunId: string; partyId: string; grossKrw: string; withholdingKrw: string; netKrw: string; status: string;
  holdReason: string | null; idempotencyKey: string; providerRef: string | null; entryId: number | null; settledEntryId: number | null;
  submitAttemptedAt: string | null; submitUnknownAt: string | null; submittedAccountRef: string | null; decidedAccountRef: string | null; createdAt: string;
};
export type WebhookRow = { providerEventId: string; providerRef: string; status: string; payload: unknown; receivedAt: string; processedAt: string | null };
export type AuditRow = { auditId: number; occurredAt: string; actor: string; action: string; entityType: string; entityId: string; after: unknown };
/** 계좌 토큰은 마스킹돼 온다. 판정·전송 토큰이 다른지는 서버가 원문으로 비교해 accountRefMismatch로 준다. */
export type InstructionDetailData = InstructionRow & { webhooks: WebhookRow[]; audit: AuditRow[]; accountRefMismatch: boolean };
export type InspectionRow = { inspectionId: number; occurredAt: string; actor: string; targetTenantId: string; nodeType: string; nodeId: string; panel: string; piiUnmasked: boolean; reason?: string; breakGlassId?: number };
export type BreakGlassRow = { breakGlassId: number; userId: string; targetTenantId: string; reason: string; startedAt: string; expiresAt: string; endedAt?: string };
export type TenantRow = { tenantId: string; tenantType: string; name: string; status: string };
export type StatementData = {
  partyId: string; from: string; to: string; opening: string; settled: string; reversed: string; holdReleased: string;
  payoutGross: string; withholding: string; payoutNet: string; payoutFailedRestored: string; withholdingRestored: string; netRestored: string;
  adjusted: string; closing: string;
};
export type DevOutcome = "PAID" | "FAILED" | "UNKNOWN";
export type PspOutcomes = { byInstruction: Record<string, DevOutcome>; byParty: Record<string, DevOutcome> };
export type PspRequest = { at: string; op: "submit" | "status"; instructionId: string; key: string; result: string };
export type WebhookResponses = { responses: { statusCode: number; body: unknown }[] };
export type ReversalRow = { reversalId: string; originalRunId: string; eventId: string; sequence: number; refundEventId: string; resultDigest: string; createdAt: string };

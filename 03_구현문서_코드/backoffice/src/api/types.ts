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

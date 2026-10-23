import { api } from "./client.ts";
import type { Claim, Mandate, Recording, Voice, Dispute } from "./types.ts";

/** 작품 목록·곡 워크스페이스(2부-B) 화면용 타입과 호출. 코어 registry/overview.ts·readiness.ts와 같은 모양이다. */
export type WorkStatus = "입력 중" | "확인 대기" | "IR 생성됨" | "판매 중" | "분쟁·보류";
export type WorkOverview = {
  workId: string; title: string; scopeId: string | null; recordingTitle: string | null;
  authors: string[];
  rights: { work: number; master: number; performers: number };
  slots: number; vocalParts: number; stems: number; parts: number; members: number;
  pendingConfirmations: number;
  sealed: boolean; sealedThrough: string | null;
  pack: { packId: string; status: string } | null;
  activePolicy: boolean;
  stage: 0 | 1 | 2 | 3 | 4;
  status: WorkStatus;
};
export type ReadinessItem = { key: string; ok: boolean | "warn"; label: string; detail: string };
export type Readiness = { items: ReadinessItem[] };

export type PartKind = "VOCAL" | "GROUP" | "INSTRUMENT";
export type SlotPart = { partNo: number; kind: PartKind; role: string | null; startMs: number; endMs: number; durationMs?: number; originalPartyId: string | null };
export type SlotWithParts = { slotId: string; recordingId: string; startMs: number; endMs: number; sortOrder: number; sectionLabel: string | null; parts: SlotPart[] };
export type StemRow = { stemId: string; slotId: string; partNo: number; recordingId: string; performerPartyId: string | null; rightsBearing: boolean; createdAt?: string };
/** GET /scopes/:id/facts — 곡의 카탈로그와 기록 전부(파트 포함). */
export type WorkFacts = { recordings: Recording[]; slots: SlotWithParts[]; stems: StemRow[]; voices: Voice[]; claims: Claim[]; mandates: Mandate[]; disputes: Dispute[] };
export type ScopeInfo = { factsScopeId: string; workId: string; lastVersion: number; createdAt: string; sealedThrough: string | null; latestFactsSeal: { digest: string; knownAt: string | null } | null };
export type ConfirmationRow = {
  requestId: number; recordType: "CLAIM" | "MANDATE"; recordId: string; recordVersion: number; factsScopeId: string; counterpartyId: string;
  requestedBy: string; requestedAt: string; dueAt: string; status: string; decidedAt?: string;
};
export type ConsentRow = { consentId: string; factsScopeId: string; partyId: string; rightType: string; assetId: string; validFrom: string; validTo: string; status: string };
export type DocumentRow = { documentId: string; version: number; kind: string; title: string; parties: string[]; effectiveFrom: string | null; status: string };
export type PartyRow = { partyId: string; partyType: string; displayName: string; tenantId?: string | null };

const enc = encodeURIComponent;
export const getOverview = () => api<WorkOverview[]>("GET", "/works/overview");
export const getReadiness = (scopeId: string) => api<Readiness>("GET", `/scopes/${enc(scopeId)}/readiness`);

/** 2부-A 쓰기: 슬롯·파트·스템 수정·삭제(IR 생성 전만 — 뒤에는 409 CATALOG_SEALED). */
export type CatalogKind = "work" | "recording" | "slot" | "slot-part" | "stem" | "voice";
const catalogPath = (kind: CatalogKind, id: string, partNo?: number) =>
  `/${kind === "slot-part" ? "slot-parts" : `${kind}s`}/${enc(id)}${partNo === undefined ? "" : `/${partNo}`}`;
export const putSlot = (slotId: string, body: Partial<{ startMs: number; endMs: number; sortOrder: number; sectionLabel: string }>) => api<unknown>("PUT", catalogPath("slot", slotId), body);
export const putSlotPart = (slotId: string, partNo: number, body: Partial<Omit<SlotPart, "partNo">>) => api<unknown>("PUT", catalogPath("slot-part", slotId, partNo), body);
export const putStem = (stemId: string, body: Partial<{ performerPartyId: string; rightsBearing: boolean }>) => api<unknown>("PUT", catalogPath("stem", stemId), body);
export const deleteCatalog = (kind: CatalogKind, id: string, partNo?: number) => api<unknown>("DELETE", catalogPath(kind, id, partNo));
export const postSlot = (body: { slotId: string; recordingId: string; startMs: number; endMs: number; sortOrder: number; sectionLabel?: string; parts?: Omit<SlotPart, "durationMs">[] }) =>
  api<unknown>("POST", "/slots", body);
export const postSlotPart = (body: { slotId: string } & Omit<SlotPart, "durationMs">) => api<unknown>("POST", "/slot-parts", body);
/** 스템 등록 + 권리 주장 함께 만들기(결정 ID3): 보이스·소유 주장(처음이면)과 실연 주장, 멤버 확인 요청. */
export const postStem = (body: { stemId: string; slotId: string; partNo: number; recordingId: string; performerPartyId?: string; rightsBearing: boolean; withClaims: true }) =>
  api<unknown>("POST", "/stems", body);
/** 녹음 등록 + 녹음 권리 주장(결정 ID2). */
export const postRecording = (body: { recordingId: string; workId: string; masterOwnerPartyId: string; versionTitle: string; isrc?: string; masterClaim: { evidenceDocuments?: { documentId: string; version: number }[] } }) =>
  api<unknown>("POST", "/recordings", body);

/** 사람 당사자(작가·멤버 등). 권리 테넌트가 관리해도 확인·서명은 본인이 한다(결정 WD2) — "자기 당사자"(기관)에 넣지 않는다. */
export const PERSON_PARTY_TYPES = ["MEMBER", "ARTIST", "AUTHOR", "SESSION", "FAN"];
/** 내 기관 당사자(레이블·소속사 등): 바로 확정·기관 서명을 할 수 있는 당사자. */
export const orgPartyIds = (rows: PartyRow[] | undefined) => new Set((rows ?? []).filter((p) => !PERSON_PARTY_TYPES.includes(p.partyType)).map((p) => p.partyId));

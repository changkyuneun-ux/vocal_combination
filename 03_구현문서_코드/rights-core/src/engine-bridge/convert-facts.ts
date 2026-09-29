import type { FactsDocument } from "vcrl/facts";

export type PartyRow = { partyId: string; partyType: string; isni?: string; ipiNo?: string; createdAt: string };
export type WorkRow = { workId: string; iswc?: string; createdAt: string };
export type RecordingRow = { recordingId: string; workId: string; isrc?: string; createdAt: string };
export type StemRow = { stemId: string; recordingId: string; slotId: string; rightsBearing: boolean; createdAt: string };
export type VoiceRow = { voiceId: string; kind: "HUMAN" | "AI"; createdAt: string };
type Recorded = { version: number; status: string; validFrom: string; validTo?: string; recordedAt: string; supersededAt?: string; visibility?: string };
export type ClaimRow = Recorded & {
  claimId: string; sourceId: string; edge: string; targetId: string; shareBps: number;
  performerRole?: string; roleDetail?: string; evidenceDigest?: string;
};
export type MandateRow = Recorded & { mandateId: string; fromPartyId: string; toPartyId: string; rightKind: string; shareBps: number };
export type FactsRows = {
  scopeId: string; work: WorkRow; recordings: RecordingRow[]; stems: StemRow[]; voices: VoiceRow[];
  parties: PartyRow[]; claims: ClaimRow[]; mandates: MandateRow[];
};

/** party_type → VCRL party_kind (통합 설계 9.3-3). FAN·PLATFORM은 facts에 들어갈 수 없다(undefined). */
export const PARTY_KIND: Record<string, string | undefined> = {
  LABEL: "LABEL", AGENCY: "AGENCY", PUBLISHER: "PUBLISHER", CMO: "CMO", AUTHOR: "AUTHOR", SESSION: "SESSION",
  AI_PROVIDER: "AI_PROVIDER", ARTIST: "PERFORMER", MEMBER: "PERFORMER",
};

const byId = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const ids = (entries: [string, string | undefined][]) => {
  const o = Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== undefined));
  return Object.keys(o).length > 0 ? { ids: o } : {};
};
/** IR record id: 버전 1은 원래 id, 이후 버전은 `<id>.v<n>`(같은 문서 안에서 id가 겹치지 않게). */
const recordId = (id: string, version: number) => (version === 1 ? id : `${id}.v${version}`);
/** 기준 시점 이후에 설정된 superseded_at은 그 시점의 지식이 아니므로 비운다. */
const supersededAt = (r: Recorded, knownAt: string) => (r.supersededAt !== undefined && r.supersededAt <= knownAt ? { superseded_at: r.supersededAt } : {});

/**
 * facts IR version(통합 설계 9.3-1): 기준 시점까지 범위 안에서 기록 변화가 일어난 서로 다른 시각의 개수.
 * 엔티티 생성, claim·mandate 기록, 기준 시점 이하의 대체 시각을 모두 센다.
 */
export function factsVersion(rows: FactsRows, knownAt: string): number {
  const instants = new Set<string>();
  const add = (t: string | undefined) => {
    if (t !== undefined && t <= knownAt) instants.add(t);
  };
  add(rows.work.createdAt);
  for (const r of rows.recordings) add(r.createdAt);
  for (const s of rows.stems) add(s.createdAt);
  for (const v of rows.voices) add(v.createdAt);
  for (const p of rows.parties) add(p.createdAt);
  for (const r of [...rows.claims, ...rows.mandates]) {
    add(r.recordedAt);
    add(r.supersededAt);
  }
  return Math.max(1, instants.size);
}

/** 행 → facts IR(순수 함수). 입력 행은 이미 knownAt 이전에 기록된 것만 담고 있어야 한다(loadFactsRows). */
export function buildFactsDocument(rows: FactsRows, knownAt: string): FactsDocument {
  const valid = (r: Recorded) => ({ from: r.validFrom, ...(r.validTo !== undefined && { to: r.validTo }) });
  return {
    vcrl: "1.0",
    module: "facts",
    id: rows.scopeId,
    version: String(factsVersion(rows, knownAt)),
    depends_on: [],
    visibility_default: "PARTIES",
    body: {
      parties: [...rows.parties].sort(byId((p) => p.partyId)).map((p) => ({
        id: p.partyId, kind: PARTY_KIND[p.partyType] as never, ...ids([["ipi", p.ipiNo], ["isni", p.isni]]),
      })),
      works: [{ id: rows.work.workId, ...ids([["iswc", rows.work.iswc]]) }],
      recordings: [...rows.recordings].sort(byId((r) => r.recordingId)).map((r) => ({ id: r.recordingId, of: r.workId, ...ids([["isrc", r.isrc]]) })),
      voices: [...rows.voices].sort(byId((v) => v.voiceId)).map((v) => ({ id: v.voiceId, kind: v.kind })),
      stems: [...rows.stems].sort(byId((s) => s.stemId)).map((s) => ({ id: s.stemId, of: s.recordingId, slot: s.slotId, rights_bearing: s.rightsBearing })),
      claims: rows.claims.map((c) => ({
        id: recordId(c.claimId, c.version), source: c.sourceId, edge: c.edge as never, target: c.targetId, share: String(c.shareBps),
        ...(c.performerRole !== undefined && { performer_role: c.performerRole as never }),
        ...(c.roleDetail !== undefined && { role_detail: c.roleDetail }),
        status: c.status as never, valid: valid(c), recorded_at: c.recordedAt, ...supersededAt(c, knownAt),
        ...(c.evidenceDigest !== undefined && { evidence: c.evidenceDigest }),
        ...(c.visibility !== undefined && { visibility: c.visibility as never }),
      })).sort(byId((c) => c.id)),
      mandates: rows.mandates.map((m) => ({
        id: recordId(m.mandateId, m.version), from: m.fromPartyId, to: m.toPartyId, right: m.rightKind as never, share: String(m.shareBps),
        status: m.status as never, valid: valid(m), recorded_at: m.recordedAt, ...supersededAt(m, knownAt),
        ...(m.visibility !== undefined && { visibility: m.visibility as never }),
      })).sort(byId((m) => m.id)),
    },
  };
}

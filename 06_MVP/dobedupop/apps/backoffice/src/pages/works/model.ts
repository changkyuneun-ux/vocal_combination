import type { PolicyForm } from "../../api/policyForm.ts";
import type { Claim, Mandate } from "../../api/types.ts";
import type { ConsentRow, PartKind, SlotWithParts, StemRow } from "../../api/works.ts";

/** 작품·곡 워크스페이스 화면 모델(순수 함수). 화면은 이 결과를 그리기만 한다. */

export const STAGES = ["권리 입력", "확인", "IR 생성", "팩 활성", "판매"] as const;

/** 진행 막대 5칸: 지난 단계 done, 지금 단계 now, 남은 단계 todo. 판매(4)는 마지막 칸이 now다. */
export function stageBars(stage: number): ("done" | "now" | "todo")[] {
  return STAGES.map((_, i) => (i < stage ? "done" : i === stage ? "now" : "todo"));
}
export const stageLabel = (stage: number) => STAGES[Math.min(stage, 4)] + (stage >= 4 ? "" : " 단계");

/** 현재 버전 주장만(새 버전에 밀린 것·SUPERSEDED 제외). */
export const currentClaims = (claims: Claim[]) => claims.filter((c) => c.supersededAt === null && c.status !== "SUPERSEDED");

export type BucketRow = { claimId: string; version: number; partyId: string; name: string; shareBps: number; status: string; evidence: string | null; roleDetail: string | null; sourceId: string };
export type Bucket = { key: "work" | "master" | "performer"; title: string; edge: string; rows: BucketRow[]; totalBps: number };

/**
 * 원곡 권리 세 갈래: WRITTEN_BY → 작품, CONTROLLED_BY → 녹음, OWNED_BY(보이스 → 당사자) → 실연(멤버별 보이스).
 * 실연 갈래의 합계는 보이스마다 100%라 갈래 합계로는 뜻이 없어 0으로 둔다(표시용).
 */
export function rightsBuckets(claims: Claim[], parties: Map<string, string>): Bucket[] {
  const cur = currentClaims(claims);
  const rows = (edge: string): BucketRow[] => cur.filter((c) => c.edge === edge).sort((a, b) => (a.claimId < b.claimId ? -1 : 1)).map((c) => ({
    claimId: c.claimId, version: c.version, partyId: c.targetId, name: parties.get(c.targetId) ?? c.targetId, shareBps: c.shareBps, status: c.status,
    evidence: c.evidenceDigest ? "근거 문서 연결" : null, roleDetail: c.roleDetail, sourceId: c.sourceId,
  }));
  const sum = (r: BucketRow[]) => r.reduce((a, x) => a + x.shareBps, 0);
  const work = rows("WRITTEN_BY"), master = rows("CONTROLLED_BY"), perf = rows("OWNED_BY");
  return [
    { key: "work", title: "작품 · 작사·작곡", edge: "WRITTEN_BY", rows: work, totalBps: sum(work) },
    { key: "master", title: "녹음 · 마스터", edge: "CONTROLLED_BY", rows: master, totalBps: sum(master) },
    { key: "performer", title: "실연 · 멤버 보이스", edge: "OWNED_BY", rows: perf, totalBps: 0 },
  ];
}

export type PartRow = { slotId: string; slotNo: number; section: string; partNo: number; kind: PartKind; role: string | null; original: string | null; startMs: number; endMs: number; slotStartMs: number; slotEndMs: number };

/** 슬롯(정렬 순서) → 파트 번호 순으로 펼친 행. slotNo는 1부터. */
export function slotPartRows(slots: SlotWithParts[]): PartRow[] {
  return [...slots].sort((a, b) => a.sortOrder - b.sortOrder || (a.slotId < b.slotId ? -1 : 1)).flatMap((s, i) =>
    [...s.parts].sort((a, b) => a.partNo - b.partNo).map((p) => ({
      slotId: s.slotId, slotNo: i + 1, section: s.sectionLabel ?? s.slotId, partNo: p.partNo, kind: p.kind, role: p.role, original: p.originalPartyId,
      startMs: p.startMs, endMs: p.endMs, slotStartMs: s.startMs, slotEndMs: s.endMs,
    })));
}

export type Cell = { state: "original" | "registered" | "empty"; stemId?: string };
/** 보컬 파트 행 × 부른 멤버 열. 원곡 담당이 부른 스템은 original, 다른 멤버는 registered, 없으면 empty. */
export function stemMatrix(rows: PartRow[], stems: StemRow[], singers: string[]): Cell[][] {
  return rows.filter((r) => r.kind === "VOCAL").map((r) => singers.map((m) => {
    const s = stems.find((x) => x.slotId === r.slotId && x.partNo === r.partNo && x.performerPartyId === m);
    if (s === undefined) return { state: "empty" as const };
    return { state: m === r.original ? ("original" as const) : ("registered" as const), stemId: s.stemId };
  }));
}

export type MemberProgress = {
  member: string; name: string; voice: string | null; ownership: "확인됨" | "대기" | "없음";
  origParts: [number, number]; extraStems: [number, number]; consent: boolean; mandate: boolean; left: number;
};
/**
 * 멤버 확인·동의 진행: 보이스 소유 주장, 원곡 파트 실연(원곡 담당인 파트에서 부른 스템), 추가 녹음 스템 실연, 이용 동의, 수령 위임.
 * 확인 여부는 주장 상태(VERIFIED)로 본다 — 멤버가 확인하면 주장이 확정된다.
 */
export function memberProgress(members: { partyId: string; name: string }[], claims: Claim[], rows: PartRow[], stems: StemRow[], consents: ConsentRow[], mandates: Mandate[], now: string): MemberProgress[] {
  const cur = currentClaims(claims);
  const vocal = rows.filter((r) => r.kind === "VOCAL");
  return members.map((m) => {
    const own = cur.find((c) => c.edge === "OWNED_BY" && c.targetId === m.partyId);
    const voice = own?.sourceId ?? null;
    const perfOk = (stemId: string) => cur.some((c) => c.edge === "PERFORMED_BY" && c.sourceId === stemId && c.status === "VERIFIED");
    const mine = stems.filter((s) => s.performerPartyId === m.partyId && vocal.some((r) => r.slotId === s.slotId && r.partNo === s.partNo));
    const isOrig = (s: StemRow) => vocal.some((r) => r.slotId === s.slotId && r.partNo === s.partNo && r.original === m.partyId);
    const orig = mine.filter(isOrig), extra = mine.filter((s) => !isOrig(s));
    const origParts: [number, number] = [orig.filter((s) => perfOk(s.stemId)).length, vocal.filter((r) => r.original === m.partyId).length];
    const extraStems: [number, number] = [extra.filter((s) => perfOk(s.stemId)).length, extra.length];
    const consent = voice !== null && consents.some((c) => c.rightType === "PERFORMER" && c.assetId === voice && c.status === "SIGNED" && c.validFrom <= now && c.validTo > now);
    const mandate = mandates.some((x) => x.fromPartyId === m.partyId && x.rightKind === "PERFORMER" && x.status === "VERIFIED" && x.supersededAt === null);
    const ownership = own === undefined ? "없음" : own.status === "VERIFIED" ? "확인됨" : "대기";
    const left = (ownership === "확인됨" ? 0 : 1) + (origParts[1] - origParts[0]) + (extraStems[1] - extraStems[0]) + (consent ? 0 : 1) + (mandate ? 0 : 1);
    return { member: m.partyId, name: m.name, voice, ownership, origParts, extraStems, consent, mandate, left };
  });
}

/** 멤버별 부른 시간(초): 보컬 파트 길이를 원곡 담당(또는 배치에서 고른 멤버)에게 더한다. 그룹·반주 파트는 넣지 않는다(SL7). */
export function sungSeconds(rows: PartRow[], singerOf: (r: PartRow) => string | null = (r) => r.original): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows.filter((x) => x.kind === "VOCAL")) {
    const who = singerOf(r);
    if (who !== null) out[who] = (out[who] ?? 0) + (r.endMs - r.startMs) / 1000;
  }
  return out;
}

export type PreviewLine = { label: string; won: number; level: 0 | 1 };
/**
 * 분배 규칙 미리보기 근사(시안 Song-Policy 오른쪽 목록과 같은 계산, 표시용). 실연 몫은 참여 멤버 고정분을 균등, 시간 비례분을 부른 시간으로 나눈다.
 * 실제 원 단위 배분·반올림·상한은 엔진 미리보기(/policies/preview)가 한다.
 */
export function previewLines(form: PolicyForm, price: number, sung: Record<string, number>, authors = 2, names: Record<string, string> = {}): PreviewLine[] {
  const b = (bps: number | undefined) => (bps ?? 0) / 10000;
  const p = (bps: number | undefined) => `${(bps ?? 0) / 100}%`;
  const rights = price * b(form.tier1.rightsBps);
  const master = rights * b(form.master.bps), work = rights * b(form.work.bps), perf = rights * b(form.performer.bps);
  const total = Object.values(sung).reduce((a, x) => a + x, 0);
  const n = Object.keys(sung).length;
  const fixed = form.performer.mode === "HYBRID" ? b(form.performer.fixedBps) : form.performer.mode === "FIXED" ? 1 : 0;
  const usage = form.performer.mode === "HYBRID" ? b(form.performer.usageBps) : form.performer.mode === "USAGE_WEIGHTED" ? 1 : 0;
  const lines: PreviewLine[] = [
    { label: `플랫폼 ${p(form.tier1.platformBps)}`, won: price * b(form.tier1.platformBps), level: 0 },
    { label: `운영 ${p(form.tier1.opsBps)}`, won: price * b(form.tier1.opsBps), level: 0 },
    { label: `권리자 ${p(form.tier1.rightsBps)}`, won: rights, level: 0 },
    { label: `녹음 ${p(form.master.bps)} → 마스터 보유자`, won: master, level: 1 },
    { label: `작품 ${p(form.work.bps)} → 작가 ${authors}명 각`, won: authors > 0 ? work / authors : 0, level: 1 },
    { label: `실연 ${p(form.performer.bps)}${form.performer.viaMandate ? " → 수령 위임대로" : ""}`, won: perf, level: 1 },
  ];
  for (const [who, s] of Object.entries(sung)) {
    lines.push({ label: `· ${names[who] ?? who} 기여 ${s.toFixed(1)}초`, won: (n > 0 ? (perf * fixed) / n : 0) + (total > 0 ? (perf * usage * s) / total : 0), level: 1 });
  }
  return lines;
}

export const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;
export const pctText = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** id 자동 만들기: 제목 → 소문자 영숫자 밑줄. 한글 등만 있으면 "song". 이미 있으면 숫자 꼬리. */
export function slugId(prefix: string, title: string, taken: Set<string> = new Set()): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "song";
  let id = `${prefix}_${base}`;
  for (let k = 2; taken.has(id); k++) id = `${prefix}_${base}_${k}`;
  return id;
}

export type ChangeLine = { at: string; who: string; what: string };
/**
 * 최근 변경(시안 Song-Rights "최근 변경", Catalog "변경 이력"): 곡 단위 감사 로그 조회가 없어 주장·위임의 버전 기록(recordedAt)에서 만든다.
 * 같은 분·같은 종류는 한 줄로 묶는다. 새 순.
 */
export function recentChanges(claims: Claim[], mandates: Mandate[], name: (p: string) => string, org = "권리자"): ChangeLine[] {
  const ownerOf = new Map(claims.filter((c) => c.edge === "OWNED_BY").map((c) => [c.sourceId, c.targetId]));
  const groups = new Map<string, { at: string; who: string; kind: string; n: Set<string>; extra: string }>();
  const add = (at: string, who: string, kind: string, item: string, extra = "") => {
    const k = `${at.slice(0, 16)}|${who}|${kind}`;
    const g = groups.get(k) ?? { at, who, kind, n: new Set<string>(), extra };
    g.n.add(item); groups.set(k, g);
  };
  for (const c of claims) {
    const owner = c.edge === "OWNED_BY" ? c.targetId : c.edge === "PERFORMED_BY" ? ownerOf.get(c.targetId) ?? c.targetId : c.targetId;
    if (c.version === 1) {
      if (c.edge === "CONTROLLED_BY") add(c.recordedAt, org, "master", c.claimId, `${pctText(c.shareBps)} 등록(${c.status === "VERIFIED" ? "확정" : "확인 요청"})`);
      else if (c.edge === "WRITTEN_BY") add(c.recordedAt, org, "work", c.claimId, c.status === "VERIFIED" ? "확정" : "확인 요청");
      else if (c.edge === "OWNED_BY" || c.edge === "PERFORMED_BY") add(c.recordedAt, org, "perf", owner);
    } else if (c.status === "VERIFIED") {
      add(c.recordedAt, c.edge === "WRITTEN_BY" ? "운영" : `${name(owner)}(본인)`, c.edge === "WRITTEN_BY" ? "workok" : "self", c.claimId);
    }
  }
  for (const m of mandates) if (m.version === 1) add(m.recordedAt, org, "mandate", m.mandateId, m.status === "VERIFIED" ? "반영" : "확인 요청");
  const text = (g: { kind: string; who: string; n: Set<string>; extra: string }) => ({
    master: `녹음 마스터 ${g.extra}`, work: `작가 지분 ${g.n.size}건 등록 → ${g.extra}`, perf: `멤버 ${g.n.size}명 실연자 등록 → 확인 요청`,
    workok: `작가 지분 ${g.n.size}건 원문 대조 확인`, self: `${g.who.replace("(본인)", "")} 본인 확인`, mandate: `수령 위임 ${g.n.size}건 ${g.extra}`,
  } as Record<string, string>)[g.kind]!;
  return [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).map((g) => ({ at: g.at, who: g.who, what: text(g) }));
}
/** "2026-01-02T09:00:00.000Z" → "01-02 09:00" */
export const shortAt = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;

/** 스템 id 규칙:stm_<슬롯 id에서 slt_ 뺀 것>_p<파트>_<멤버 party에서 pty_ 뺀 것>. */
export const stemIdFor = (slotId: string, partNo: number, partyId: string) => `stm_${slotId.replace(/^slt_/, "")}_p${partNo}_${partyId.replace(/^pty_/, "")}`;

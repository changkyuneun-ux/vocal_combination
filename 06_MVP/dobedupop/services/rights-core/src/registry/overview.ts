import { withSystemScope } from "../platform/actor.ts";
import { iso, type Tx } from "../platform/db.ts";

/** 작품 목록의 진행 상태(2부-B 화면, 결정 ED3). */
export type WorkStatus = "입력 중" | "확인 대기" | "IR 생성됨" | "판매 중" | "분쟁·보류";
export type WorkOverview = {
  workId: string; title: string; scopeId: string | null; recordingTitle: string | null;
  authors: string[];
  rights: { work: number; master: number; performers: number };
  slots: number; vocalParts: number; stems: number;
  pendingConfirmations: number;
  sealed: boolean; sealedThrough: string | null;
  pack: { packId: string; status: string } | null;
  activePolicy: boolean;
  stage: 0 | 1 | 2 | 3 | 4;
  status: WorkStatus;
};

/**
 * 진행 단계: 팩 ACTIVE → 4(판매 중) · 활성 정책 → 3 · 봉인됨 → 2(IR 생성됨) · 확인 대기 > 0 → 1(확인 대기) · 그 밖 0(입력 중).
 * 열린 분쟁이 있거나 팩이 PAUSED면 상태만 "분쟁·보류"(단계는 그대로).
 */
export function stageOf(w: { packStatus: string | null; activePolicy: boolean; sealed: boolean; pending: number; openDisputes: number }): { stage: WorkOverview["stage"]; status: WorkStatus } {
  const stage: WorkOverview["stage"] = w.packStatus === "ACTIVE" ? 4 : w.activePolicy ? 3 : w.sealed ? 2 : w.pending > 0 ? 1 : 0;
  if (w.openDisputes > 0 || w.packStatus === "PAUSED") return { stage, status: "분쟁·보류" };
  // 단계 3(규칙 활성, 출시 대기)은 상태로는 아직 "IR 생성됨"이다.
  return { stage, status: (["입력 중", "확인 대기", "IR 생성됨", "IR 생성됨", "판매 중"] as const)[stage] };
}

/**
 * 테넌트가 볼 수 있는 곡마다 요약·진행 단계(포털 작품 목록). 보이는 곡은 RLS로 정하고, 집계는 그 곡들 안에서만 system 범위로 한 질의로 모은다.
 */
export async function worksOverview(tx: Tx): Promise<WorkOverview[]> {
  const visible = (await tx.query(
    "SELECT w.work_id, w.title, s.facts_scope_id FROM work w LEFT JOIN facts_scope s ON s.work_id = w.work_id ORDER BY w.title, w.work_id LIMIT 500")).rows;
  if (visible.length === 0) return [];
  const ids = visible.map((v) => v.work_id as string);
  const rows = await withSystemScope(tx, async () => (await tx.query(
    `SELECT w.work_id, s.facts_scope_id, s.sealed_through,
            rec.title AS recording_title, au.names AS authors, cl.work_n, cl.master_n, cl.perf_n,
            cat.slots, cat.vocal_parts, cat.stems, cf.pending, pk.pack_id, pk.status AS pack_status, pol.active, dp.open_disputes
       FROM work w
       LEFT JOIN facts_scope s ON s.work_id = w.work_id
       LEFT JOIN LATERAL (SELECT version_title AS title FROM recording_version r WHERE r.work_id = w.work_id ORDER BY r.created_at, r.recording_id LIMIT 1) rec ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(p.display_name ORDER BY c.claim_id) AS names FROM right_claim c JOIN party p ON p.party_id = c.target_id
          WHERE c.facts_scope_id = s.facts_scope_id AND c.edge = 'WRITTEN_BY' AND c.superseded_at IS NULL AND c.status <> 'SUPERSEDED') au ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE edge = 'WRITTEN_BY')::int AS work_n, count(*) FILTER (WHERE edge = 'CONTROLLED_BY')::int AS master_n,
                count(*) FILTER (WHERE edge = 'OWNED_BY')::int AS perf_n
           FROM right_claim c WHERE c.facts_scope_id = s.facts_scope_id AND c.superseded_at IS NULL AND c.status <> 'SUPERSEDED') cl ON true
       LEFT JOIN LATERAL (
         SELECT (SELECT count(*)::int FROM part_slot sl JOIN recording_version r ON r.recording_id = sl.recording_id WHERE r.work_id = w.work_id) AS slots,
                (SELECT count(*)::int FROM slot_part p JOIN part_slot sl ON sl.slot_id = p.slot_id JOIN recording_version r ON r.recording_id = sl.recording_id
                  WHERE r.work_id = w.work_id AND p.kind = 'VOCAL') AS vocal_parts,
                (SELECT count(*)::int FROM stem st JOIN recording_version r ON r.recording_id = st.recording_id WHERE r.work_id = w.work_id) AS stems) cat ON true
       LEFT JOIN LATERAL (SELECT count(*)::int AS pending FROM confirmation_request q WHERE q.facts_scope_id = s.facts_scope_id AND q.status = 'OPEN') cf ON true
       LEFT JOIN LATERAL (SELECT k.pack_id, k.status FROM vocal_pack k WHERE k.facts_scope_id = s.facts_scope_id ORDER BY (k.status = 'ACTIVE') DESC, k.created_at, k.pack_id LIMIT 1) pk ON true
       LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM policy_version v JOIN vocal_pack k ON k.pack_id = v.pack_id WHERE k.facts_scope_id = s.facts_scope_id AND v.status = 'ACTIVE') AS active) pol ON true
       LEFT JOIN LATERAL (SELECT count(*)::int AS open_disputes FROM dispute d WHERE d.facts_scope_id = s.facts_scope_id AND d.status = 'OPEN') dp ON true
      WHERE w.work_id = ANY($1)`, [ids])).rows);
  const byWork = new Map(rows.map((r) => [r.work_id as string, r]));
  return visible.map((v) => {
    const r = byWork.get(v.work_id)!;
    const sealed = r.sealed_through !== null && r.sealed_through !== undefined;
    const pending = (r.pending as number | null) ?? 0;
    const { stage, status } = stageOf({ packStatus: r.pack_status ?? null, activePolicy: r.active === true, sealed, pending, openDisputes: (r.open_disputes as number | null) ?? 0 });
    return {
      workId: v.work_id, title: v.title, scopeId: v.facts_scope_id ?? null, recordingTitle: r.recording_title ?? null,
      authors: (r.authors as string[] | null) ?? [],
      rights: { work: r.work_n ?? 0, master: r.master_n ?? 0, performers: r.perf_n ?? 0 },
      slots: r.slots ?? 0, vocalParts: r.vocal_parts ?? 0, stems: r.stems ?? 0,
      pendingConfirmations: pending,
      sealed, sealedThrough: sealed ? iso(r.sealed_through)! : null,
      pack: r.pack_id ? { packId: r.pack_id as string, status: r.pack_status as string } : null,
      activePolicy: r.active === true,
      stage, status,
    };
  });
}

import { withSystemScope } from "../platform/actor.ts";
import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";

/**
 * 곡 진행 ①~⑤(2026-10-24, 디자인 가이드 4절): 원본 계약서 → 권리 등록 → 권리 확정 → 이용 허락 → 분배·출시.
 * 단계마다 끝났는지와 아래 상태 글을 실제 데이터로 계산한다. 끝나지 않은 첫 단계가 '지금', 그 뒤는 '남음'.
 */
export type ProgressStep = { key: "documents" | "register" | "confirm" | "license" | "release"; label: string; done: boolean; state: "done" | "now" | "todo"; note: string };

const LICENSE_TEMPLATES = ["tpl_master_license", "tpl_work_license", "tpl_performer_mandate"];

export async function songProgress(tx: Tx, scopeId: string, now: string): Promise<{ scopeId: string; steps: ProgressStep[] }> {
  if ((await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rowCount === 0) throw notFound("facts scope", scopeId);
  // 곡 안의 행은 멤버·작가가 확인해 쓴 새 버전(소유 테넌트가 다르다)도 있으므로 범위가 보이면 system 범위로 센다.
  return withSystemScope(tx, async () => {
    const q = async (sql: string, p: unknown[] = [scopeId]) => (await tx.query(sql, p)).rows;
    // ① 원본 계약서: 이 곡에 묶인 직접 올린 계약서(녹음·작품).
    const docs = await q(`SELECT DISTINCT ON (document_id) kind, status FROM source_document WHERE facts_scope_id = $1 AND origin = 'UPLOADED' ORDER BY document_id, version DESC`);
    const usable = docs.filter((d) => d.status !== "REJECTED");
    const hasMaster = usable.some((d) => d.kind === "MASTER_CONTRACT"), hasWork = usable.some((d) => d.kind === "PUBLISHING");
    const s1 = { done: hasMaster && hasWork, note: hasMaster && hasWork ? `${usable.length}건` : [hasMaster ? "" : "녹음 계약서 없음", hasWork ? "" : "작품 계약서 없음"].filter(Boolean).join(" · ") };
    // ② 권리 등록: 작품(작가 지분 합 100%) · 녹음(마스터 보유) · 실연(보이스 소유).
    const claims = await q("SELECT edge, share_bps, status FROM right_claim WHERE facts_scope_id = $1 AND superseded_at IS NULL AND edge IN ('WRITTEN_BY','CONTROLLED_BY','OWNED_BY')");
    const work = claims.filter((c) => c.edge === "WRITTEN_BY").reduce((a, c) => a + (c.share_bps as number), 0) === 10000;
    const master = claims.some((c) => c.edge === "CONTROLLED_BY"), perf = claims.some((c) => c.edge === "OWNED_BY");
    const have = [work ? "작품" : "", master ? "녹음" : "", perf ? "실연" : ""].filter(Boolean);
    const s2 = { done: work && master && perf, note: have.length === 3 ? have.join("·") : `${["작품", "녹음", "실연"].filter((x) => !have.includes(x)).join("·")} 남음` };
    // ③ 권리 확정: 등록한 권리가 모두 VERIFIED, 열린 확인 요청 없음.
    const open = await q(`SELECT p.party_type, count(*)::int AS n FROM confirmation_request r JOIN party p ON p.party_id = r.counterparty_id
                           WHERE r.facts_scope_id = $1 AND r.status = 'OPEN' GROUP BY p.party_type`);
    const waiting = open.map((o) => `${o.party_type === "AUTHOR" ? "작가" : o.party_type === "MEMBER" ? "멤버" : "상대"} ${o.n} ${o.party_type === "AUTHOR" ? "서명" : "확인"} 대기`);
    const unverified = claims.filter((c) => c.status !== "VERIFIED").length;
    const s3 = { done: s2.done && unverified === 0 && open.length === 0, note: s2.done && unverified === 0 && open.length === 0 ? "확정" : waiting.length ? waiting.join(" · ") : unverified ? `확인 요청 전 ${unverified}건` : "" };
    // ④ 이용 허락: 녹음·작품 이용허락·수령 위임 계약(반영 = COMPLETED)과 멤버 실연 이용 동의.
    const contracts = await q("SELECT status FROM contract_envelope WHERE facts_scope_id = $1 AND template_id = ANY($2) AND status <> 'CANCELLED'", [scopeId, LICENSE_TEMPLATES]);
    const voices = (await q("SELECT count(DISTINCT c.target_id)::int AS n FROM right_claim c WHERE c.facts_scope_id = $1 AND c.edge = 'OWNED_BY' AND c.superseded_at IS NULL"))[0].n as number;
    const consented = (await q(`SELECT count(DISTINCT party_id)::int AS n FROM consent_agreement WHERE facts_scope_id = $1 AND right_type = 'PERFORMER' AND revoked_at IS NULL
                                  AND valid_from <= $2 AND valid_to > $2`, [scopeId, now]))[0].n as number;
    const total = contracts.length + voices, signed = contracts.filter((c) => c.status === "COMPLETED").length + Math.min(consented, voices);
    const s4 = { done: total > 0 && signed === total, note: total === 0 ? "" : signed === total ? `${signed} / ${total}` : `${signed} / ${total} 서명` };
    // ⑤ 분배·출시: 분배 규칙 활성 + 팩 판매 중.
    const pack = (await q("SELECT status FROM vocal_pack WHERE facts_scope_id = $1 ORDER BY (status = 'ACTIVE') DESC LIMIT 1"))[0];
    const pol = (await q(`SELECT v.version, v.status FROM policy_version v JOIN vocal_pack p ON p.pack_id = v.pack_id WHERE p.facts_scope_id = $1
                           ORDER BY (v.status = 'ACTIVE') DESC, v.version DESC LIMIT 1`))[0];
    const released = pack?.status === "ACTIVE" && pol?.status === "ACTIVE";
    const s5 = { done: released, note: released ? `IR v${pol.version} · 판매 중` : pol ? `분배 규칙 v${pol.version} ${pol.status === "ACTIVE" ? "활성" : pol.status === "APPROVED" ? "승인" : "컴파일"}` : "" };
    const raw: [ProgressStep["key"], string, { done: boolean; note: string }][] = [
      ["documents", "원본 계약서", s1], ["register", "권리 등록", s2], ["confirm", "권리 확정", s3], ["license", "이용 허락", s4], ["release", "분배·출시", s5],
    ];
    const firstOpen = raw.findIndex(([, , s]) => !s.done);
    return { scopeId, steps: raw.map(([key, label, s], i) => ({ key, label, done: s.done, note: s.note, state: s.done ? "done" : i === firstOpen ? "now" : "todo" })) };
  });
}

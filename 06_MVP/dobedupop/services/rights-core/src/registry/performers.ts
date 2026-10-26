import { withSystemScope } from "../platform/actor.ts";
import type { Tx } from "../platform/db.ts";

/** 실연자 구역 한 줄(PT2·PT5): 표시 이름·구분·참여 곡·확인·동의 상태·실연 몫 받는 쪽만. 지급 정보·계좌·세금·연락처는 없다. */
export type PerformerRow = {
  partyId: string; displayName: string; partyType: string; kind: string;
  songs: { scopeId: string; title: string }[];
  status: { done: boolean; label: string; waiting: { title: string; what: "CONFIRM" | "CONSENT" }[] };
  receiver: string;
};

const KIND: Record<string, string> = { MEMBER: "멤버", SESSION: "세션", ARTIST: "아티스트" };

/**
 * 이 권리 테넌트 곡에 이름이 오른 실연자(PT2·PT5): 보이스 소유(현재 OWNED_BY) 또는 원곡 파트 담당.
 * 실연자 당사자는 개인 영역(tnt_platform_default)에 있어, 이 테넌트 곡에 오른 사람만 system 범위로 읽고 공유 규칙의 값만 돌려준다.
 * 곡마다 상태: 열린 확인 요청이 있으면 '확인 대기', 지금 유효한 실연 이용 동의가 없으면 '동의 대기', 둘 다 아니면 끝.
 * 한 번도 확인·동의한 적이 없으면 '초대 보냄 · 미확인'. 실연 몫 받는 쪽은 실연(PERFORMER) 수령 위임처, 없으면 '본인'.
 */
export async function tenantPerformers(tx: Tx, tenantId: string, now: string): Promise<PerformerRow[]> {
  return withSystemScope(tx, async () => {
    const rows = (await tx.query(
      `WITH scopes AS (SELECT s.facts_scope_id, s.work_id, w.title, s.created_at FROM facts_scope s JOIN work w ON w.work_id = s.work_id WHERE s.owner_tenant_id = $1),
            names AS (
              SELECT c.facts_scope_id, c.target_id AS party_id FROM right_claim c JOIN voice v ON v.voice_id = c.source_id
               WHERE c.edge = 'OWNED_BY' AND c.superseded_at IS NULL AND c.facts_scope_id IN (SELECT facts_scope_id FROM scopes)
              UNION
              SELECT sc.facts_scope_id, sp.original_party_id FROM slot_part sp JOIN part_slot ps ON ps.slot_id = sp.slot_id
                JOIN recording_version r ON r.recording_id = ps.recording_id JOIN scopes sc ON sc.work_id = r.work_id
               WHERE sp.original_party_id IS NOT NULL)
       SELECT n.party_id, p.display_name, p.party_type, n.facts_scope_id, sc.title,
              (SELECT count(*)::int FROM confirmation_request q WHERE q.facts_scope_id = n.facts_scope_id AND q.counterparty_id = n.party_id AND q.status = 'OPEN') AS open_requests,
              EXISTS (SELECT 1 FROM consent_agreement a WHERE a.facts_scope_id = n.facts_scope_id AND a.party_id = n.party_id AND a.right_type = 'PERFORMER'
                        AND a.revoked_at IS NULL AND a.valid_from <= $2 AND a.valid_to > $2) AS consented,
              (SELECT string_agg(DISTINCT tp.display_name, ' · ') FROM mandate m JOIN party tp ON tp.party_id = m.to_party_id
                WHERE m.facts_scope_id = n.facts_scope_id AND m.from_party_id = n.party_id AND m.right_kind = 'PERFORMER' AND m.superseded_at IS NULL) AS receiver
         FROM names n JOIN party p ON p.party_id = n.party_id JOIN scopes sc ON sc.facts_scope_id = n.facts_scope_id
        WHERE p.party_type IN ('MEMBER', 'SESSION', 'ARTIST')
        ORDER BY p.created_at, p.party_id, sc.created_at, sc.title`, [tenantId, now])).rows;
    const ever = new Set((await tx.query(
      `SELECT DISTINCT counterparty_id AS party_id FROM confirmation_request WHERE status IN ('CONFIRMED','PLATFORM_VERIFIED') AND counterparty_id = ANY($1)
       UNION SELECT DISTINCT party_id FROM consent_agreement WHERE party_id = ANY($1)`, [[...new Set(rows.map((r) => r.party_id as string))]])).rows.map((r) => r.party_id as string));
    const out = new Map<string, PerformerRow & { receivers: Set<string> }>();
    for (const r of rows) {
      const id = r.party_id as string;
      const p: PerformerRow & { receivers: Set<string> } = out.get(id) ?? { partyId: id, displayName: r.display_name, partyType: r.party_type, kind: KIND[r.party_type as string] ?? r.party_type,
        songs: [], status: { done: true, label: "", waiting: [] }, receiver: "", receivers: new Set<string>() };
      p.songs.push({ scopeId: r.facts_scope_id, title: r.title });
      if ((r.open_requests as number) > 0) p.status.waiting.push({ title: r.title, what: "CONFIRM" });
      else if (!r.consented) p.status.waiting.push({ title: r.title, what: "CONSENT" });
      p.receivers.add((r.receiver as string | null) ?? "본인");
      out.set(id, p);
    }
    return [...out.values()].map(({ receivers, ...p }) => {
      const w = p.status.waiting[0];
      const label = w === undefined ? "확인·동의 완료" : !ever.has(p.partyId) ? "초대 보냄 · 미확인" : `${w.title} ${w.what === "CONFIRM" ? "확인" : "동의"} 대기`;
      return { ...p, status: { ...p.status, done: w === undefined, label }, receiver: [...receivers].join(" · ") };
    });
  });
}

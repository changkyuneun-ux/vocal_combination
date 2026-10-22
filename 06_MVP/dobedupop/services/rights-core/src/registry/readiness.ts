import { withSystemScope } from "../platform/actor.ts";
import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { checkScope } from "../validation/service.ts";

export type ReadinessItem = { key: string; ok: boolean | "warn"; label: string; detail: string };

/**
 * IR 생성 준비(곡 워크스페이스 위 띠, 결정 ED3): 갈래별 지분 합계, 확정 주장의 근거 문서, 파트별 원곡 스템, 확인 대기,
 * 보이스별 유효 이용 동의, 멤버 수령 위임, 스템 오디오, 정합성 차단. 범위는 요청자에게 보여야 하고(RLS) 집계는 곡 안에서 system 범위로 한다.
 */
export async function scopeReadiness(tx: Tx, scopeId: string, now: string): Promise<{ items: ReadinessItem[] }> {
  const scope = (await tx.query("SELECT facts_scope_id, work_id FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0];
  if (scope === undefined) throw notFound("facts scope", scopeId);
  return withSystemScope(tx, async () => {
    const q = async (sql: string, p: unknown[]) => (await tx.query(sql, p)).rows;
    const claims = await q(
      "SELECT claim_id, version, source_id, edge, target_id, share_bps, status FROM right_claim WHERE facts_scope_id = $1 AND superseded_at IS NULL AND status <> 'SUPERSEDED'", [scopeId]);
    const items: ReadinessItem[] = [];

    // 지분: 작품(WRITTEN_BY)·녹음(녹음마다 CONTROLLED_BY) 합계 100%. 실연은 보이스마다 소유 100%.
    const sum = (rows: any[]) => rows.reduce((a, c) => a + (c.share_bps as number), 0);
    const bad: string[] = [];
    const work = claims.filter((c) => c.edge === "WRITTEN_BY");
    if (work.length === 0 || sum(work) !== 10000) bad.push(`작품 ${sum(work) / 100}%`);
    for (const src of [...new Set(claims.filter((c) => c.edge === "CONTROLLED_BY").map((c) => c.source_id as string))]) {
      const s = sum(claims.filter((c) => c.edge === "CONTROLLED_BY" && c.source_id === src));
      if (s !== 10000) bad.push(`녹음 ${src} ${s / 100}%`);
    }
    if (!claims.some((c) => c.edge === "CONTROLLED_BY")) bad.push("녹음 권리 없음");
    for (const v of [...new Set(claims.filter((c) => c.edge === "OWNED_BY").map((c) => c.source_id as string))]) {
      const s = sum(claims.filter((c) => c.edge === "OWNED_BY" && c.source_id === v));
      if (s !== 10000) bad.push(`보이스 ${v} ${s / 100}%`);
    }
    items.push({ key: "shares", ok: bad.length === 0, label: "지분 합계", detail: bad.length === 0 ? "작품·녹음·실연 갈래별 100%" : bad.join(", ") });

    // 근거 문서: 확정(VERIFIED) 주장 중 작품·녹음 주장에 근거 문서가 있는가.
    const verified = claims.filter((c) => c.status === "VERIFIED" && (c.edge === "WRITTEN_BY" || c.edge === "CONTROLLED_BY"));
    const withDoc = new Set((await q(
      "SELECT DISTINCT record_id || '@' || record_version AS k FROM record_evidence WHERE record_type = 'CLAIM' AND record_id = ANY($1)", [verified.map((c) => c.claim_id)])).map((r) => r.k as string));
    const noDoc = verified.filter((c) => !withDoc.has(`${c.claim_id}@${c.version}`)).length;
    items.push({ key: "evidence", ok: noDoc === 0, label: "근거 문서", detail: noDoc === 0 ? `확정 주장 ${verified.length}건 모두 연결` : `근거 문서 없는 확정 주장 ${noDoc}건` });

    // 원곡 스템: 보컬 파트는 원곡 담당이 부른 스템, 그룹 파트는 스템 하나 이상.
    const parts = await q(
      `SELECT p.slot_id, p.part_no, p.kind, p.original_party_id,
              EXISTS (SELECT 1 FROM stem st WHERE st.slot_id = p.slot_id AND st.part_no = p.part_no
                       AND (p.kind = 'GROUP' OR st.performer_party_id = p.original_party_id)) AS has_original
         FROM slot_part p JOIN part_slot sl ON sl.slot_id = p.slot_id JOIN recording_version r ON r.recording_id = sl.recording_id
        WHERE r.work_id = $1 AND p.kind IN ('VOCAL','GROUP')`, [scope.work_id]);
    const missing = parts.filter((p) => !p.has_original).length;
    items.push({ key: "originalStems", ok: parts.length === 0 ? "warn" : missing === 0, label: "원곡 스템",
      detail: parts.length === 0 ? "보컬·그룹 파트가 없다" : missing === 0 ? `파트 ${parts.length}개 모두 원곡 스템 있음` : `원곡 스템 없는 파트 ${missing}개` });

    const pending = (await q("SELECT count(*)::int AS n FROM confirmation_request WHERE facts_scope_id = $1 AND status = 'OPEN'", [scopeId]))[0].n as number;
    items.push({ key: "confirmations", ok: pending === 0 ? true : "warn", label: "확인 대기", detail: pending === 0 ? "남은 확인 요청 없음" : `확인 대기 ${pending}건` });

    // 이용 동의: 이 곡의 보이스마다 지금 유효한 실연 동의.
    const voices = (await q("SELECT voice_id FROM voice WHERE facts_scope_id = $1", [scopeId])).map((r) => r.voice_id as string);
    const consented = new Set((await q(
      "SELECT DISTINCT asset_id FROM consent_agreement WHERE facts_scope_id = $1 AND right_type = 'PERFORMER' AND revoked_at IS NULL AND valid_from <= $2 AND valid_to > $2",
      [scopeId, now])).map((r) => r.asset_id as string));
    const noConsent = voices.filter((v) => !consented.has(v)).length;
    items.push({ key: "consents", ok: voices.length === 0 ? "warn" : noConsent === 0, label: "이용 동의",
      detail: voices.length === 0 ? "보이스가 없다" : `보이스 ${voices.length - noConsent}/${voices.length} 동의` });

    // 수령 위임: 보이스 소유 멤버 중 실연 몫 수령 위임이 확정된 수(없어도 IR 생성은 된다 — 정보).
    const owners = [...new Set(claims.filter((c) => c.edge === "OWNED_BY").map((c) => c.target_id as string))];
    const mandated = new Set((await q(
      "SELECT DISTINCT from_party_id FROM mandate WHERE facts_scope_id = $1 AND right_kind = 'PERFORMER' AND status = 'VERIFIED' AND superseded_at IS NULL", [scopeId])).map((r) => r.from_party_id as string));
    const done = owners.filter((o) => mandated.has(o)).length;
    items.push({ key: "mandates", ok: owners.length === 0 || done === owners.length ? true : "warn", label: "수령 위임", detail: `멤버 ${done}/${owners.length} 반영` });

    const notReady = (await q(
      `SELECT count(*)::int AS n FROM stem_audio a JOIN stem st ON st.stem_id = a.stem_id JOIN recording_version r ON r.recording_id = st.recording_id
        WHERE r.work_id = $1 AND a.status <> 'READY'`, [scope.work_id]))[0].n as number;
    items.push({ key: "audio", ok: notReady === 0 ? true : "warn", label: "스템 오디오", detail: notReady === 0 ? "올린 오디오 모두 사용 가능" : `검사 중이거나 막힌 오디오 ${notReady}개` });

    const blocks = (await checkScope(tx, scopeId, now)).filter((v) => v.severity === "BLOCK").length;
    items.push({ key: "blocks", ok: blocks === 0, label: "정합성 차단", detail: blocks === 0 ? "차단 없음" : `차단 ${blocks}건` });
    return { items };
  });
}

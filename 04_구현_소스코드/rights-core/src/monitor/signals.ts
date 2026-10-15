import type { Tx } from "../platform/db.ts";

export type Severity = "ok" | "warn" | "bad";
export type Signal = { key: string; label: string; value: number | string; severity: Severity; link?: string };
export type Stage = { stage: string; label: string; decidedBy: string; signals: Signal[] };

const DAY = 86_400_000;
const n = async (tx: Tx, sql: string, p: unknown[] = []) => Number((await tx.query(sql, p)).rows[0].n);
const sig = (key: string, label: string, value: number | string, severity: Severity, link?: string): Signal => ({ key, label, value, severity, ...(link && { link }) });
const warnIf = (v: number): Severity => (v > 0 ? "warn" : "ok");
const badIf = (v: number): Severity => (v > 0 ? "bad" : "ok");

/**
 * ⑧ 파이프라인 단계별 신호(아키텍처 문서 "⑧ 권리 파이프라인 관제" 표). 플랫폼 범위에서 전 테넌트를 집계한다(상태·건수·합계만, 개인정보 없음).
 * now는 관제 시각(가상 시계)이다. 기간 신호(최근 7일·30일, 만료 임박)는 이 시각 기준이다.
 */
export async function pipelineSignals(tx: Tx, now: string): Promise<{ asOf: string; stages: Stage[] }> {
  const at = Date.parse(now);
  const in30 = new Date(at + 30 * DAY).toISOString();
  const ago7 = new Date(at - 7 * DAY).toISOString();
  const ago30 = new Date(at - 30 * DAY).toISOString();
  const cur = "superseded_at IS NULL";

  const asserted = await n(tx, `SELECT count(*) AS n FROM right_claim WHERE ${cur} AND status = 'ASSERTED'`);
  const disputed = await n(tx, `SELECT (SELECT count(*) FROM right_claim WHERE ${cur} AND status = 'DISPUTED') + (SELECT count(*) FROM mandate WHERE ${cur} AND status = 'DISPUTED') AS n`);
  const openDisputes = await n(tx, "SELECT count(*) AS n FROM dispute WHERE status = 'OPEN'");
  const expiring = await n(tx, `SELECT count(*) AS n FROM mandate WHERE ${cur} AND valid_to IS NOT NULL AND valid_to > $1 AND valid_to <= $2`, [now, in30]);

  const audio = Object.fromEntries((await tx.query("SELECT status, count(*)::int AS n FROM stem_audio GROUP BY status")).rows.map((r) => [r.status, r.n as number]));
  const waiting = await n(tx, "SELECT count(*) AS n FROM policy_version WHERE status IN ('COMPILED','APPROVED')");
  const stale = await n(tx,
    `SELECT count(*) AS n FROM vocal_pack p JOIN policy_version v ON v.pack_id = p.pack_id AND v.status = 'ACTIVE'
      WHERE EXISTS (SELECT 1 FROM dispute d WHERE d.facts_scope_id = p.facts_scope_id AND d.status = 'CLOSED' AND d.closed_at > v.facts_known_at)`);

  const packs = Object.fromEntries((await tx.query("SELECT status, count(*)::int AS n FROM vocal_pack GROUP BY status")).rows.map((r) => [r.status, r.n as number]));

  const issued7 = await n(tx, "SELECT count(*) AS n FROM rights_snapshot WHERE created_at > $1", [ago7]);
  const rejected7 = await n(tx, "SELECT count(*) AS n FROM issue_rejection WHERE occurred_at > $1", [ago7]);
  const byCode = (await tx.query("SELECT code, count(*)::int AS n FROM issue_rejection WHERE occurred_at > $1 GROUP BY code ORDER BY code", [ago7])).rows;
  const rate = issued7 + rejected7 === 0 ? 0 : rejected7 / (issued7 + rejected7);

  const flagged = await n(tx, "SELECT count(*) AS n FROM revenue_event WHERE integrity_status = 'FLAGGED' AND event_type <> 'REFUND'");
  const unsettled = (await tx.query(
    `SELECT count(*)::int AS n, COALESCE(sum(e.net_amount_krw), 0)::text AS amt FROM revenue_event e
      WHERE e.event_type <> 'REFUND' AND NOT EXISTS (
        SELECT 1 FROM settlement_run_event re JOIN settlement_run r ON r.run_id = re.run_id WHERE re.event_id = e.event_id AND re.active AND r.status = 'CONFIRMED')`)).rows[0];

  const runs = Object.fromEntries((await tx.query("SELECT status, count(*)::int AS n FROM settlement_run GROUP BY status")).rows.map((r) => [r.status, r.n as number]));
  const quarantined = await n(tx, "SELECT count(*) AS n FROM quarantine WHERE released_at IS NULL");
  const held = (await tx.query(
    `SELECT h.reason, COALESCE(sum(h.amount_krw), 0)::text AS amt FROM unallocated_holding h
      WHERE NOT EXISTS (SELECT 1 FROM hold_release r WHERE r.holding_id = h.holding_id) GROUP BY h.reason ORDER BY h.reason`)).rows;

  const pay = Object.fromEntries((await tx.query("SELECT status, count(*)::int AS n FROM payout_instruction GROUP BY status")).rows.map((r) => [r.status, r.n as number]));
  const heldPay = (await tx.query("SELECT hold_reason, count(*)::int AS n FROM payout_instruction WHERE status = 'HELD' GROUP BY hold_reason ORDER BY hold_reason")).rows;
  const unknown = await n(tx, "SELECT count(*) AS n FROM payout_instruction WHERE status = 'SUBMITTED' AND submit_unknown_at IS NOT NULL");

  const revoked30 = await n(tx, "SELECT count(*) AS n FROM consent_agreement WHERE revoked_at > $1", [ago30]);
  const impacted = (await tx.query(
    "SELECT COALESCE(sum(jsonb_array_length(after_json->'snapshots')), 0)::int AS n FROM audit_log WHERE action_name = 'CONSENT_IMPACT' AND occurred_at > $1", [ago30])).rows[0].n as number;
  const pausedByDispute = await n(tx, "SELECT count(DISTINCT entity_id) AS n FROM audit_log WHERE action_name = 'PACK_PAUSED'");

  return {
    asOf: now,
    stages: [
      { stage: "registry", label: "권리 등록", decidedBy: "권리자", signals: [
        sig("asserted", "증빙 미확인 주장(ASSERTED)", asserted, warnIf(asserted), "/registry/claims"),
        sig("disputed", "분쟁 중 주장·위임", disputed, badIf(disputed), "/registry/claims"),
        sig("open-disputes", "열린 분쟁", openDisputes, badIf(openDisputes), "/registry/disputes"),
        sig("mandates-expiring", "30일 안에 만료되는 위임", expiring, warnIf(expiring), "/registry/mandates"),
      ] },
      { stage: "audio", label: "스템 검수·출처", decidedBy: "플랫폼(기술 신호), 권리자(소명)", signals: [
        sig("audio-pending", "검사 대기 스템", audio.PENDING ?? 0, "ok", "/audio"),
        sig("audio-qc-failed", "QC 실패 스템", audio.QC_FAILED ?? 0, warnIf(audio.QC_FAILED ?? 0), "/audio"),
        sig("audio-review", "출처 검토 대기 스템", audio.REVIEW ?? 0, warnIf(audio.REVIEW ?? 0), "/audio"),
        sig("audio-blocked", "출처 차단 스템", audio.BLOCKED ?? 0, badIf(audio.BLOCKED ?? 0), "/audio"),
        sig("audio-ready", "사용 가능 스템", audio.READY ?? 0, "ok", "/audio"),
      ] },
      { stage: "policy", label: "정책", decidedBy: "권리자", signals: [
        sig("waiting", "승인·활성화 대기 정책 버전", waiting, warnIf(waiting), "/policy"),
        sig("rebind", "재고정이 필요한 활성 정책(분쟁 종결 후)", stale, badIf(stale), "/policy"),
      ] },
      { stage: "pack", label: "팩 활성화", decidedBy: "권리자", signals: [
        sig("active", "활성 팩", packs.ACTIVE ?? 0, "ok", "/packs"),
        sig("draft", "초안 팩", packs.DRAFT ?? 0, "ok", "/packs"),
        sig("paused", "일시정지 팩", packs.PAUSED ?? 0, badIf(packs.PAUSED ?? 0), "/packs"),
      ] },
      { stage: "issuance", label: "조합 발행", decidedBy: "권리자(동의)", signals: [
        sig("issued-7d", "최근 7일 발행", issued7, "ok", "/issues"),
        sig("rejected-7d", "최근 7일 게이트 거부", rejected7, warnIf(rejected7)),
        sig("reject-rate", "거부율(7일)", `${(rate * 100).toFixed(1)}%`, rate > 0.2 ? "bad" : rate > 0 ? "warn" : "ok"),
        ...byCode.map((r) => sig(`rejected-${r.code}`, `거부 사유 ${r.code}`, r.n as number, "warn")),
      ] },
      { stage: "revenue", label: "수익 유입", decidedBy: "플랫폼", signals: [
        sig("flagged", "이상거래 의심 이벤트", flagged, warnIf(flagged), "/revenue"),
        sig("unsettled", "미확정 매출(건)", unsettled.n as number, "ok", "/revenue"),
        sig("unsettled-krw", "미확정 매출(원)", unsettled.amt as string, "ok", "/revenue"),
      ] },
      { stage: "settlement", label: "정산 실행·검증", decidedBy: "플랫폼(실행자 ≠ 확정자)", signals: [
        sig("failed", "재계산 불일치·실패 run", runs.FAILED ?? 0, badIf(runs.FAILED ?? 0), "/settlement/batches"),
        sig("voided", "무효 처리된 run", runs.VOIDED ?? 0, warnIf(runs.VOIDED ?? 0), "/settlement/batches"),
        sig("unverified", "검증 전 run", (runs.PENDING ?? 0) + (runs.CALCULATED ?? 0), "ok", "/settlement/batches"),
        sig("quarantine", "격리 중 조합", quarantined, badIf(quarantined), "/settlement/quarantine"),
        ...held.map((r) => sig(`held-${r.reason}`, `보류 금액(${r.reason})`, r.amt as string, "warn", "/settlement/holds")),
      ] },
      { stage: "payout", label: "원장·지급", decidedBy: "플랫폼", signals: [
        sig("payout-failed", "지급 실패", pay.FAILED ?? 0, badIf(pay.FAILED ?? 0), "/payout/runs"),
        sig("payout-unknown", "전송 결과 불명", unknown, warnIf(unknown), "/payout/runs"),
        ...heldPay.map((r) => sig(`payout-held-${r.hold_reason}`, `지급 보류(${r.hold_reason})`, r.n as number, "warn", "/payout/runs")),
      ] },
      { stage: "dispute", label: "분쟁·철회", decidedBy: "권리자 판정, 플랫폼 집행", signals: [
        sig("revoked-30d", "최근 30일 동의 철회", revoked30, warnIf(revoked30)),
        sig("impacted-30d", "철회 영향 발행 조합(30일)", impacted, warnIf(impacted)),
        sig("paused-by-dispute", "분쟁으로 멈춘 적 있는 팩", pausedByDispute, warnIf(pausedByDispute), "/packs"),
      ] },
    ],
  };
}

import { Link, useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import { resubmitPayout } from "../../api/payout.ts";
import type { AuditRow, InstructionDetailData, WebhookRow } from "../../api/types.ts";
import { failureReason } from "./logic.ts";

const POLL_MS = 3000;
const SETTLE_ACTOR = "usr_settle";
const OPEN = new Set(["PENDING", "SUBMITTED"]);
const json = (v: unknown) => JSON.stringify(v);

export function InstructionDetail() {
  const { instructionId = "" } = useParams();
  const actor = useActor();
  const e = encodeURIComponent(instructionId);
  const q = useGet<InstructionDetailData>(["payout", instructionId], `/payouts/${e}`, {
    refetchInterval: (d) => (d !== undefined && OPEN.has(d.status) ? POLL_MS : false),
  });
  const m = useAction(resubmitPayout, ["payout", "payout-instructions", "payout-runs"]);
  const d = q.data;
  const reason = d ? failureReason(d.audit) : null;
  const tokenMismatch = d && d.decidedAccountRef !== null && d.submittedAccountRef !== null && d.decidedAccountRef !== d.submittedAccountRef;
  return (
    <>
      <Section title={`지급 지시 ${instructionId}`} actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <ErrorPanel error={q.error} />
        {d && (
          <div className="stack">
            <p><Link to={`/payout/runs/${encodeURIComponent(d.payoutRunId)}`}>← 지급 run {d.payoutRunId}</Link></p>
            <p>권리자 {d.partyId} · 상태 <StatusBadge status={d.status} />{d.holdReason && <> · 보류 사유 <strong>{d.holdReason}</strong></>}
              {reason && <> · 실패 사유 <strong>{reason}</strong> <span className="muted">(감사 PAYOUT_FAILED 기록)</span></>}</p>
            <p>총액 <Money krw={d.grossKrw} /> · 원천세 <Money krw={d.withholdingKrw} /> · 실지급 <Money krw={d.netKrw} /></p>
            <ul className="stack" aria-label="지시 표식">
              <li>전송 시도: {d.submitAttemptedAt ? <Instant iso={d.submitAttemptedAt} /> : "없음"}</li>
              <li>결과 불명: {d.submitUnknownAt ? <span className="badge warn">불명 <Instant iso={d.submitUnknownAt} /></span> : "없음"}</li>
              <li>판정한 계좌 토큰: {d.decidedAccountRef ?? "—"} · 전송한 계좌 토큰: {d.submittedAccountRef ?? "—"}
                {tokenMismatch && <span className="badge bad"> 토큰 불일치</span>}</li>
              <li>PSP 참조: {d.providerRef ?? "—"} · 멱등 키: <code>{d.idempotencyKey}</code></li>
              <li>분개: PAYOUT {d.entryId ?? "—"} · 결과 {d.settledEntryId ?? "—"}</li>
            </ul>
            <div className="inline-form">
              <button type="button" className="btn" aria-label={`지시[${d.instructionId}] 재전송`} disabled={m.isPending || !OPEN.has(d.status) || d.submitAttemptedAt === null}
                onClick={() => m.mutate(d.instructionId)}>재전송</button>
              <Link className="btn" aria-label={`지시[${d.instructionId}] PSP 결과`} to={`/dev/psp?instruction=${encodeURIComponent(d.instructionId)}`}>이 지시의 PSP 결과 지정</Link>
            </div>
            {(!OPEN.has(d.status) || d.submitAttemptedAt === null) && <p className="muted">재전송은 PSP에 보낸 적이 있는 PENDING·SUBMITTED 지시에만 가능합니다.</p>}
            {m.isSuccess && <p className="muted" role="status">재전송했습니다: PSP 결과 {m.data.providerStatus}, 지시 상태 {m.data.status}</p>}
            <ErrorPanel error={m.error} />
          </div>
        )}
      </Section>
      <Section title="webhook 이력">
        <DataTable<WebhookRow> rows={d?.webhooks ?? []} empty="webhook이 없습니다."
          columns={[
            { key: "providerEventId", label: "이벤트" }, { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
            { key: "receivedAt", label: "받음(UTC)", render: (r) => <Instant iso={r.receivedAt} /> },
            { key: "processedAt", label: "처리(UTC)", render: (r) => <Instant iso={r.processedAt} /> },
          ]} />
      </Section>
      <Section title="감사 기록">
        <DataTable<AuditRow> rows={d?.audit ?? []} empty="감사 기록이 없습니다."
          columns={[
            { key: "occurredAt", label: "시각(UTC)", render: (r) => <Instant iso={r.occurredAt} /> },
            { key: "action", label: "행위" }, { key: "actor", label: "행위자" },
            { key: "after", label: "내용", render: (r) => <code>{json(r.after)}</code> },
          ]} />
      </Section>
    </>
  );
}

import { useState } from "react";
import { Link } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import { useAll } from "../../api/all.ts";
import { createPayoutRun } from "../../api/payout.ts";
import { toIso } from "../../api/registry.ts";
import { toLocalInput } from "../../api/revenue.ts";
import type { ClockState, PayoutRunRow } from "../../api/types.ts";
import { INSTRUCTION_STATUSES, nextPayoutRunId } from "./logic.ts";

const SETTLE_ACTOR = "usr_settle";

export const countsText = (c: Record<string, number>) => INSTRUCTION_STATUSES.filter((s) => (c[s] ?? 0) > 0).map((s) => `${s} ${c[s]}`).join(", ") || "지시 없음";

function CreateForm({ now, taken }: { now: string; taken: string[] }) {
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const [asOfEdit, setAsOfEdit] = useState<string | null>(null);
  const asOf = asOfEdit === null ? now : toIso(asOfEdit);
  const payoutRunId = idEdit ?? nextPayoutRunId(asOf, taken);
  const m = useAction(createPayoutRun, ["payout-runs", "payout-instructions", "payout-profile", "ledger-accounts-all"]);
  return (
    <form className="form" onSubmit={(e) => {
      e.preventDefault();
      m.mutate({ payoutRunId: payoutRunId.trim(), asOf }, { onSuccess: () => { setIdEdit(null); } });
    }}>
      <label className="field"><span>지급 run id</span><input value={payoutRunId} onChange={(e) => setIdEdit(e.target.value)} required /></label>
      <label className="field"><span>기준 시각 asOf(UTC)</span>
        <input type="datetime-local" step={1} value={asOfEdit ?? toLocalInput(now)} onChange={(e) => setAsOfEdit(e.target.value)} required />
      </label>
      <button type="submit" className="btn primary" disabled={payoutRunId.trim() === "" || m.isPending}>지급 run 만들기</button>
      {m.isSuccess && <p className="muted" role="status">지급 run을 만들었습니다: <Link to={`/payout/runs/${encodeURIComponent(m.variables?.payoutRunId ?? "")}`}>{m.variables?.payoutRunId}</Link></p>}
      <ErrorPanel error={m.error} />
    </form>
  );
}

export function PayoutRuns() {
  const actor = useActor();
  const runs = useAll<PayoutRunRow>("payout-runs", "/payout-runs");
  const clock = useGet<ClockState>(["clock"], "/dev/clock");
  // 폼 기본값은 처음 읽은 시계 값(이후 시계가 움직여도 입력 중인 폼은 바뀌지 않는다).
  const [first, setFirst] = useState<string>();
  if (first === undefined && clock.data) setFirst(clock.data.now);
  return (
    <>
      <Section title="지급 실행 안내" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>지급 run 생성·조회는 정산 담당(SPACE_SETTLE)이 합니다. 현재 사용자: <strong>{actor}</strong></p>
        <p className="muted">직무 분리: 어떤 권리자의 계좌 토큰을 마지막으로 바꾼 사용자가 run을 실행하면 그 권리자의 지시는 ACCOUNT_SOD로 보류됩니다. 프로필은 usr_settle2로 등록하세요.</p>
      </Section>
      <Section title="지급 run 생성">
        <ErrorPanel error={clock.error} />
        {first ? <CreateForm now={first} taken={(runs.data ?? []).map((r) => r.payoutRunId)} /> : <p className="muted">가상 시계를 읽는 중…</p>}
      </Section>
      <Section title="지급 run 목록">
        <ErrorPanel error={runs.error} />
        <DataTable<PayoutRunRow> rows={runs.data ?? []} empty={runs.isPending ? "읽는 중…" : "지급 run이 없습니다."}
          columns={[
            { key: "payoutRunId", label: "run", render: (r) => <Link to={`/payout/runs/${encodeURIComponent(r.payoutRunId)}`}>{r.payoutRunId}</Link> },
            { key: "asOf", label: "기준 시각(UTC)", render: (r) => <Instant iso={r.asOf} /> },
            { key: "statusCounts", label: "지시 상태별", render: (r) => countsText(r.statusCounts) },
            { key: "createdBy", label: "실행자" },
            { key: "createdAt", label: "생성(UTC)", render: (r) => <Instant iso={r.createdAt} /> },
          ]} />
      </Section>
    </>
  );
}

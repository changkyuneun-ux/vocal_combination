import { useState } from "react";
import { Link, useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Digest } from "../../components/Digest.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Diagnostics } from "../../components/Diagnostics.tsx";
import { Money } from "../../components/Money.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import { requeueRun, voidRun } from "../../api/settlement.ts";
import type { RunDetailData, RunSums } from "../../api/types.ts";

const SETTLE_ACTOR = "usr_settle";
const MAX_REASON = 500;
const sumRows = (s: RunSums) => [
  { part: "정산(line_seq 1)", krw: s.settle }, { part: "역분개(line_seq 2 이상)", krw: s.reversal }, { part: "순합", krw: s.net },
];

export function RunDetail() {
  const { runId = "" } = useParams();
  const actor = useActor();
  const run = useGet<RunDetailData>(["run", runId], `/runs/${encodeURIComponent(runId)}`);
  const [reason, setReason] = useState("");
  const inv = ["run", "batch", "batches", "batch-runs"];
  const voidM = useAction(voidRun, inv);
  const requeueM = useAction(requeueRun, inv);
  const reasonOk = reason.length >= 1 && reason.length <= MAX_REASON;
  const cols = [
    { key: "part", label: "구분" },
    { key: "krw", label: "금액", render: (r: { krw: string }) => <Money krw={r.krw} /> },
  ];
  return (
    <>
      <Section title={`run ${runId}`}>
        <p><Link to="/settlement/batches">← 배치 목록</Link></p>
        <ErrorPanel error={run.error} />
        {run.data && (
          <dl className="kv">
            <dt>상태</dt><dd><StatusBadge status={run.data.status} /></dd>
            <dt>이벤트 digest</dt><dd>{run.data.eventsDigest ? <Digest value={run.data.eventsDigest} /> : "—"}</dd>
            <dt>결과 digest</dt><dd>{run.data.resultDigest ? <Digest value={run.data.resultDigest} /> : "—"}</dd>
          </dl>
        )}
        <p className="muted">진단은 해당 배치 상세의 run 표에 표시됩니다.</p>
      </Section>
      <Section title="배분 라인 합계">
        {run.data && <DataTable rows={sumRows(run.data.lines)} columns={cols} />}
      </Section>
      <Section title="보류 합계">
        {run.data && <DataTable rows={sumRows(run.data.holdings)} columns={cols} />}
      </Section>
      <Section title="운영 작업" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>무효화·재대기는 정산 담당(SPACE_SETTLE)이 합니다. 현재 사용자: <strong>{actor}</strong></p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); voidM.mutate({ runId, reason }); }}>
          <label className="field"><span>무효화 사유(1~{MAX_REASON}자)</span>
            <textarea value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <button type="submit" className="btn" aria-label={`run[${runId}] 무효화`} disabled={!reasonOk || voidM.isPending}>무효화</button>
          {voidM.isSuccess && <p className="muted" role="status">무효화했습니다.</p>}
          <ErrorPanel error={voidM.error} /><Diagnostics error={voidM.error} />
        </form>
        <div className="row-actions">
          <button type="button" className="btn" aria-label={`run[${runId}] 재대기`} disabled={requeueM.isPending} onClick={() => requeueM.mutate(runId)}>재대기</button>
        </div>
        {requeueM.isSuccess && <p className="muted" role="status">재대기했습니다.</p>}
        <ErrorPanel error={requeueM.error} /><Diagnostics error={requeueM.error} />
      </Section>
    </>
  );
}

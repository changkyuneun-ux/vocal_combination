import { useState } from "react";
import { Link, useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAll } from "../../api/all.ts";
import type { InstructionRow, PayoutRunRow } from "../../api/types.ts";
import { INSTRUCTION_STATUSES, openInstructions } from "./logic.ts";

const POLL_MS = 3000;
const SETTLE_ACTOR = "usr_settle";

export function PayoutRunDetail() {
  const { payoutRunId = "" } = useParams();
  const actor = useActor();
  const [status, setStatus] = useState("");
  const e = encodeURIComponent(payoutRunId);
  // 목록은 모든 상태를 받아 화면에서 거른다: 열린 지시(PENDING·SUBMITTED)가 있으면 3초마다 갱신.
  const all = useAll<InstructionRow>("payout-instructions", `/payout-runs/${e}/instructions`, {
    refetchInterval: (d) => (d !== undefined && openInstructions(d).length > 0 ? POLL_MS : false),
  });
  const runs = useAll<PayoutRunRow>("payout-runs", "/payout-runs");
  const run = runs.data?.find((r) => r.payoutRunId === payoutRunId);
  const rows = (all.data ?? []).filter((r) => status === "" || r.status === status);
  const counts = Object.fromEntries(INSTRUCTION_STATUSES.map((s) => [s, (all.data ?? []).filter((r) => r.status === s).length]));
  const open = openInstructions(all.data ?? []).length;
  return (
    <>
      <Section title={`지급 run ${payoutRunId}`} actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p><Link to="/payout/runs">← 지급 run 목록</Link></p>
        {run && <p>기준 시각 <Instant iso={run.asOf} /> · 실행자 {run.createdBy} · 생성 <Instant iso={run.createdAt} /></p>}
        <ul className="stack" aria-label="지시 상태별 건수">
          {INSTRUCTION_STATUSES.map((s) => <li key={s}><StatusBadge status={s} /> {counts[s]}</li>)}
        </ul>
        {open > 0 && <p className="muted" role="status">열린 지시 {open}건 — 3초마다 갱신합니다.</p>}
      </Section>
      <Section title="지시 표" actions={
        <label className="field"><span>상태 필터</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">전체</option>
            {INSTRUCTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      }>
        <ErrorPanel error={all.error} />
        <DataTable<InstructionRow> rows={rows} empty={all.isPending ? "읽는 중…" : "지시가 없습니다."}
          columns={[
            { key: "instructionId", label: "지시", render: (r) => <Link to={`/payout/instructions/${encodeURIComponent(r.instructionId)}`} aria-label={`지시[${r.instructionId}] 상세`}>{r.instructionId}</Link> },
            { key: "partyId", label: "권리자" },
            { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
            { key: "holdReason", label: "보류 사유", render: (r) => r.holdReason ?? "—" },
            { key: "grossKrw", label: "총액", render: (r) => <Money krw={r.grossKrw} /> },
            { key: "withholdingKrw", label: "원천세", render: (r) => <Money krw={r.withholdingKrw} /> },
            { key: "netKrw", label: "실지급", render: (r) => <Money krw={r.netKrw} /> },
          ]} />
      </Section>
    </>
  );
}

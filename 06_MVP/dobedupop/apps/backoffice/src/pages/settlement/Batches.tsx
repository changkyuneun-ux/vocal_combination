import { useState } from "react";
import { sessionMode } from "../../api/client.ts";
import { Link } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Pager } from "../../components/Pager.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useList } from "../../api/hooks.ts";
import { editedOr, useClock } from "../../api/clock.ts";
import { createBatch } from "../../api/settlement.ts";
import { toIso } from "../../api/registry.ts";
import { toLocalInput } from "../../api/revenue.ts";
import type { BatchRow, RunStatus } from "../../api/types.ts";
import { defaultPeriod, nextBatchId } from "./logic.ts";

export const RUN_STATUSES: RunStatus[] = ["PENDING", "CALCULATED", "VERIFIED", "FAILED", "VOIDED", "CONFIRMED"];
const OPS_ACTOR = "usr_ops";

function CreateForm({ now, taken }: { now: string; taken: string[] }) {
  const def = defaultPeriod(now);
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const [startEdit, setStart] = useState<string | null>(null);
  const [endEdit, setEnd] = useState<string | null>(null);
  const start = editedOr(startEdit, toLocalInput(def.start));
  const end = editedOr(endEdit, toLocalInput(def.end));
  const batchId = idEdit ?? nextBatchId(toIso(start) || def.start, taken);
  const m = useAction(createBatch, ["batches"]);
  const ok = batchId.trim() !== "" && start !== "" && end !== "";
  return (
    <form className="form" onSubmit={(e) => {
      e.preventDefault();
      m.mutate({ batchId: batchId.trim(), periodStart: toIso(start), periodEnd: toIso(end) }, { onSuccess: () => setIdEdit(null) });
    }}>
      <label className="field"><span>배치 id</span><input value={batchId} onChange={(e) => setIdEdit(e.target.value)} required /></label>
      <label className="field"><span>기간 시작(UTC)</span><input type="datetime-local" step={1} value={start} onChange={(e) => setStart(e.target.value)} required /></label>
      <label className="field"><span>기간 끝(UTC)</span><input type="datetime-local" step={1} value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
      <button type="submit" className="btn primary" disabled={!ok || m.isPending}>배치 만들기</button>
      {m.isSuccess && <p className="muted" role="status">배치를 만들었습니다: {m.variables?.batchId}</p>}
      <ErrorPanel error={m.error} />
    </form>
  );
}

export function Batches() {
  const actor = useActor();
  const [status, setStatus] = useState("");
  const list = useList<BatchRow>("batches", "/batches", { status });
  const all = useList<BatchRow>("batches", "/batches", undefined);
  const clock = useClock();
  const first = clock.data?.now;
  return (
    <>
      <Section title="배치 목록" actions={
        <label className="field"><span>상태 필터</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">전체</option><option value="OPEN">OPEN</option><option value="CONFIRMED">CONFIRMED</option>
          </select>
        </label>
      }>
        <ErrorPanel error={list.error} />
        <DataTable<BatchRow> rows={list.pages} empty="배치가 없습니다."
          columns={[
            { key: "batchId", label: "배치", render: (r) => <Link to={`/settlement/batches/${encodeURIComponent(r.batchId)}`}>{r.batchId}</Link> },
            { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
            { key: "periodStart", label: "기간 시작(UTC)", render: (r) => <Instant iso={r.periodStart} /> },
            { key: "periodEnd", label: "기간 끝(UTC)", render: (r) => <Instant iso={r.periodEnd} /> },
            { key: "runCounts", label: "run 상태별", render: (r) => RUN_STATUSES.filter((s) => r.runCounts[s] > 0).map((s) => `${s} ${r.runCounts[s]}`).join(", ") || "—" },
            { key: "executedBy", label: "생성자" },
            { key: "createdAt", label: "생성(UTC)", render: (r) => <Instant iso={r.createdAt} /> },
          ]} />
        <Pager next={list.next} loadMore={list.loadMore} />
      </Section>
      <Section title="배치 생성" actions={!sessionMode && <button type="button" className="btn primary" disabled={actor === OPS_ACTOR} onClick={() => setActor(OPS_ACTOR)}>usr_ops로 전환</button>}>
        <p>배치 생성은 정산 운영(SPACE_OPS, usr_ops)이 합니다. 현재 사용자: <strong>{actor}</strong>. 기본 기간은 가상 시계 기준 지난달 1일 ~ 이번 달 1일(UTC)입니다.</p>
        {first === undefined
          ? (clock.error ? <ErrorPanel error={clock.error} /> : <p className="muted">가상 시계를 읽는 중…</p>)
          : <CreateForm now={first} taken={all.pages.map((b) => b.batchId)} />}
      </Section>
    </>
  );
}

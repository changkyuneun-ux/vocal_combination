import { useState } from "react";
import { Link, useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Digest } from "../../components/Digest.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import { confirmBatch } from "../../api/settlement.ts";
import { postedRunCount, settlementEntriesPath } from "../../api/ledger.ts";
import type { Paged } from "../../api/client.ts";
import type { BatchRow, BatchRunRow, BatchView, EntryRow } from "../../api/types.ts";
import { RUN_STATUSES } from "./Batches.tsx";
import { canConfirm } from "./logic.ts";

const POLL_MS = 3000;
const SETTLE_ACTOR = "usr_settle";
const isActive = (v: BatchView | undefined) => v?.runs.some((r) => r.status === "PENDING" || r.status === "CALCULATED") ?? false;

function CountBars({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  if (total === 0) return <p className="muted">run이 없습니다.</p>;
  return (
    <ul className="stack" aria-label="run 상태별 건수">
      {RUN_STATUSES.map((s) => { const n = counts[s] ?? 0; return (
        <li key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 96 }}>{s}</span>
          <span aria-hidden="true" style={{ display: "inline-block", height: 10, width: `${(n / total) * 240}px`, background: "var(--accent, #4a6cf7)", minWidth: n > 0 ? 2 : 0 }} />
          <span>{n}</span>
        </li>
      ); })}
    </ul>
  );
}

export function BatchDetail() {
  const { batchId = "" } = useParams();
  const actor = useActor();
  const [status, setStatus] = useState("");
  const e = encodeURIComponent(batchId);
  const view = useGet<BatchView>(["batch", batchId], `/batches/${e}`, { refetchInterval: (d) => (isActive(d) ? POLL_MS : false) });
  const active = isActive(view.data);
  const runs = useGet<Paged<BatchRunRow>>(["batch-runs", batchId, status], `/batches/${e}/runs?limit=200${status ? `&status=${status}` : ""}`, { refetchInterval: active ? POLL_MS : false });
  // 다이제스트·기간은 목록 응답에 있다(상태가 같은 배치만 가져온다).
  const meta = useGet<Paged<BatchRow>>(["batch-meta", batchId, view.data?.status ?? ""], `/batches?limit=200&status=${view.data?.status ?? ""}`, { enabled: view.data !== undefined });
  const row = meta.data?.items.find((b) => b.batchId === batchId);
  const lookupMissing = meta.data !== undefined && row === undefined;
  const confirmed = view.data?.status === "CONFIRMED";
  const confirmedIds = (view.data?.runs ?? []).filter((r) => r.status === "CONFIRMED").map((r) => r.runId);
  const entries = useGet<Paged<EntryRow>>(["batch-ledger", batchId], settlementEntriesPath, { enabled: confirmed, refetchInterval: (d) => (confirmed && d !== undefined && postedRunCount(d, confirmedIds) < confirmedIds.length ? POLL_MS : false) });
  const posted = postedRunCount(entries.data, confirmedIds);
  const check = view.data ? canConfirm(view.data.status, view.data.runs.map((r) => ({ runId: r.runId, status: r.status }))) : { ok: false as const, reason: "배치를 읽는 중입니다" };
  const m = useAction(confirmBatch, ["batch", "batches", "batch-runs", "batch-meta", "batch-ledger"]);
  const counts = Object.fromEntries(RUN_STATUSES.map((s) => [s, (view.data?.runs ?? []).filter((r) => r.status === s).length]));
  return (
    <>
      <Section title={`배치 ${batchId}`}>
        <p><Link to="/settlement/batches">← 배치 목록</Link></p>
        <ErrorPanel error={view.error} />
        <ErrorPanel error={meta.error} />
        {view.data && (
          <dl className="kv">
            <dt>상태</dt><dd><StatusBadge status={view.data.status} /> <span className="muted">진행: {view.data.progress}</span></dd>
            <dt>manifest digest</dt><dd>{row?.batchManifestDigest ? <Digest value={row.batchManifestDigest} label="manifest" /> : <span className="muted">{lookupMissing ? "목록 조회 범위 밖" : "—"}</span>}</dd>
            <dt>기간(UTC)</dt><dd>{row ? <><Instant iso={row.periodStart} /> ~ <Instant iso={row.periodEnd} /></> : lookupMissing ? "목록 조회 범위 밖" : "—"}</dd>
            <dt>확정</dt><dd>{row?.confirmedBy ? <>{row.confirmedBy} <Instant iso={row.confirmedAt} /></> : lookupMissing ? "목록 조회 범위 밖" : "—"}</dd>
          </dl>
        )}
        {active && <p className="muted" role="status">정산 진행 중 — {POLL_MS / 1000}초마다 자동 갱신합니다.</p>}
      </Section>
      <Section title="run 상태별 건수"><CountBars counts={counts} /></Section>
      <Section title="배치 확정" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>확정은 정산 담당(SPACE_SETTLE, usr_settle)이 하며 배치 생성자와 달라야 합니다. 현재 사용자: <strong>{actor}</strong></p>
        <button type="button" className="btn primary" disabled={!check.ok || m.isPending} onClick={() => m.mutate(batchId)}>확정</button>
        {!check.ok && <p className="muted" role="status">확정할 수 없음: {check.reason}</p>}
        {m.isSuccess && <p className="muted" role="status">확정했습니다. manifest <Digest value={m.data.manifestDigest} label="확정 manifest" /></p>}
        <ErrorPanel error={m.error} />
        {confirmed && (
          <p role="status">원장 반영: {posted} / {confirmedIds.length} run{posted === confirmedIds.length ? " (완료)" : " (진행 중)"}</p>
        )}
        {confirmed && <ErrorPanel error={entries.error} />}
      </Section>
      <Section title="run 목록" actions={
        <label className="field"><span>run 상태 필터</span>
          <select value={status} onChange={(ev) => setStatus(ev.target.value)}>
            <option value="">전체</option>{RUN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      }>
        <ErrorPanel error={runs.error} />
        <DataTable<BatchRunRow> rows={runs.data?.items ?? []} empty="run이 없습니다."
          columns={[
            { key: "runId", label: "run", render: (r) => <Link to={`/settlement/runs/${encodeURIComponent(r.runId)}`}>{r.runId}</Link> },
            { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
            { key: "snapshotId", label: "봉인" }, { key: "eventCount", label: "이벤트 수" },
            { key: "resultDigest", label: "결과 digest", render: (r) => r.resultDigest ? <Digest value={r.resultDigest} label={`${r.runId} 결과`} /> : "—" },
            { key: "diagnostics", label: "진단", render: (r) => <details><summary aria-label={`진단[${r.runId}] 보기`}>보기</summary><pre>{JSON.stringify(r.diagnostics, null, 2)}</pre></details> },
            { key: "verifiedBy", label: "검증자", render: (r) => r.verifiedBy ?? "—" },
            { key: "createdAt", label: "생성(UTC)", render: (r) => <Instant iso={r.createdAt} /> },
          ]} />
        {runs.data?.next && <p className="muted">run이 200건을 넘어 일부만 보입니다.</p>}
      </Section>
      <Section title="건너뛴 이벤트">
        <DataTable rows={view.data?.skipped ?? []} empty="건너뛴 이벤트가 없습니다."
          columns={[{ key: "eventId", label: "이벤트" }, { key: "reason", label: "사유" }]} />
      </Section>
    </>
  );
}

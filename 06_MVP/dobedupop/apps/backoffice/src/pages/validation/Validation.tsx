import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { currentApp } from "../../app/apps.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { ScopeSelect, useScopeParam } from "../../components/ScopeSelect.tsx";
import { Section } from "../../components/Section.tsx";

type Issue = {
  issueId: number; rule: string; severity: "BLOCK" | "WARN" | "INFO"; scopeId: string; subjectType: string; subjectId: string; message: string; hint: string;
  status: string; openedAt: string; dueAt: string | null; closedAt: string | null; acceptRequestedBy?: string; acceptReason?: string; acceptedBy?: string; acceptUntil?: string; acceptCount: number;
};
type Check = { scopeId: string; enforced: boolean; checkedAt: string; counts: { block: number; warn: number; accepted: number }; issues: Issue[] };
const SEV: Record<string, [string, string]> = { BLOCK: ["차단", "bad"], WARN: ["경고", "warn"], INFO: ["참고", "muted"] };
const STATUS: Record<string, string> = { OPEN: "열림", RESOLVED: "해결됨(재검사)", ACCEPTED: "위험 수용", DISMISSED: "오탐 처리" };

function Actions({ i, reason, onDone }: { i: Issue; reason: string; onDone: (e: ApiError | null) => void }) {
  if (currentApp() !== "ops" || (i.status !== "OPEN" && i.status !== "ACCEPTED")) return null;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onDone(null); } catch (e) { onDone(e as ApiError); } };
  return <>
    {i.severity === "WARN" && <button type="button" className="btn tiny" disabled={reason.trim() === ""}
      onClick={() => void act(() => api("POST", `/validation-issues/${i.issueId}/acceptance-request`, { reason }))}>위험 수용 요청</button>}
    {i.acceptRequestedBy && !i.acceptedBy && <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/validation-issues/${i.issueId}/accept`))}>수용 승인</button>}
    <button type="button" className="btn tiny" disabled={reason.trim() === ""} onClick={() => void act(() => api("POST", `/validation-issues/${i.issueId}/dismiss`, { reason }))}>오탐 처리</button>
  </>;
}

const columns = (reason: string, done: (e: ApiError | null) => void) => [
  { key: "severity", label: "등급", render: (i: Issue) => <span className={`badge ${SEV[i.severity]?.[1]}`}>{SEV[i.severity]?.[0]}</span> },
  { key: "rule", label: "규칙", render: (i: Issue) => <code>{i.rule}</code> },
  { key: "message", label: "문제", render: (i: Issue) => <>{i.message}<div className="muted small">고치는 법: {i.hint}</div></> },
  { key: "status", label: "상태", render: (i: Issue) => <>{STATUS[i.status] ?? i.status}{i.acceptRequestedBy && !i.acceptedBy && <div className="muted small">수용 요청: {i.acceptReason}</div>}</> },
  { key: "dueAt", label: "기한", render: (i: Issue) => (i.acceptUntil ? <>수용 <Instant iso={i.acceptUntil} /></> : i.dueAt ? <Instant iso={i.dueAt} /> : "—") },
  { key: "act", label: "", render: (i: Issue) => <Actions i={i} reason={reason} onDone={done} /> },
];

/**
 * 정합성 점검(원천 문서 설계 S3a): 곡마다 빠진 근거·문서와 기록의 불일치를 보여 준다. 고치면 다시 검사할 때 시스템이 닫는다.
 * 차단(BLOCK)이 열려 있으면 정책·팩을 활성화할 수 없다(적용 테넌트). 운영은 전체 이슈 큐에서 경고의 위험 수용을 요청하고, 컴플라이언스가 승인한다.
 */
export function ValidationPage() {
  const [scope, setScope] = useScopeParam();
  const check = useGet<Check>(["validation", scope], `/scopes/${encodeURIComponent(scope)}/validation`, { enabled: scope !== "" });
  const queue = useGet<Issue[]>(["validation-issues"], "/validation-issues?status=OPEN", { enabled: currentApp() === "ops" });
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [swept, setSwept] = useState<number | null>(null);
  const sweep = async () => {
    try { setSwept((await api<{ checked: string[] }>("POST", "/validation/sweep")).checked.length); done(null); } catch (e) { setErr(e as ApiError); }
  };
  const done = (e: ApiError | null) => { setErr(e); void check.refetch(); void queue.refetch(); };
  const c = check.data;
  return (
    <>
      <Section title="정합성 점검">
        <ScopeSelect scope={scope} onChange={setScope} />
        <ErrorPanel error={check.error ?? err} />
        {c && <>
          <p aria-label="점검 요약">
            <span className={`badge ${c.counts.block > 0 ? "bad" : "ok"}`}>차단 {c.counts.block}</span>{" "}
            <span className={`badge ${c.counts.warn > 0 ? "warn" : "ok"}`}>경고 {c.counts.warn}</span>{" "}
            <span className="badge muted">위험 수용 {c.counts.accepted}</span>{" "}
            <span className="muted small">{c.enforced ? "차단 이슈가 있으면 활성화를 막는다" : "이 테넌트는 경고만 남긴다(활성화를 막지 않음)"} · 검사 <Instant iso={c.checkedAt} /></span>
          </p>
          {currentApp() === "ops" && <label className="field"><span>사유(위험 수용 요청·오탐 처리)</span><input aria-label="처리 사유" value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
          <DataTable rows={c.issues} empty="문제가 없습니다." columns={columns(reason, done)} />
        </>}
      </Section>
      {currentApp() === "ops" && (
        <Section title="전체 이슈 큐(열림)" actions={<button type="button" className="btn tiny" onClick={() => void sweep()}>정기 검사 지금 실행</button>}>
          <p className="muted small">서버는 매시간 정기 검사를 돌린다: 하루 넘게 검사하지 않은 곡, 마지막 검사 뒤 기한·문서 만료가 지난 곡만 다시 본다. 문서를 개정·거부하면 그 문서가 닿는 곡은 바로 다시 검사한다.</p>
          {swept !== null && <p role="status">정기 검사: 곡 {swept}개를 다시 검사했습니다.</p>}
          <ErrorPanel error={queue.error} />
          <DataTable rows={queue.data ?? []} empty="열린 이슈가 없습니다." columns={[{ key: "scopeId", label: "곡", render: (i: Issue) => <code>{i.scopeId}</code> }, ...columns(reason, done)]} />
        </Section>
      )}
    </>
  );
}

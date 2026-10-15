import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { currentApp } from "../../app/apps.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

type Request = {
  requestId: number; recordType: "CLAIM" | "MANDATE"; recordId: string; recordVersion: number; factsScopeId: string; counterpartyId: string;
  requestedBy: string; requestedAt: string; dueAt: string; status: string; decidedAt?: string; decidedBy?: string; reason?: string; disputeId?: string;
};
const STATUS: Record<string, [string, string]> = {
  OPEN: ["확인 대기", "warn"], CONFIRMED: ["확인됨", "ok"], DECLINED: ["거절(분쟁)", "bad"], PLATFORM_VERIFIED: ["플랫폼 대조 확인", "ok"], SUPERSEDED: ["기록이 바뀜", "muted"],
};

/**
 * 권리 기록 확인(원천 문서 설계 S3, 결정 D5): 지분·권리자 지정·위임은 상대 당사자가 확인해야 VERIFIED가 된다.
 * 상대는 확인·거절(거절하면 분쟁)하고, 상대가 플랫폼 밖이면 기한(14일) 뒤 운영이 원문을 대조해 확인한다.
 */
export function ConfirmationsPage() {
  const [status, setStatus] = useState("OPEN");
  const q = useGet<Request[]>(["confirmations", status], `/confirmations${status ? `?status=${status}` : ""}`);
  const [reason, setReason] = useState("");
  const [ask, setAsk] = useState({ recordType: "CLAIM", recordId: "" });
  const [err, setErr] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); } };
  return (
    <>
      <Section title="권리 기록 확인 요청">
        <p className="muted">지분·권리자 지정·위임처럼 돈의 흐름을 바꾸는 기록은 상대 당사자가 확인해야 확정(VERIFIED)되고, 그 전에는 정산에 들어가지 않는다.</p>
        <div className="inline-form">
          <select aria-label="요청 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="OPEN">확인 대기</option><option value="">전체</option>
          </select>
          <input aria-label="사유" placeholder="거절·플랫폼 확인 사유" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ErrorPanel error={q.error ?? err} />
        <DataTable rows={q.data ?? []} empty="확인 요청이 없습니다." columns={[
          { key: "record", label: "기록", render: (r) => <code>{r.recordType} {r.recordId} v{r.recordVersion}</code> },
          { key: "counterpartyId", label: "상대 당사자" },
          { key: "requestedBy", label: "요청자" },
          { key: "dueAt", label: "기한", render: (r) => <Instant iso={r.dueAt} /> },
          { key: "status", label: "상태", render: (r) => <span className={`badge ${STATUS[r.status]?.[1] ?? "muted"}`}>{STATUS[r.status]?.[0] ?? r.status}</span> },
          { key: "act", label: "", render: (r) => (r.status !== "OPEN" ? (r.disputeId ? <code>{r.disputeId}</code> : null) : <>
            <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/confirmations/${r.requestId}/confirm`))}>확인</button>
            <button type="button" className="btn tiny" disabled={reason.trim() === ""} onClick={() => void act(() => api("POST", `/confirmations/${r.requestId}/decline`, { reason }))}>거절</button>
            {currentApp() === "ops" && <button type="button" className="btn tiny" disabled={reason.trim() === ""}
              onClick={() => void act(() => api("POST", `/confirmations/${r.requestId}/platform-verify`, { reason }))}>플랫폼 확인</button>}
          </>) },
        ]} />
      </Section>
      <Section title="확인 다시 요청">
        <p className="muted">ASSERTED로 등록하면 요청이 자동으로 간다. 기록이 바뀌어 요청이 무효가 되었으면 여기서 다시 요청한다.</p>
        <div className="inline-form">
          <select aria-label="요청할 기록 종류" value={ask.recordType} onChange={(e) => setAsk({ ...ask, recordType: e.target.value })}>
            <option value="CLAIM">권리 주장</option><option value="MANDATE">위임</option>
          </select>
          <input aria-label="요청할 기록 id" value={ask.recordId} onChange={(e) => setAsk({ ...ask, recordId: e.target.value })} />
          <button type="button" className="btn" disabled={ask.recordId === ""} onClick={() => void act(() => api("POST", "/confirmations", ask))}>확인 요청</button>
        </div>
      </Section>
    </>
  );
}

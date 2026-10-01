import { useState } from "react";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { RegisterForm } from "../../components/RegisterForm.tsx";
import { useAction, useList } from "../../api/hooks.ts";
import { compact, opts, post } from "../../api/registry.ts";
import type { Dispute } from "../../api/types.ts";

function CloseButton({ d }: { d: Dispute }) {
  const [share, setShare] = useState("");
  const [target, setTarget] = useState("");
  const m = useAction<void, unknown>(() => {
    const resolution = compact({ shareBps: share === "" ? "" : Number(share), targetId: target });
    return post(`/disputes/${encodeURIComponent(d.disputeId)}/close`, Object.keys(resolution).length ? { resolution } : {});
  }, ["disputes", "facts", "scope"]);
  return (
    <div className="stack">
      <div className="row-actions">
        <input aria-label={`${d.disputeId} 해결 지분(bps)`} type="number" placeholder="지분(bps)" value={share} onChange={(e) => setShare(e.target.value)} size={8} />
        <input aria-label={`${d.disputeId} 해결 대상 id`} placeholder="대상 id" value={target} onChange={(e) => setTarget(e.target.value)} size={12} />
        <button type="button" className="btn" aria-label={`${d.disputeId} 종결`} disabled={m.isPending} onClick={() => m.mutate()}>종결</button>
      </div>
      <ErrorPanel error={m.error} />
    </div>
  );
}

export function Disputes() {
  const [status, setStatus] = useState("");
  const [scope, setScope] = useState("");
  const list = useList<Dispute>("disputes", "/disputes", { status, scope });
  return (
    <>
      <Section title="분쟁 목록">
        <div className="inline-form">
          <label className="field"><span>상태 필터</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">전체</option><option value="OPEN">OPEN</option><option value="CLOSED">CLOSED</option>
            </select>
          </label>
          <label className="field"><span>범위 필터</span><input value={scope} onChange={(e) => setScope(e.target.value)} /></label>
        </div>
        <ErrorPanel error={list.error} />
        <DataTable<Dispute> rows={list.pages} empty="분쟁이 없습니다."
          columns={[
            { key: "disputeId", label: "분쟁 id" }, { key: "targetType", label: "대상 종류" }, { key: "targetId", label: "대상 id" }, { key: "factsScopeId", label: "범위" },
            { key: "disputeReason", label: "사유" }, { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
            { key: "openedAt", label: "개시", render: (r) => <Instant iso={r.openedAt} /> }, { key: "closedAt", label: "종결", render: (r) => <Instant iso={r.closedAt} /> },
            { key: "act", label: "종결 처리", render: (r) => (r.status === "OPEN" ? <CloseButton d={r} /> : <span className="muted">—</span>) },
          ]} />
        <Pager next={list.next} loadMore={list.loadMore} />
      </Section>
      <Section title="분쟁 개시">
        <RegisterForm path="/disputes" submitLabel="분쟁 개시" invalidate={["disputes", "facts", "scope"]}
          fields={[
            { name: "disputeId", label: "분쟁 id", type: "text", required: true },
            { name: "targetType", label: "대상 종류", type: "select", required: true, options: opts(["RIGHT_CLAIM", "MANDATE"]) },
            { name: "targetId", label: "대상 id", type: "text", required: true },
            { name: "reason", label: "사유", type: "text", required: true },
          ]}
          toBody={compact} />
      </Section>
    </>
  );
}

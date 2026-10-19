import { useState } from "react";
import { api } from "../../api/client.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import type { BreakGlassRow, InspectionRow, TenantRow } from "../../api/types.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

const INSPECTION_COLUMNS = [
  { key: "occurredAt", label: "시각", render: (r: InspectionRow) => <Instant iso={r.occurredAt} /> },
  { key: "actor", label: "열람자" },
  { key: "targetTenantId", label: "대상 테넌트" },
  { key: "node", label: "대상", render: (r: InspectionRow) => <code>{r.nodeType}:{r.nodeId}</code> },
  { key: "panel", label: "패널" },
  { key: "pii", label: "개인정보 해제", render: (r: InspectionRow) => (r.piiUnmasked ? <span className="badge warn">해제 · {r.reason}</span> : "—") },
  { key: "bg", label: "break-glass", render: (r: InspectionRow) => r.breakGlassId ?? "—" },
];

function bgColumns(onEnd?: (id: number) => void) {
  return [
    { key: "breakGlassId", label: "번호" },
    { key: "userId", label: "운영자" },
    { key: "targetTenantId", label: "대상 테넌트" },
    { key: "reason", label: "사유" },
    { key: "window", label: "기간", render: (r: BreakGlassRow) => <><Instant iso={r.startedAt} /> ~ <Instant iso={r.endedAt ?? r.expiresAt} /></> },
    { key: "state", label: "상태", render: (r: BreakGlassRow) => (r.endedAt ? "종료" : <>열림{onEnd && <button type="button" className="btn tiny" onClick={() => onEnd(r.breakGlassId)}>종료</button>}</>) },
  ];
}

/**
 * 운영 백오피스의 조회 통제(다음 작업 7): 다른 테넌트 레코드 열람 기록, 개인정보 마스킹 해제 기록, break-glass.
 * break-glass는 플랫폼이 테넌트 소유 권리 데이터를 바꿔야 할 때만 연다(대상 테넌트·사유·최대 60분, 열려 있는 동안의 쓰기는 그 테넌트 소유가 된다).
 */
export function OpsControl() {
  const tenants = useGet<TenantRow[]>(["tenants"], "/tenants");
  const list = useGet<InspectionRow[]>(["inspections"], "/inspections");
  const bgs = useGet<BreakGlassRow[]>(["break-glass"], "/break-glass");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(30);
  const start = useAction(() => api("POST", "/break-glass", { targetTenantId: target, reason, minutes }), ["break-glass"]);
  const end = useAction((id: number) => api("POST", `/break-glass/${id}/end`, {}), ["break-glass"]);
  const rightsHolders = (tenants.data ?? []).filter((t) => t.tenantType !== "PLATFORM_OPS" && t.tenantType !== "PLATFORM_DEFAULT"); // 권리 테넌트·참여 기관
  return (
    <>
      <Section title="break-glass(테넌트 데이터 쓰기 권한)">
        <form className="form" onSubmit={(e) => { e.preventDefault(); start.mutate(undefined); }}>
          <label className="field"><span>대상 테넌트</span>
            <select aria-label="break-glass 대상 테넌트" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">선택</option>
              {rightsHolders.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.name} ({t.tenantId})</option>)}
            </select>
          </label>
          <label className="field"><span>사유(테넌트에게 보임)</span><input aria-label="break-glass 사유" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="field"><span>분(1~60)</span><input type="number" min={1} max={60} aria-label="break-glass 분" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
          <button type="submit" className="btn primary" disabled={target === "" || reason.trim() === "" || start.isPending}>열기</button>
          <ErrorPanel error={start.error ?? end.error} />
        </form>
        <ErrorPanel error={bgs.error} />
        <DataTable rows={bgs.data ?? []} empty="break-glass 기록이 없습니다." columns={bgColumns((id) => end.mutate(id))} />
      </Section>
      <Section title="열람 기록(다른 테넌트 레코드 상세·개인정보 해제)">
        <ErrorPanel error={list.error} />
        <DataTable rows={list.data ?? []} empty="열람 기록이 없습니다." columns={INSPECTION_COLUMNS} />
      </Section>
    </>
  );
}

/** 권리자 포털: 플랫폼이 우리 테넌트 데이터를 언제 무엇을 봤는지, break-glass를 언제 왜 열었는지(투명성). */
export function PortalTransparency() {
  const list = useGet<InspectionRow[]>(["inspections"], "/inspections");
  const bgs = useGet<BreakGlassRow[]>(["break-glass"], "/break-glass");
  return (
    <>
      <Section title="플랫폼 break-glass">
        <ErrorPanel error={bgs.error} />
        <DataTable rows={bgs.data ?? []} empty="플랫폼이 우리 데이터에 쓰기 권한을 연 적이 없습니다." columns={bgColumns()} />
      </Section>
      <Section title="플랫폼 열람 기록">
        <ErrorPanel error={list.error} />
        <DataTable rows={list.data ?? []} empty="플랫폼 열람 기록이 없습니다." columns={INSPECTION_COLUMNS} />
      </Section>
    </>
  );
}

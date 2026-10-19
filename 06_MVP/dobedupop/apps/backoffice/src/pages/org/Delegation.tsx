import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

type Delegation = { tenantId: string; tasks: string[]; available: string[]; log: { auditId: number; occurredAt: string; actor: string; action: string; entityType: string; entityId: string }[] };
const TASK_LABEL: Record<string, string> = { RIGHTS_ENTRY: "권리 데이터·원천 문서 등록 대행(곡·녹음·슬롯·스템·보이스·권리 주장)" };

/**
 * 위임 대행(테넌트 정책 TR5·TN6): 조직 관리자가 플랫폼에 맡길 업무를 정하고, 플랫폼이 대신 한 일을 본다.
 * 정책 편집·승인·활성화·발행은 위임할 수 없다(플랫폼은 권리를 결정하지 않는다).
 */
export function DelegationPanel({ tenantId, editable }: { tenantId: string; editable: boolean }) {
  const q = useGet<Delegation>(["delegation", tenantId], `/tenants/${tenantId}/delegation`);
  const [err, setErr] = useState<ApiError | null>(null);
  const set = async (tasks: string[]) => { try { await api("PUT", `/tenants/${tenantId}/delegation`, { tasks }); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); } };
  const d = q.data;
  return (
    <>
      <ErrorPanel error={q.error ?? err} />
      {d && (
        <>
          <ul className="plain">
            {d.available.map((t) => (
              <li key={t}><label className="check">
                <input type="checkbox" disabled={!editable} checked={d.tasks.includes(t)} onChange={(e) => void set(e.target.checked ? [...d.tasks, t] : d.tasks.filter((x) => x !== t))} />
                {TASK_LABEL[t] ?? t}
              </label></li>
            ))}
          </ul>
          <p className="muted small">{d.tasks.length === 0 ? "맡긴 업무가 없습니다. 플랫폼은 이 조직의 권리 데이터를 대신 등록할 수 없습니다." : "플랫폼 온보딩 담당이 권리자 포털에서 이 조직 권한으로 대행합니다. 대행한 요청은 아래 기록에 남습니다."}</p>
          <h3 style={{ margin: "12px 0 6px" }}>대행 기록</h3>
          <DataTable rows={d.log} empty="대행 기록이 없습니다." columns={[
            { key: "at", label: "시각", render: (r) => <Instant iso={r.occurredAt} /> },
            { key: "actor", label: "담당", render: (r) => <code>{r.actor}</code> },
            { key: "action", label: "작업", render: (r) => <>{r.action} <span className="muted small">{r.entityId}</span></> },
          ]} />
        </>
      )}
    </>
  );
}

export function DelegationPage() {
  const me = useGet<{ tenantId: string; roles: string[] }>(["me"], "/me");
  if (!me.data) return <Section title="위임 대행"><ErrorPanel error={me.error} /></Section>;
  return <Section title="위임 대행"><DelegationPanel tenantId={me.data.tenantId} editable={me.data.roles.includes("TENANT_ADMIN")} /></Section>;
}

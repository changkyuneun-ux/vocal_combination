import { useGet } from "../../api/hooks.ts";
import { loginState, ROLE_LABEL, TENANT_TYPE_LABEL, type AccountRow, type TenantRow } from "../../api/admin.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

type Me = { userId: string; displayName: string; roles: string[]; tenantId: string; scope: string };
type MyParty = { partyId: string; partyType: string; displayName: string };

/** 권리자 포털 첫 화면: 내 테넌트, 소속 당사자(정산 금액이 귀속되는 권리자), 테넌트 계정(계정 발급·역할 변경은 플랫폼 운영이 한다). */
export function PortalHome() {
  const me = useGet<Me>(["me"], "/me");
  const tenants = useGet<TenantRow[]>(["tenants"], "/tenants");
  const parties = useGet<MyParty[]>(["my-parties"], "/my/parties");
  const users = useGet<{ items: AccountRow[] }>(["users", "mine"], "/users?limit=200");
  const t = tenants.data?.find((x) => x.tenantId === me.data?.tenantId);
  return (
    <>
      <Section title={t ? t.name : "내 테넌트"}>
        {me.error ? <ErrorPanel error={me.error} /> : me.data && (
          <dl className="kv">
            <dt>로그인</dt><dd>{me.data.displayName} <span className="muted">({me.data.userId})</span></dd>
            <dt>내 역할</dt><dd>{me.data.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") || "없음"}</dd>
            <dt>테넌트</dt><dd><code>{me.data.tenantId}</code>{t && <> · {TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType}</>}</dd>
            <dt>볼 수 있는 범위</dt><dd>{me.data.scope === "platform" ? "플랫폼(전체)" : "우리 테넌트가 등록한 데이터와 우리 당사자가 참여한 정산만"}</dd>
          </dl>
        )}
      </Section>
      <Section title="소속 당사자">
        <p className="muted">정산 금액은 당사자(권리 주체)에 귀속된다. 우리 테넌트의 당사자 명세는 "명세서"에서 본다.</p>
        {parties.error ? <ErrorPanel error={parties.error} /> : (
          <DataTable rows={parties.data ?? []} empty="이 테넌트에 소속된 당사자가 없습니다."
            columns={[{ key: "displayName", label: "이름", render: (r) => <><strong>{r.displayName}</strong><div className="muted small"><code>{r.partyId}</code></div></> }, { key: "partyType", label: "유형" }]} />
        )}
      </Section>
      <Section title="우리 테넌트 계정">
        <p className="muted">계정 발급·역할 변경·잠금은 플랫폼 운영에 요청한다. 정책 편집·승인·활성화는 서로 다른 사람이 맡는다.</p>
        {users.error ? <ErrorPanel error={users.error} /> : (
          <DataTable<AccountRow> rows={users.data?.items ?? []} empty="계정이 없습니다." columns={[
            { key: "name", label: "계정", render: (a) => <><strong>{a.displayName}</strong><div className="muted small"><code>{a.userId}</code></div></> },
            { key: "roles", label: "역할", render: (a) => a.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") || "—" },
            { key: "login", label: "로그인", render: (a) => { const s = loginState(a); return <span className={`badge ${s.tone}`}>{s.text}</span>; } },
            { key: "last", label: "마지막 로그인", render: (a) => (a.lastLoginAt ? <Instant iso={a.lastLoginAt} /> : <span className="muted">—</span>) },
          ]} />
        )}
      </Section>
    </>
  );
}

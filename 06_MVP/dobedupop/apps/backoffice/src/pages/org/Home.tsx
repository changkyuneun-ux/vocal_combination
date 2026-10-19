import { Link } from "react-router";
import { useGet } from "../../api/hooks.ts";
import { ORG_CLASS_LABEL, ROLE_LABEL, TENANT_TYPE_LABEL, type AccountRow, type Me, type TenantDetail } from "../../api/admin.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Section } from "../../components/Section.tsx";
import { currentApp } from "../../app/apps.ts";
import { AccountForm, AccountTable } from "./Accounts.tsx";
import { OrgStatus } from "./Status.tsx";

type MyParty = { partyId: string; partyType: string; displayName: string };

/** 범위 설명(테넌트 정책 3절): 내 조직이 무엇을 보는가. */
function scopeText(me: Me): string {
  if (me.scope === "platform") return "플랫폼(전체 — 다른 조직 상세를 열면 열람 기록이 남는다)";
  if (me.orgClass === "PARTICIPANT") return "확인된 연결로 묶인 기록 중 위임받은 일에 필요한 항목, 우리 당사자의 명세, 우리 조직이 올린 자료만";
  return "우리 테넌트가 등록한 데이터(소유), 우리 당사자 몫의 정산(당사자), 우리 당사자가 상대인 확인 요청·문서·동의(공유 규칙)만";
}

/** 첫 화면(권리자 포털·참여 기관 공통): 내 조직·상태·확인 항목, 당사자, 내 소속. */
export function OrgHome() {
  const me = useGet<Me>(["me"], "/me");
  const t = useGet<TenantDetail>(["tenant", me.data?.tenantId], `/tenants/${me.data?.tenantId ?? ""}`, { enabled: me.data !== undefined && me.data.scope !== "platform" });
  const parties = useGet<MyParty[]>(["my-parties"], "/my/parties", { enabled: me.data !== undefined && me.data.scope !== "platform" });
  const m = me.data;
  return (
    <>
      {m?.readOnly && <div className="error-panel" role="status">이 조직은 지금 <strong>{t.data?.status === "SUSPENDED" ? "정지" : "신청"}</strong> 상태라 관리자만 열람으로 들어옵니다. 바꾸는 일은 할 수 없습니다.</div>}
      <Section title={t.data ? t.data.name : m?.scope === "platform" ? "플랫폼 운영(포털 보기)" : "내 조직"}>
        <ErrorPanel error={me.error ?? t.error} />
        {m && (
          <dl className="kv">
            <dt>로그인</dt><dd>{m.displayName} <span className="muted">({m.userId})</span></dd>
            <dt>지금 일하는 소속</dt><dd>{t.data?.name ?? m.tenantId} · {m.orgClass ? ORG_CLASS_LABEL[m.orgClass] : ""} · 역할 {m.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") || "없음"}</dd>
            <dt>볼 수 있는 범위</dt><dd>{scopeText(m)}</dd>
          </dl>
        )}
      </Section>
      {t.data && <Section title="조직 상태·확인 항목"><OrgStatus t={t.data} /></Section>}
      {m && m.scope !== "platform" && !(m.tenantType === "B2B_PARTNER") && (
        <Section title="우리 당사자">
          <p className="muted">{m.orgClass === "PARTICIPANT" ? "신탁 범위의 작품 몫은 이 당사자가 받는다." : "정산 금액은 테넌트가 아니라 당사자(권리 주체)에 귀속된다. 명세는 \"명세서\"에서 본다."}</p>
          <ErrorPanel error={parties.error} />
          <DataTable rows={parties.data ?? []} empty="우리 조직이 관리하는 당사자가 없습니다."
            columns={[{ key: "displayName", label: "이름", render: (r) => <><strong>{r.displayName}</strong><div className="muted small"><code>{r.partyId}</code></div></> }, { key: "partyType", label: "유형" }]} />
        </Section>
      )}
      {m?.memberships && m.memberships.length > 1 && (
        <Section title="내 소속">
          <p className="muted">한 계정이 여러 조직에 소속될 수 있다(결정 TD9). 머리글에서 일할 소속을 바꾼다.</p>
          <DataTable rows={m.memberships} columns={[
            { key: "name", label: "조직", render: (x) => <>{x.name}{x.home && <span className="muted small"> · 기본 소속</span>}</> },
            { key: "type", label: "구분", render: (x) => `${ORG_CLASS_LABEL[x.orgClass]} · ${TENANT_TYPE_LABEL[x.tenantType] ?? x.tenantType}` },
            { key: "roles", label: "역할", render: (x) => x.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") || "—" },
          ]} />
        </Section>
      )}
      {m?.roles.includes("TENANT_ADMIN") && <p><Link className="btn" to="/accounts">담당자 계정 관리 →</Link></p>}
    </>
  );
}

/** 조직 관리자의 담당자 계정 관리(결정 TD4): 자기 조직 계정만, 자기 역할은 못 바꾼다. */
export function OrgAccountsPage() {
  const me = useGet<Me>(["me"], "/me");
  const users = useGet<{ items: AccountRow[] }>(["users", "mine"], "/users?limit=200");
  const admin = me.data?.roles.includes("TENANT_ADMIN") === true;
  const cls = me.data?.orgClass ?? (currentApp() === "partner" ? "PARTICIPANT" : "RIGHTS");
  return (
    <>
      <Section title="담당자 계정">
        <p className="muted">{admin ? "우리 조직 담당자의 계정·역할·잠금을 관리한다. 정책 편집·승인·활성화는 서로 다른 사람에게 준다(직무 분리)." : "계정 관리는 조직 관리자가 한다."}</p>
        <ErrorPanel error={users.error} />
        <AccountTable rows={users.data?.items ?? []} orgClass={cls} {...(me.data?.tenantType !== undefined && { tenantType: me.data.tenantType })} reload={() => void users.refetch()} {...(me.data && { selfId: me.data.userId })} />
      </Section>
      {admin && me.data && (
        <Section title="담당자 초대"><AccountForm orgClass={cls} {...(me.data.tenantType !== undefined && { tenantType: me.data.tenantType })} onDone={() => void users.refetch()} /></Section>
      )}
    </>
  );
}

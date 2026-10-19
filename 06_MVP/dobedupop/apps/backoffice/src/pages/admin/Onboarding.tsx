import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import {
  ORG_CLASS_LABEL, PARTICIPANT_TYPES, PERSONAL, PLATFORM, RIGHTS_TYPES, TENANT_TYPE_LABEL, type AccountRow, type CreatedAccount, type LinkRow, type OrgClass, type TenantDetail, type TenantRow,
} from "../../api/admin.ts";
import { PARTY_TYPES } from "../../api/registry.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";
import { AccountForm, AccountTable, InviteBox } from "../org/Accounts.tsx";
import { OrgStatus, StatusBadge } from "../org/Status.tsx";
import { LinksTable } from "../org/Links.tsx";
import { DelegationPanel } from "../org/Delegation.tsx";

/**
 * 온보딩(운영 백오피스, 테넌트 정책 2·6·7·8절): 권리 테넌트와 참여 기관을 등록하고(신청), 확인 항목을 채워 확인됨·활성으로 올리고,
 * 첫 관리자 계정만 발급한다(그 뒤 담당자는 조직 관리자가). 운영 인력과 개인 계정(실연자·팬)은 따로 관리한다.
 */
const COPY: Record<"RIGHTS" | "PARTICIPANT", { title: string; intro: string; types: [string, string][]; placeholder: [string, string] }> = {
  RIGHTS: {
    title: "권리 테넌트",
    intro: "권리를 등록·관리하는 조직이다(레이블·기획사·출판사, 그리고 혼자 등록하는 독립 아티스트). 권리를 등록하려면 권리 테넌트가 있어야 한다. 돈은 테넌트가 아니라 그 테넌트가 관리하는 당사자에게 간다.",
    types: RIGHTS_TYPES, placeholder: ["tnt_bighit", "빅히트 뮤직"],
  },
  PARTICIPANT: {
    title: "참여 기관",
    intro: "신탁단체·유통 파트너는 권리를 만들지 않고 특정 테넌트에 속하지 않는다. 양쪽이 확인한 연결로만 여러 테넌트의 권리·정산에 닿아 위임받은 일을 한다. 참여 기관 화면(partner.)으로 들어온다.",
    types: PARTICIPANT_TYPES, placeholder: ["tnt_komca", "한국음악저작권협회"],
  },
};

export function OrgListPage({ cls }: { cls: "RIGHTS" | "PARTICIPANT" }) {
  const c = COPY[cls];
  const list = useGet<TenantRow[]>(["tenants", cls], `/tenants?class=${cls}`);
  const empty = { tenantId: "tnt_", name: "", tenantType: c.types[0]![0], businessNo: "", country: "KR", representative: "" };
  const [form, setForm] = useState(empty);
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async () => {
    try { await api("POST", "/tenants", form); setErr(null); setDone(form.tenantId); setForm(empty); void list.refetch(); }
    catch (e) { setErr(e as ApiError); setDone(null); }
  };
  return (
    <>
      <Section title={c.title}>
        <p className="muted">{c.intro}</p>
        <ErrorPanel error={list.error} />
        <DataTable<TenantRow> rows={list.data ?? []} empty={`${c.title}가 없습니다.`} columns={[
          { key: "name", label: "조직", render: (t) => <><Link to={`/admin/orgs/${t.tenantId}`}><strong>{t.name}</strong></Link><div className="muted small"><code>{t.tenantId}</code></div></> },
          { key: "type", label: "유형", render: (t) => TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType },
          { key: "status", label: "상태", render: (t) => <StatusBadge status={t.status} /> },
          { key: "biz", label: "사업자번호", render: (t) => t.businessNo ?? <span className="muted">—</span> },
          { key: "users", label: "계정", render: (t) => `${t.users}명` },
          { key: "parties", label: "당사자", render: (t) => `${t.parties}개` },
          { key: "created", label: "등록", render: (t) => <Instant iso={t.createdAt} /> },
        ]} />
      </Section>
      <Section title={`${c.title} 등록(신청)`}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="form-grid">
            <label className="field"><span>조직 id</span><input aria-label="조직 id" value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} placeholder={c.placeholder[0]} /></label>
            <label className="field"><span>이름</span><input aria-label="조직 이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={c.placeholder[1]} /></label>
            <label className="field"><span>유형</span>
              <select aria-label="조직 유형" value={form.tenantType} onChange={(e) => setForm({ ...form, tenantType: e.target.value })}>
                {c.types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
            <label className="field"><span>사업자번호</span><input aria-label="사업자번호" value={form.businessNo} onChange={(e) => setForm({ ...form, businessNo: e.target.value })} placeholder="123-45-67890" /></label>
            <label className="field"><span>국가</span><input aria-label="국가" value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} /></label>
            <label className="field"><span>대표자</span><input aria-label="대표자" value={form.representative} onChange={(e) => setForm({ ...form, representative: e.target.value })} /></label>
          </div>
          <div><button type="submit" className="btn primary" disabled={!/^tnt_[a-z0-9_]+$/.test(form.tenantId) || form.name.trim() === ""}>등록(신청 상태로)</button></div>
          <p className="muted small">등록하면 신청 상태다. 조직 화면에서 확인 항목을 채워 확인됨 → 활성으로 올리고, 첫 관리자 계정을 발급한다. 독립 아티스트는 "개인 계정" 화면의 1인 온보딩이 더 간단하다.</p>
          <ErrorPanel error={err} />
          {done && <p role="status"><Link to={`/admin/orgs/${done}`}><strong>{done}</strong></Link>을(를) 신청 상태로 등록했습니다. 확인 항목을 채우세요.</p>}
        </form>
      </Section>
    </>
  );
}

/** 조직 상세: 수명주기·확인 항목, 계정(첫 관리자), 당사자(등록·관리 이관), 연결, 위임. */
export function OrgDetailPage() {
  const { tenantId = "" } = useParams();
  const t = useGet<TenantDetail>(["tenant", tenantId], `/tenants/${encodeURIComponent(tenantId)}`);
  const users = useGet<{ items: AccountRow[] }>(["users", tenantId], `/users?tenant=${encodeURIComponent(tenantId)}&limit=200`);
  const parties = useGet<{ items: { partyId: string; partyType: string; displayName: string }[] }>(["parties", tenantId], `/parties?tenant=${encodeURIComponent(tenantId)}&limit=200`);
  const links = useGet<LinkRow[]>(["links"], "/links");
  const [party, setParty] = useState({ partyId: "pty_", partyType: "LABEL", displayName: "", legalId: "" });
  const [perr, setPerr] = useState<ApiError | null>(null);
  // 첫 관리자를 발급하면 발급 폼이 사라지므로(관리자가 생겼다) 초대 링크는 이 화면이 들고 있는다.
  const [issued, setIssued] = useState<CreatedAccount | null>(null);
  const reload = () => { void users.refetch(); void t.refetch(); void parties.refetch(); };
  const d = t.data;
  const cls: OrgClass = d?.orgClass ?? "RIGHTS";
  const hasAdmin = (users.data?.items ?? []).some((a) => a.roles.includes("TENANT_ADMIN") && !a.disabled);
  const addParty = async () => {
    try { await api("POST", "/parties", { partyId: party.partyId, partyType: party.partyType, displayName: party.displayName, tenantId, ...(party.legalId.trim() && { legalId: party.legalId.trim() }) }); setPerr(null); setParty({ ...party, partyId: "pty_", displayName: "", legalId: "" }); reload(); }
    catch (e) { setPerr(e as ApiError); }
  };
  const mine = (links.data ?? []).filter((l) => l.participantTenantId === tenantId || l.rightsTenantId === tenantId);
  const back = cls === "PARTICIPANT" ? "/admin/participants" : "/admin/tenants";
  return (
    <>
      <Section title={d ? d.name : tenantId} actions={<Link className="btn tiny" to={back}>← {ORG_CLASS_LABEL[cls]} 목록</Link>}>
        <ErrorPanel error={t.error} />
        {d && <OrgStatus t={d} editable reload={reload} />}
      </Section>
      <Section title={`계정 ${users.data ? `(${users.data.items.length})` : ""}`}>
        <p className="muted">운영은 조직의 첫 관리자만 발급한다. 담당자 계정·역할·잠금은 그 조직 관리자가 {cls === "PARTICIPANT" ? "참여 기관 화면" : "권리자 포털"}에서 한다(결정 TD4).</p>
        <ErrorPanel error={users.error} />
        {issued?.inviteToken && <InviteBox token={issued.inviteToken} orgClass={cls} userId={issued.userId} {...(issued.inviteExpiresAt && { expiresAt: issued.inviteExpiresAt })} />}
        <AccountTable rows={users.data?.items ?? []} orgClass={cls} {...(d && { tenantType: d.tenantType })} tenantId={tenantId} reload={reload} />
        {d && !hasAdmin && d.status !== "TERMINATED" && (
          <>
            <h3 style={{ margin: "16px 0 6px" }}>첫 관리자 발급</h3>
            <AccountForm orgClass={cls} tenantType={d.tenantType} tenantId={tenantId} firstAdmin onDone={(c) => { setIssued(c); reload(); }} />
          </>
        )}
      </Section>
      {d && cls !== "PLATFORM" && !(cls === "PARTICIPANT" && d.tenantType === "B2B_PARTNER") && (
        <Section title={`당사자 ${parties.data ? `(${parties.data.items.length})` : ""}`}>
          <p className="muted">{cls === "PARTICIPANT" ? "신탁단체는 신탁 범위의 작품 몫을 받는 당사자 하나를 둔다." : "이 테넌트가 관리하는 당사자(돈을 받는 권리 주체)다. 같은 법인이 여러 권리 역할을 하면 당사자를 여럿 둔다. 다른 법인이면 관리 위임 계약이 필요하다(결정 TD2)."}</p>
          <ErrorPanel error={parties.error} />
          <DataTable rows={parties.data?.items ?? []} empty="당사자가 없습니다." columns={[
            { key: "displayName", label: "이름", render: (p) => <><strong>{p.displayName}</strong><div className="muted small"><code>{p.partyId}</code></div></> },
            { key: "partyType", label: "유형" },
          ]} />
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void addParty(); }}>
            <h3 style={{ margin: "12px 0 0" }}>당사자 등록</h3>
            <div className="form-grid">
              <label className="field"><span>당사자 id</span><input aria-label="당사자 id" value={party.partyId} onChange={(e) => setParty({ ...party, partyId: e.target.value })} /></label>
              <label className="field"><span>유형</span>
                <select aria-label="당사자 유형" value={party.partyType} onChange={(e) => setParty({ ...party, partyType: e.target.value })}>{PARTY_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
              <label className="field"><span>표시명</span><input aria-label="당사자 표시명" value={party.displayName} onChange={(e) => setParty({ ...party, displayName: e.target.value })} /></label>
              <label className="field"><span>사업자번호(비우면 조직 것)</span><input aria-label="당사자 사업자번호" value={party.legalId} onChange={(e) => setParty({ ...party, legalId: e.target.value })} /></label>
            </div>
            <div><button type="submit" className="btn primary" disabled={party.partyId.length < 5 || party.displayName.trim() === ""}>당사자 등록</button></div>
            <ErrorPanel error={perr} />
          </form>
        </Section>
      )}
      {d && (cls === "RIGHTS" || cls === "PARTICIPANT") && (
        <Section title="연결"><LinksTable links={mine} reload={() => void links.refetch()} side="PLATFORM" /></Section>
      )}
      {d && cls === "RIGHTS" && <Section title="위임 대행(조직 관리자가 정한다)"><DelegationPanel tenantId={tenantId} editable={false} /></Section>}
    </>
  );
}

/** 운영 인력(플랫폼 운영 조직 계정). 권리 결정 역할은 줄 수 없다(결정 TD3). */
export function StaffPage() {
  const users = useGet<{ items: AccountRow[] }>(["users", PLATFORM], `/users?tenant=${PLATFORM}&limit=200`);
  return (
    <>
      <Section title="운영 인력">
        <p className="muted">플랫폼 운영 계정은 검증·집행만 한다: 운영·정산·온보딩·컴플라이언스·법무. 정책 편집·승인·활성화·발행 같은 권리 결정 역할은 없다. 운영 백오피스는 비밀번호 + 인증 앱 코드로 로그인한다.</p>
        <ErrorPanel error={users.error} />
        <AccountTable rows={(users.data?.items ?? []).filter((a) => !a.userId.startsWith("sys_"))} orgClass="PLATFORM" tenantId={PLATFORM} reload={() => void users.refetch()} />
      </Section>
      <Section title="운영 인력 계정 만들기"><AccountForm orgClass="PLATFORM" tenantId={PLATFORM} onDone={() => void users.refetch()} /></Section>
    </>
  );
}

/** 개인 계정(실연자·팬): 테넌트 없이 본인 당사자 하나로 일한다. 독립 아티스트 1인 온보딩도 여기서. */
export function PeoplePage() {
  const users = useGet<{ items: AccountRow[] }>(["users", PERSONAL], `/users?tenant=${PERSONAL}&limit=200`);
  const [f, setF] = useState({ userId: "", tenantId: "tnt_", name: "", country: "KR" });
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const onboard = async () => {
    try { const r = await api<{ tenant: { tenantId: string } }>("POST", "/onboarding/independent-artists", f); setErr(null); setDone(r.tenant.tenantId); void users.refetch(); }
    catch (e) { setErr(e as ApiError); setDone(null); }
  };
  return (
    <>
      <Section title="개인 계정(실연자·팬)">
        <p className="muted">권리를 등록하지 않는 개인은 테넌트가 없다. 본인 당사자 하나에 묶이고 본인 인증 코드로 로그인한다. 운영은 계정을 만들 수 있지만 그 사람 대신 동의·서명하지 못한다.</p>
        <ErrorPanel error={users.error} />
        <AccountTable rows={users.data?.items ?? []} orgClass="INDIVIDUAL" tenantId={PERSONAL} reload={() => void users.refetch()} />
      </Section>
      <Section title="개인 계정 만들기"><AccountForm orgClass="INDIVIDUAL" tenantId={PERSONAL} onDone={() => void users.refetch()} /></Section>
      <Section title="독립 아티스트 1인 온보딩">
        <p className="muted">본인 인증을 마친 개인 계정이 자기 곡을 등록하려면 1인 권리 테넌트가 필요하다. 테넌트를 신청 상태로 만들고, 본인 확인 항목을 채우고, 그 계정에 관리자·권리 편집·정책(편집·승인·활성화) 소속을 더하고, 본인 당사자의 관리를 새 테넌트로 옮긴다. 정책은 법무 승인 표준 템플릿을 그대로 쓸 때만 혼자 승인·활성화할 수 있다(결정 TD13). 실연자 앱은 그대로 쓴다.</p>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void onboard(); }}>
          <div className="form-grid">
            <label className="field"><span>개인 계정 id</span>
              <select aria-label="개인 계정" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
                <option value="">선택…</option>{(users.data?.items ?? []).filter((u) => u.partyId).map((u) => <option key={u.userId} value={u.userId}>{u.displayName} ({u.userId}){u.identityVerified ? "" : " · 본인 인증 전"}</option>)}
              </select></label>
            <label className="field"><span>테넌트 id</span><input aria-label="1인 테넌트 id" value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} /></label>
            <label className="field"><span>활동명</span><input aria-label="활동명" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field"><span>국가</span><input aria-label="1인 테넌트 국가" value={f.country} maxLength={2} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></label>
          </div>
          <div><button type="submit" className="btn primary" disabled={f.userId === "" || !/^tnt_[a-z0-9_]+$/.test(f.tenantId) || f.name.trim() === ""}>1인 테넌트 만들기</button></div>
          <ErrorPanel error={err} />
          {done && <p role="status"><Link to={`/admin/orgs/${done}`}><strong>{done}</strong></Link>을(를) 만들었습니다. 플랫폼 이용 계약을 확인한 뒤 확인됨 → 활성으로 올리세요.</p>}
        </form>
      </Section>
    </>
  );
}

import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { inviteUrl, loginState, PERSONAL, PLATFORM, ROLE_LABEL, rolesFor, TENANT_TYPE_LABEL, TENANT_TYPES, type AccountRow, type CreatedAccount, type TenantRow } from "../../api/admin.ts";
import { PARTY_TYPES } from "../../api/registry.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

/**
 * 온보딩(⑦ 관리, MVP 진행계획 M3): 운영이 권리자 테넌트(예: 빅히트 뮤직)를 등록하고, 그 테넌트의 담당자 계정을 발급한다.
 * 계정을 만들면 일회용 초대 링크가 한 번 나온다 — 담당자가 링크로 들어가 비밀번호를 정한다(운영은 이메일로 보낸다).
 * 권리 결정 역할(권리 편집·정책 편집·승인·활성화)은 권리자 테넌트에만 준다. 플랫폼은 권리를 대신 결정하지 않는다.
 */

function Roles({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <span className="muted">역할 없음</span>;
  return <>{roles.map((r) => <span key={r} className="badge info" style={{ marginRight: 4 }}>{ROLE_LABEL[r] ?? r}</span>)}</>;
}

function RolePicker({ tenantId, value, onChange }: { tenantId: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="field">
      <legend>역할</legend>
      {rolesFor(tenantId).map((r) => (
        <label key={r} className="check">
          <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
          {ROLE_LABEL[r] ?? r}
        </label>
      ))}
    </fieldset>
  );
}

/** 초대 링크를 보여 주고 복사한다(토큰은 이 화면에서 한 번만 보인다). */
function InviteBox({ token, tenantId, userId, expiresAt }: { token: string; tenantId: string; userId: string; expiresAt?: string }) {
  const url = inviteUrl(location, token, tenantId);
  const [copied, setCopied] = useState(false);
  return (
    <div className="invite-box" role="status" aria-label="초대 링크">
      <strong>{userId} 계정을 만들었습니다.</strong>
      <p className="small">아래 초대 링크를 담당자에게 전달하세요. 링크로 들어가 비밀번호(10자 이상)를 정하면 로그인할 수 있습니다{expiresAt ? <> · 만료 <Instant iso={expiresAt} /></> : null}. 이 링크는 지금 한 번만 보입니다.</p>
      <div className="inline-form">
        <input readOnly value={url} aria-label="초대 링크 주소" style={{ flex: 1, minWidth: 280 }} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}>{copied ? "복사됨" : "복사"}</button>
        <a className="btn" href={url} target="_blank" rel="noreferrer">열기</a>
      </div>
    </div>
  );
}

/** 계정 표: 역할 변경·잠금·초대 다시 보내기. */
function AccountTable({ rows, showTenant, reload }: { rows: AccountRow[]; showTenant: boolean; reload: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [err, setErr] = useState<ApiError | null>(null);
  const [invite, setInvite] = useState<{ userId: string; tenantId: string; token: string; expiresAt: string } | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); reload(); } catch (e) { setErr(e as ApiError); } };
  return (
    <>
      <ErrorPanel error={err} />
      {invite && <InviteBox token={invite.token} tenantId={invite.tenantId} userId={invite.userId} expiresAt={invite.expiresAt} />}
      <DataTable<AccountRow> rows={rows} empty="계정이 없습니다." columns={[
        { key: "user", label: "계정", render: (a) => <><strong>{a.displayName}</strong><div className="muted small"><code>{a.userId}</code></div></> },
        ...(showTenant ? [{ key: "tenant", label: "소속", render: (a: AccountRow) => <Link to={`/admin/tenants/${a.tenantId}`}>{a.tenantName}</Link> }] : []),
        { key: "roles", label: "역할", render: (a) => (editing === a.userId
          ? <div className="stack"><RolePicker tenantId={a.tenantId} value={draft} onChange={setDraft} />
              <div className="row-actions">
                <button type="button" className="btn primary tiny" onClick={() => void act(async () => { await api("PUT", `/users/${a.userId}/roles`, { roles: draft }); setEditing(null); })}>저장</button>
                <button type="button" className="btn tiny" onClick={() => setEditing(null)}>취소</button>
              </div></div>
          : <Roles roles={a.roles} />) },
        { key: "login", label: "로그인", render: (a) => { const s = loginState(a); return <span className={`badge ${s.tone}`}>{s.text}</span>; } },
        { key: "last", label: "마지막 로그인", render: (a) => (a.lastLoginAt ? <Instant iso={a.lastLoginAt} /> : <span className="muted">—</span>) },
        { key: "act", label: "", render: (a) => (
          <div className="row-actions">
            {editing !== a.userId && <button type="button" className="btn tiny" onClick={() => { setEditing(a.userId); setDraft(a.roles); }}>역할 변경</button>}
            {!a.roles.includes("PERFORMER") && a.tenantId !== PERSONAL && (
              <button type="button" className="btn tiny" onClick={() => void act(async () => {
                const r = await api<{ inviteToken: string; inviteExpiresAt: string }>("POST", `/users/${a.userId}/invite`);
                setInvite({ userId: a.userId, tenantId: a.tenantId, token: r.inviteToken, expiresAt: r.inviteExpiresAt });
              })}>{a.hasPassword ? "비밀번호 재설정 링크" : "초대 링크 다시 만들기"}</button>
            )}
            <button type="button" className={`btn tiny${a.disabled ? "" : " danger"}`} onClick={() => void act(() => api("PUT", `/users/${a.userId}/disabled`, { disabled: !a.disabled }))}>{a.disabled ? "잠금 해제" : "잠금"}</button>
          </div>
        ) },
      ]} />
    </>
  );
}

/** 계정 발급 폼. 실연자(개인) 계정은 비밀번호 없이 본인 인증 코드로 들어오므로 초대 링크가 없다. */
function AccountForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>(tenantId === PERSONAL ? ["PERFORMER"] : []);
  const [partyId, setPartyId] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<CreatedAccount | null>(null);
  const submit = async () => {
    try {
      const r = await api<CreatedAccount>("POST", "/users", { userId: userId.trim(), displayName: name.trim(), tenantId, roles, ...(partyId.trim() && { partyId: partyId.trim() }) });
      setCreated(r); setErr(null); setUserId(""); setName(""); setPartyId(""); onDone();
    } catch (e) { setErr(e as ApiError); setCreated(null); }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="form-grid">
        <label className="field"><span>아이디(로그인 id)</span><input aria-label="새 계정 아이디" placeholder="usr_bh_rights" value={userId} onChange={(e) => setUserId(e.target.value)} /></label>
        <label className="field"><span>이름</span><input aria-label="새 계정 이름" placeholder="빅히트 권리 편집" value={name} onChange={(e) => setName(e.target.value)} /></label>
        {tenantId === PERSONAL && <label className="field"><span>본인 당사자 id(실연자)</span><input aria-label="본인 당사자 id" placeholder="pty_jungkook" value={partyId} onChange={(e) => setPartyId(e.target.value)} /></label>}
      </div>
      <RolePicker tenantId={tenantId} value={roles} onChange={setRoles} />
      <div><button type="submit" className="btn primary" disabled={userId.trim() === "" || name.trim() === "" || roles.length === 0}>계정 만들기</button></div>
      <ErrorPanel error={err} />
      {created?.inviteToken && <InviteBox token={created.inviteToken} tenantId={tenantId} userId={created.userId} {...(created.inviteExpiresAt && { expiresAt: created.inviteExpiresAt })} />}
      {created && created.login === "OTP" && <p role="status"><strong>{created.userId}</strong> 계정을 만들었습니다. 실연자 앱에서 아이디로 본인 인증 코드를 받아 로그인합니다.</p>}
    </form>
  );
}

/** 테넌트 목록·등록. */
export function TenantsPage() {
  const list = useGet<TenantRow[]>(["tenants"], "/tenants");
  const [form, setForm] = useState({ tenantId: "tnt_", name: "", tenantType: "LABEL" });
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async () => {
    try { await api("POST", "/tenants", form); setErr(null); setDone(form.tenantId); setForm({ tenantId: "tnt_", name: "", tenantType: "LABEL" }); void list.refetch(); }
    catch (e) { setErr(e as ApiError); setDone(null); }
  };
  return (
    <>
      <Section title="테넌트">
        <p className="muted">테넌트는 포털에 로그인해 일하는 조직(레이블·기획사·출판사 등)이다. 데이터를 볼 수 있는 범위가 테넌트로 갈린다. 정산 금액은 테넌트가 아니라 당사자(권리 주체)에 귀속된다.</p>
        <ErrorPanel error={list.error} />
        <DataTable<TenantRow> rows={list.data ?? []} empty="테넌트가 없습니다." columns={[
          { key: "name", label: "테넌트", render: (t) => <><Link to={`/admin/tenants/${t.tenantId}`}><strong>{t.name}</strong></Link><div className="muted small"><code>{t.tenantId}</code></div></> },
          { key: "type", label: "유형", render: (t) => TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType },
          { key: "status", label: "상태", render: (t) => <span className={`badge ${t.status === "ACTIVE" ? "ok" : "bad"}`}>{t.status === "ACTIVE" ? "사용 중" : t.status}</span> },
          { key: "users", label: "계정", render: (t) => `${t.users}명` },
          { key: "parties", label: "당사자", render: (t) => `${t.parties}개` },
          { key: "validation", label: "정합성 차단", render: (t) => (t.validationEnforced ? "적용" : <span className="muted">경고만</span>) },
          { key: "created", label: "등록", render: (t) => <Instant iso={t.createdAt} /> },
        ]} />
      </Section>
      <Section title="테넌트 등록(권리자 온보딩)">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="form-grid">
            <label className="field"><span>테넌트 id</span><input aria-label="테넌트 id" value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} placeholder="tnt_bighit" /></label>
            <label className="field"><span>이름</span><input aria-label="테넌트 이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="빅히트 뮤직" /></label>
            <label className="field"><span>유형</span>
              <select aria-label="테넌트 유형" value={form.tenantType} onChange={(e) => setForm({ ...form, tenantType: e.target.value })}>
                {TENANT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <div><button type="submit" className="btn primary" disabled={!/^tnt_[a-z0-9_]+$/.test(form.tenantId) || form.name.trim() === ""}>테넌트 등록</button></div>
          <p className="muted small">id는 tnt_ 뒤에 영문 소문자·숫자·밑줄. 등록한 뒤 테넌트 화면에서 담당자 계정과 당사자를 만든다.</p>
          <ErrorPanel error={err} />
          {done && <p role="status">테넌트 <Link to={`/admin/tenants/${done}`}><strong>{done}</strong></Link>를 등록했습니다. 이어서 담당자 계정을 만드세요.</p>}
        </form>
      </Section>
    </>
  );
}

/** 테넌트 상세: 계정(발급·역할·잠금), 당사자(등록). */
export function TenantDetailPage() {
  const { tenantId = "" } = useParams();
  const tenants = useGet<TenantRow[]>(["tenants"], "/tenants");
  const t = tenants.data?.find((x) => x.tenantId === tenantId);
  const users = useGet<{ items: AccountRow[] }>(["users", tenantId], `/users?tenant=${encodeURIComponent(tenantId)}&limit=200`);
  const parties = useGet<{ items: { partyId: string; partyType: string; displayName: string }[] }>(["parties", tenantId], `/parties?tenant=${encodeURIComponent(tenantId)}&limit=200`);
  const [party, setParty] = useState({ partyId: "pty_", partyType: "LABEL", displayName: "" });
  const [perr, setPerr] = useState<ApiError | null>(null);
  const reload = () => { void users.refetch(); void tenants.refetch(); };
  const addParty = async () => {
    try { await api("POST", "/parties", { ...party, tenantId }); setPerr(null); setParty({ partyId: "pty_", partyType: party.partyType, displayName: "" }); void parties.refetch(); void tenants.refetch(); }
    catch (e) { setPerr(e as ApiError); }
  };
  return (
    <>
      <Section title={t ? `${t.name}` : tenantId} actions={<Link className="btn tiny" to="/admin/tenants">← 테넌트 목록</Link>}>
        {t && (
          <dl className="kv">
            <dt>테넌트 id</dt><dd><code>{t.tenantId}</code></dd>
            <dt>유형</dt><dd>{TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType}</dd>
            <dt>상태</dt><dd>{t.status === "ACTIVE" ? "사용 중" : t.status}</dd>
            <dt>정합성 차단</dt><dd>{t.validationEnforced ? "적용(차단 이슈가 있으면 정책·팩 활성화를 막는다)" : "경고만"}</dd>
            <dt>등록</dt><dd><Instant iso={t.createdAt} /></dd>
          </dl>
        )}
        <ErrorPanel error={tenants.error} />
      </Section>
      <Section title={`계정 ${users.data ? `(${users.data.items.length})` : ""}`}>
        <ErrorPanel error={users.error} />
        <AccountTable rows={users.data?.items ?? []} showTenant={false} reload={reload} />
      </Section>
      <Section title="담당자 계정 만들기">
        <p className="muted">{tenantId === PLATFORM ? "플랫폼 운영 인력 계정이다. 운영 백오피스는 비밀번호와 인증 앱 코드로 로그인한다." : tenantId === PERSONAL ? "실연자·팬 개인 계정이다. 비밀번호 없이 본인 인증 코드로 로그인한다." : "이 테넌트의 담당자 계정이다. 정책 편집·승인·활성화는 서로 다른 사람에게 준다(직무 분리)."}</p>
        <AccountForm tenantId={tenantId} onDone={reload} />
      </Section>
      {tenantId !== PLATFORM && (
        <Section title={`당사자 ${parties.data ? `(${parties.data.items.length})` : ""}`}>
          <p className="muted">당사자는 정산 금액이 귀속되는 권리 주체(레이블·소속사·작가·멤버 등)다. 한 테넌트가 여러 당사자를 가질 수 있다(예: 빅히트 뮤직 — 레이블, 소속사).</p>
          <ErrorPanel error={parties.error} />
          <DataTable rows={parties.data?.items ?? []} empty="당사자가 없습니다." columns={[
            { key: "displayName", label: "이름", render: (p) => <><strong>{p.displayName}</strong><div className="muted small"><code>{p.partyId}</code></div></> },
            { key: "partyType", label: "유형" },
          ]} />
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void addParty(); }}>
            <h3 style={{ margin: "12px 0 0" }}>당사자 등록</h3>
            <div className="form-grid">
              <label className="field"><span>당사자 id</span><input aria-label="당사자 id" value={party.partyId} onChange={(e) => setParty({ ...party, partyId: e.target.value })} placeholder="pty_bighit_label" /></label>
              <label className="field"><span>유형</span>
                <select aria-label="당사자 유형" value={party.partyType} onChange={(e) => setParty({ ...party, partyType: e.target.value })}>{PARTY_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
              </label>
              <label className="field"><span>표시명</span><input aria-label="당사자 표시명" value={party.displayName} onChange={(e) => setParty({ ...party, displayName: e.target.value })} placeholder="빅히트 뮤직 — 레이블" /></label>
            </div>
            <div><button type="submit" className="btn primary" disabled={party.partyId.length < 5 || party.displayName.trim() === ""}>당사자 등록</button></div>
            <p className="muted small">다른 테넌트 밑에 당사자를 만드는 일은 플랫폼 온보딩 담당(플랫폼 권리 편집 역할)이 한다. 권리자는 포털에서 자기 테넌트 당사자를 직접 만들 수도 있다.</p>
            <ErrorPanel error={perr} />
          </form>
        </Section>
      )}
    </>
  );
}

/** 전체 계정: 소속으로 거르고, 플랫폼 인력·실연자 계정을 만든다. */
export function AccountsPage() {
  const [tenant, setTenant] = useState("");
  const tenants = useGet<TenantRow[]>(["tenants"], "/tenants");
  const users = useGet<{ items: AccountRow[] }>(["users", tenant], `/users?limit=200${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ""}`);
  const [createIn, setCreateIn] = useState(PLATFORM);
  return (
    <>
      <Section title="계정">
        <div className="inline-form">
          <label className="field"><span>소속</span>
            <select aria-label="소속 필터" value={tenant} onChange={(e) => setTenant(e.target.value)}>
              <option value="">전체</option>
              {(tenants.data ?? []).map((t) => <option key={t.tenantId} value={t.tenantId}>{t.name}</option>)}
            </select>
          </label>
        </div>
        <ErrorPanel error={users.error} />
        <AccountTable rows={(users.data?.items ?? []).filter((a) => !a.userId.startsWith("sys_"))} showTenant={true} reload={() => void users.refetch()} />
      </Section>
      <Section title="계정 만들기">
        <label className="field" style={{ maxWidth: 360 }}><span>소속</span>
          <select aria-label="새 계정 소속" value={createIn} onChange={(e) => setCreateIn(e.target.value)}>
            {(tenants.data ?? []).map((t) => <option key={t.tenantId} value={t.tenantId}>{t.name} ({TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType})</option>)}
          </select>
        </label>
        <AccountForm key={createIn} tenantId={createIn} onDone={() => void users.refetch()} />
      </Section>
    </>
  );
}

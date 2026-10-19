import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { inviteUrl, loginState, PERSONAL, ROLE_LABEL, rolesFor, type AccountRow, type CreatedAccount, type OrgClass } from "../../api/admin.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";

/**
 * 계정 표·발급 폼(테넌트 정책 8절, 결정 TD4): 운영 백오피스(운영 인력·개인·첫 관리자)와 조직 관리자 화면(자기 조직 담당자)이 함께 쓴다.
 * 권한 판정은 코어가 한다 — 운영이 관리자 있는 조직 계정을 바꾸려 하면 TENANT_HAS_ADMIN, 줄 수 없는 역할이면 ROLE_NOT_ASSIGNABLE.
 */
export function Roles({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <span className="muted">역할 없음</span>;
  return <>{roles.map((r) => <span key={r} className="badge info" style={{ marginRight: 4 }}>{ROLE_LABEL[r] ?? r}</span>)}</>;
}

export function RolePicker({ orgClass, tenantType, value, onChange, only }: { orgClass: OrgClass; tenantType?: string; value: string[]; onChange: (v: string[]) => void; only?: string[] }) {
  const roles = only ?? rolesFor(orgClass, tenantType);
  return (
    <fieldset className="field">
      <legend>역할</legend>
      {roles.map((r) => (
        <label key={r} className="check">
          <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
          {ROLE_LABEL[r] ?? r}
        </label>
      ))}
    </fieldset>
  );
}

/** 초대 링크를 보여 주고 복사한다(토큰은 이 화면에서 한 번만 보인다). */
export function InviteBox({ token, orgClass, userId, expiresAt }: { token: string; orgClass: OrgClass; userId: string; expiresAt?: string }) {
  const url = inviteUrl(location, token, orgClass);
  const [copied, setCopied] = useState(false);
  return (
    <div className="invite-box" role="status" aria-label="초대 링크">
      <strong>{userId} 계정의 초대 링크</strong>
      <p className="small">담당자에게 전달하세요. 링크로 들어가 비밀번호(10자 이상)를 정하면 로그인할 수 있습니다{expiresAt ? <> · 만료 <Instant iso={expiresAt} /></> : null}. 이 링크는 지금 한 번만 보입니다.</p>
      <div className="inline-form">
        <input readOnly value={url} aria-label="초대 링크 주소" style={{ flex: 1, minWidth: 280 }} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}>{copied ? "복사됨" : "복사"}</button>
        <a className="btn" href={url} target="_blank" rel="noreferrer">열기</a>
      </div>
    </div>
  );
}

/** 계정 표: 역할 변경(소속별)·잠금·초대 다시 보내기. tenantId는 이 표가 보여 주는 소속(역할을 바꿀 소속)이다. */
export function AccountTable({ rows, orgClass, tenantType, tenantId, showTenant = false, reload, selfId }: {
  rows: AccountRow[]; orgClass: OrgClass | ((a: AccountRow) => OrgClass); tenantType?: string; tenantId?: string; showTenant?: boolean; reload: () => void; selfId?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [err, setErr] = useState<ApiError | null>(null);
  const [invite, setInvite] = useState<{ userId: string; cls: OrgClass; token: string; expiresAt: string } | null>(null);
  const clsOf = (a: AccountRow) => (typeof orgClass === "function" ? orgClass(a) : orgClass);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); reload(); } catch (e) { setErr(e as ApiError); } };
  return (
    <>
      <ErrorPanel error={err} />
      {invite && <InviteBox token={invite.token} orgClass={invite.cls} userId={invite.userId} expiresAt={invite.expiresAt} />}
      <DataTable<AccountRow> rows={rows} empty="계정이 없습니다." columns={[
        { key: "user", label: "계정", render: (a) => <><strong>{a.displayName}</strong><div className="muted small"><code>{a.userId}</code>{(a.memberships ?? 1) > 1 && <> · 소속 {a.memberships}곳</>}</div></> },
        ...(showTenant ? [{ key: "tenant", label: "소속", render: (a: AccountRow) => a.tenantName }] : []),
        { key: "roles", label: "역할", render: (a) => (editing === a.userId
          ? <div className="stack"><RolePicker orgClass={clsOf(a)} {...(tenantType !== undefined && { tenantType })} value={draft} onChange={setDraft} />
              <div className="row-actions">
                <button type="button" className="btn primary tiny" onClick={() => void act(async () => {
                  await api("PUT", `/users/${a.userId}/roles`, { roles: draft, ...(tenantId !== undefined && { tenantId }) }); setEditing(null);
                })}>저장</button>
                <button type="button" className="btn tiny" onClick={() => setEditing(null)}>취소</button>
              </div></div>
          : <Roles roles={a.roles} />) },
        { key: "login", label: "로그인", render: (a) => { const s = loginState(a); return <span className={`badge ${s.tone}`}>{s.text}</span>; } },
        { key: "last", label: "마지막 로그인", render: (a) => (a.lastLoginAt ? <Instant iso={a.lastLoginAt} /> : <span className="muted">—</span>) },
        { key: "act", label: "", render: (a) => (a.userId === selfId ? <span className="muted small">나</span> : (
          <div className="row-actions">
            {editing !== a.userId && clsOf(a) !== "INDIVIDUAL" && <button type="button" className="btn tiny" onClick={() => { setEditing(a.userId); setDraft(a.roles); }}>역할 변경</button>}
            {clsOf(a) !== "INDIVIDUAL" && a.homeMembership !== false && (
              <button type="button" className="btn tiny" onClick={() => void act(async () => {
                const r = await api<{ inviteToken: string; inviteExpiresAt: string }>("POST", `/users/${a.userId}/invite`);
                setInvite({ userId: a.userId, cls: clsOf(a), token: r.inviteToken, expiresAt: r.inviteExpiresAt });
              })}>{a.hasPassword ? "비밀번호 재설정 링크" : "초대 링크 다시 만들기"}</button>
            )}
            {a.homeMembership !== false && (
              <button type="button" className={`btn tiny${a.disabled ? "" : " danger"}`} onClick={() => void act(() => api("PUT", `/users/${a.userId}/disabled`, { disabled: !a.disabled }))}>{a.disabled ? "잠금 해제" : "잠금"}</button>
            )}
          </div>
        )) },
      ]} />
    </>
  );
}

/**
 * 계정 발급 폼. tenantId를 주면 그 조직(운영 화면), 안 주면 내 조직(조직 관리자 화면)에 만든다.
 * firstAdmin이면 운영이 첫 관리자를 발급하는 경우라 역할은 조직 관리자로 정해진다(독립 아티스트는 권리 편집을 함께 줄 수 있다).
 */
export function AccountForm({ orgClass, tenantType, tenantId, firstAdmin = false, onDone }: { orgClass: OrgClass; tenantType?: string; tenantId?: string; firstAdmin?: boolean; onDone: (created: CreatedAccount) => void }) {
  const initial = firstAdmin ? ["TENANT_ADMIN"] : orgClass === "INDIVIDUAL" ? ["PERFORMER"] : [];
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>(initial);
  const [partyId, setPartyId] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<CreatedAccount | null>(null);
  const submit = async () => {
    try {
      const r = await api<CreatedAccount>("POST", "/users", { userId: userId.trim(), displayName: name.trim(), ...(tenantId !== undefined && { tenantId }), roles, ...(partyId.trim() && { partyId: partyId.trim() }) });
      setCreated(r); setErr(null); setUserId(""); setName(""); setPartyId(""); setRoles(initial); onDone(r);
    } catch (e) { setErr(e as ApiError); setCreated(null); }
  };
  const only = firstAdmin ? (tenantType === "INDEPENDENT_ARTIST" ? ["TENANT_ADMIN", "RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR"] : ["TENANT_ADMIN"]) : undefined;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="form-grid">
        <label className="field"><span>아이디(로그인 id)</span><input aria-label="새 계정 아이디" placeholder="usr_bh_rights" value={userId} onChange={(e) => setUserId(e.target.value)} /></label>
        <label className="field"><span>이름</span><input aria-label="새 계정 이름" placeholder="담당자 이름" value={name} onChange={(e) => setName(e.target.value)} /></label>
        {tenantId === PERSONAL && <label className="field"><span>본인 당사자 id</span><input aria-label="본인 당사자 id" placeholder="pty_jungkook" value={partyId} onChange={(e) => setPartyId(e.target.value)} /></label>}
      </div>
      <RolePicker orgClass={orgClass} {...(tenantType !== undefined && { tenantType })} value={roles} onChange={setRoles} {...(only && { only })} />
      <div><button type="submit" className="btn primary" disabled={userId.trim() === "" || name.trim() === "" || (orgClass !== "PARTICIPANT" && roles.length === 0)}>계정 만들기</button></div>
      <ErrorPanel error={err} />
      {created?.inviteToken && !firstAdmin && <InviteBox token={created.inviteToken} orgClass={orgClass} userId={created.userId} {...(created.inviteExpiresAt && { expiresAt: created.inviteExpiresAt })} />}
      {created && created.login === "OTP" && <p role="status"><strong>{created.userId}</strong> 계정을 만들었습니다. 실연자 앱에서 아이디로 본인 인증 코드를 받아 로그인합니다.</p>}
    </form>
  );
}

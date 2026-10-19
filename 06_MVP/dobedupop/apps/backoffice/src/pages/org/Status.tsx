import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { CHECK_LABEL, STATUS_LABEL, STATUS_MEANS, STATUS_TONE, TENANT_TYPE_LABEL, ORG_CLASS_LABEL, type TenantDetail } from "../../api/admin.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? "muted"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** 조직 정보와 수명주기(테넌트 정책 7절). editable이면 운영이 확인 항목을 체크하고 상태를 바꾼다. 아니면(조직 자신) 읽기만. */
export function OrgStatus({ t, editable = false, reload }: { t: TenantDetail; editable?: boolean; reload?: () => void }) {
  const [err, setErr] = useState<ApiError | null>(null);
  const [reason, setReason] = useState("");
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); setReason(""); reload?.(); } catch (e) { setErr(e as ApiError); } };
  const have = new Map(t.checks.map((c) => [c.item, c]));
  const items = t.required ? [...new Set([...t.required.VERIFIED, ...t.required.ACTIVE])] : [];
  const missing = (to: "VERIFIED" | "ACTIVE") => (t.required?.[to] ?? []).filter((i) => !have.has(i));
  const needsReason = (to: string) => to === "SUSPENDED" || to === "TERMINATED" || (to === "ACTIVE" && t.status === "SUSPENDED");
  return (
    <>
      <dl className="kv">
        <dt>참여 구분</dt><dd>{ORG_CLASS_LABEL[t.orgClass]} · {TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType}</dd>
        <dt>조직 id</dt><dd><code>{t.tenantId}</code></dd>
        {t.required && <><dt>사업자번호</dt><dd>{t.businessNo ?? <span className="muted">—</span>}</dd>
          <dt>국가 · 대표자</dt><dd>{t.country ?? "—"} · {t.representative ?? "—"}</dd></>}
        <dt>상태</dt><dd><StatusBadge status={t.status} /> <span className="muted small">{STATUS_MEANS[t.status]}</span>
          {t.statusReason && <div className="small">사유: {t.statusReason}{t.statusChangedAt && <> · <Instant iso={t.statusChangedAt} /></>}</div>}</dd>
        {t.orgClass === "RIGHTS" && <><dt>정합성 차단</dt><dd>{t.validationEnforced ? "적용(차단 이슈가 있으면 정책·팩 활성화를 막는다)" : "경고만"}</dd></>}
        <dt>등록</dt><dd><Instant iso={t.createdAt} /></dd>
      </dl>
      {t.required && (
        <>
          <h3 style={{ margin: "16px 0 6px" }}>확인 항목(KYB)</h3>
          <table className="data">
            <thead><tr><th>항목</th><th>필요한 단계</th><th>확인</th>{editable && <th></th>}</tr></thead>
            <tbody>{items.map((i) => {
              const c = have.get(i);
              return (
                <tr key={i}>
                  <td>{CHECK_LABEL[i] ?? i}</td>
                  <td>{t.required!.VERIFIED.includes(i) ? "확인됨" : "활성"}</td>
                  <td>{c ? <><span className="badge ok">확인</span> <span className="muted small">{c.checkedBy} · <Instant iso={c.checkedAt} />{c.note && <> · {c.note}</>}{c.documentId && <> · 문서 <code>{c.documentId}</code></>}</span></> : <span className="badge warn">미확인</span>}</td>
                  {editable && <td><button type="button" className="btn tiny" disabled={t.status === "TERMINATED"} onClick={() => void act(() => api("PUT", `/tenants/${t.tenantId}/checks/${i}`, { checked: !c }))}>{c ? "해제" : "확인"}</button></td>}
                </tr>
              );
            })}</tbody>
          </table>
        </>
      )}
      {editable && t.next.length > 0 && (
        <div className="stack" style={{ marginTop: 12 }}>
          <h3 style={{ margin: "8px 0 0" }}>상태 바꾸기</h3>
          <label className="field" style={{ maxWidth: 520 }}><span>사유(정지·재개·해지는 필수)</span><input aria-label="상태 변경 사유" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="row-actions">
            {t.next.map((to) => {
              const m = to === "VERIFIED" || (to === "ACTIVE" && t.status !== "SUSPENDED") ? missing(to as "VERIFIED" | "ACTIVE") : [];
              return (
                <button key={to} type="button" className={`btn${to === "TERMINATED" || to === "SUSPENDED" ? " danger" : " primary"}`}
                  disabled={m.length > 0 || (needsReason(to) && reason.trim() === "")}
                  title={m.length > 0 ? `먼저 확인: ${m.map((x) => CHECK_LABEL[x] ?? x).join(", ")}` : undefined}
                  onClick={() => void act(() => api("POST", `/tenants/${t.tenantId}/status`, { status: to, ...(reason.trim() && { reason: reason.trim() }) }))}>
                  {t.status === "SUSPENDED" && to === "ACTIVE" ? "재개" : `${STATUS_LABEL[to]}(으)로`}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <ErrorPanel error={err} />
    </>
  );
}

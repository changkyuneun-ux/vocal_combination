import { Link } from "react-router";
import { authorsPending } from "../model.ts";
import { useGet } from "../../../api/hooks.ts";
import { activatePack } from "../../../api/issuance.ts";
import { activateVersion, approveVersion } from "../../../api/policy.ts";
import type { Contract } from "../../../api/contracts.ts";
import type { PolicyVersionDetail } from "../../../api/types.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { useMe, useReadiness, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";
import { ReleaseSteps, usePackAndPolicy } from "./Policy.tsx";

type Cond = { ok: boolean | "warn"; label: string; note: string };
const at = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : "");

/**
 * 승인·출시 탭(시안 Song-Release.dc.html): 출시 단계 · 승인 흐름(4칸: 컴파일 · 승인 · 활성화 · 출시, 단계별 서명) · 출시 조건, 오른쪽 "출시하면".
 * 조건이 안 되면 버튼을 막고 이유를 툴팁과 문장으로 보인다.
 */
export function ReleaseTab({ ctx }: { ctx: WsCtx }) {
  const { pack, policy, error } = usePackAndPolicy(ctx.scopeId);
  const version = policy?.latestVersion;
  const pv = useGet<PolicyVersionDetail>(["policy-version", policy?.policyId, version], `/policies/${encodeURIComponent(policy?.policyId ?? "")}/versions/${version ?? 0}`, { enabled: !!policy });
  const contracts = useGet<Contract[]>(["work-contracts", ctx.scopeId], `/contracts?scope=${encodeURIComponent(ctx.scopeId)}`);
  const ready = useReadiness(ctx.scopeId);
  const { me } = useMe();
  const w = useWrite();
  const d = pv.data;
  const item = (k: string) => ready.data?.items.find((i) => i.key === k);
  const blocksOk = item("blocks")?.ok === true;
  const tenantActive = me?.tenantStatus === undefined || me.tenantStatus === "ACTIVE";
  const approved = d !== undefined && (d.status === "APPROVED" || d.status === "ACTIVE");
  const active = d?.status === "ACTIVE";
  const released = pack?.status === "ACTIVE";
  const org = me?.memberships?.find((m) => m.tenantId === me.tenantId)?.name ?? "테넌트";
  const licenses = (contracts.data ?? []).filter((c) => c.status === "COMPLETED" && (c.templateId === "tpl_work_license" || c.templateId === "tpl_master_license"));
  const conds: Cond[] = [
    { ok: blocksOk, label: `정합성 점검 차단 ${(item("blocks")?.detail.match(/\d+/) ?? ["0"])[0]}`, note: blocksOk ? "" : "차단을 먼저 푼다" },
    { ok: tenantActive, label: `${org} 테넌트 활성`, note: tenantActive ? "권리 보유 증빙 확인됨" : `지금 ${me?.tenantStatus ?? "—"} — 운영이 권리 보유 증빙을 확인하면 활성` },
    { ok: approved, label: "분배 규칙 승인", note: "승인 뒤 활성화" },
    { ok: item("consents")?.ok ?? "warn", label: `멤버 팬앱 이용 동의 ${(item("consents")?.detail ?? "").replace("보이스 ", "").replace(" 동의", "")}`, note: "없으면 그 멤버 스템 발행 거부" },
    { ok: licenses.length > 0 ? true : "warn", label: "작품·녹음 이용허락 반영", note: `작품 ${licenses.filter((c) => c.templateId === "tpl_work_license").length} · 녹음 ${licenses.filter((c) => c.templateId === "tpl_master_license").length}` },
    { ok: item("audio")?.ok ?? "warn", label: `스템 오디오 ${item("audio")?.detail ?? ""}`, note: "" },
    { ok: item("confirmations")?.ok ?? "warn", label: authorsPending(ctx) > 0 ? `확인 대기 ${authorsPending(ctx)}(작가 지분 서명)` : item("confirmations")?.detail ?? "확인 대기", note: "기한이 지나면 차단" },
  ];
  const sig = (role: string) => d?.approvals.filter((a) => a.role === role) ?? [];
  const who = (role: string) => sig(role).map((a) => `${a.userId} · 서명 ${role}`).join(", ") || `서명 ${role}`;
  const activateWhy = !approved ? "먼저 승인한다" : !blocksOk ? "정합성 점검 차단이 남아 있다" : !tenantActive ? "테넌트가 아직 활성이 아니다" : "";
  const releaseWhy = !active ? "분배 규칙을 먼저 활성화한다" : !tenantActive ? "테넌트가 아직 활성이 아니다" : "";
  const step = !d ? 2 : !approved ? 3 : !active ? 4 : released ? 6 : 5;
  if (!pack || !policy) {
    return <><ReleaseSteps now={!pack ? 1 : 2} /><p className="p-sub">아직 컴파일한 분배 규칙이 없습니다. <Link to={`/works/${encodeURIComponent(ctx.work.workId)}/policy`}>분배 규칙·팩</Link>에서 팩을 만들고 컴파일한다.</p><ErrorPanel error={error} /></>;
  }
  const box = (i: number) => (i < step - 2 ? { background: "var(--p-accent-soft)", border: "1px solid var(--p-accent-line)" } : i === step - 2 ? { background: "var(--p-surface)", border: "2px solid var(--p-accent)" } : { background: "var(--p-bg)", border: "1px dashed var(--p-input-line)" });
  const flow: [string, string, string][] = [
    ["컴파일 · IR 생성", who("EDITOR"), `${at(d?.createdAt)} · facts · 정책 digest 고정`],
    ["승인", who("WORK_APPROVER"), "규칙 내용·미리보기 확인 뒤"],
    ["활성화", who("ACTIVATOR"), d?.activatedAt ? at(d.activatedAt) : "정합성 차단 0 · 테넌트 활성 필요"],
    ["출시(팩 활성화)", `팩 ${pack.packCode}`, released ? "출시됨 — 팬앱에서 조합·구매 중" : "팬앱에서 조합·구매 시작"],
  ];
  return (
    <>
      <ReleaseSteps now={step} />
      <div className="p-cols">
        <div className="main" style={{ gap: 14 }}>
          <section className="p-card">
            <div className="p-card-head"><h2>승인 흐름 — 분배 규칙 {policy.policyId} v{version}</h2><span className="p-badge sm warn" title="직무 분리 설정 조회 API가 없어 운영 설정을 따른다">직무 분리는 운영 설정 — 서명은 단계별로 남음</span></div>
            <ErrorPanel error={error ?? pv.error ?? w.err} />
            <div style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
              {flow.map(([t, s, n], i) => (
                <div key={t} style={{ padding: "12px 14px", borderRadius: 10, display: "flex", flexDirection: "column", gap: 4, fontSize: 14, ...box(i) }}>
                  <b>{t}</b><span style={{ fontSize: 13, color: "var(--p-fg-2)" }}>{s}</span><span style={{ fontSize: 12, color: "var(--p-muted)" }}>{n}</span>
                </div>
              ))}
            </div>
            <div className="p-row" style={{ padding: "0 16px 14px", justifyContent: "flex-end" }}>
              {w.notice && <span className="p-sub" role="status" style={{ marginRight: "auto" }}>{w.notice}</span>}
              {!approved && <>
                <button type="button" className="p-btn mid" disabled title="반려(새 초안) API가 없다 — 분배 규칙·팩에서 고쳐 다시 컴파일한다">반려(초안으로)</button>
                <button type="button" className="p-btn mid primary" disabled={!ctx.can("policy.approve") || w.busy} title={ctx.can("policy.approve") ? undefined : "분배 규칙 승인 권한이 필요하다"} onClick={() => void w.run(() => approveVersion(policy.policyId, version!), "승인했습니다")}>승인</button>
              </>}
              {approved && !active && <button type="button" className="p-btn mid primary" disabled={!ctx.can("policy.activate") || activateWhy !== "" || w.busy} title={activateWhy || (ctx.can("policy.activate") ? undefined : "활성화 권한이 필요하다")} onClick={() => void w.run(() => activateVersion(policy.policyId, version!), "분배 규칙을 활성화했습니다")}>활성화</button>}
              {active && <button type="button" className="p-btn mid primary" disabled={released || !ctx.can("pack.activate") || releaseWhy !== "" || w.busy} title={released ? "출시됨" : releaseWhy || (ctx.can("pack.activate") ? undefined : "팩 활성화 권한이 필요하다")} onClick={() => void w.run(() => activatePack(pack.packId), "출시했습니다 — 팬앱에서 조합·구매 시작")}>{released ? "출시됨" : "출시(팩 활성화)"}</button>}
            </div>
            {approved && !active && activateWhy !== "" && <div className="p-card-foot p-warn" role="note" style={{ fontSize: 13 }}>활성화할 수 없다: {activateWhy}</div>}
            {active && !released && releaseWhy !== "" && <div className="p-card-foot p-warn" role="note" style={{ fontSize: 13 }}>출시할 수 없다: {releaseWhy}</div>}
          </section>
          <section className="p-card">
            <div className="p-card-head"><h2>출시 조건 — 활성화·출시 버튼이 열리는 조건</h2></div>
            <div style={{ padding: "4px 16px 12px" }} role="list" aria-label="출시 조건">
              {conds.map((c) => (
                <div key={c.label} role="listitem" style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: "1px solid var(--p-head-bg)", fontSize: 14 }}>
                  <span className={c.ok === true ? "p-ok" : "p-warn"} style={{ fontWeight: 700, width: 14 }}>{c.ok === true ? "✓" : "!"}</span>
                  <span style={{ flex: "1 1 auto" }}>{c.label}</span><span className="p-todo" style={{ fontSize: 13 }}>{c.note}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside className="p-box" aria-labelledby="rel" style={{ flex: "1 1 380px", maxWidth: 440, gap: 10 }}>
          <h2 id="rel" style={{ margin: 0, fontSize: 18 }}>출시하면</h2>
          <div>· 팬앱에서 {ctx.work.title} 보컬 조합을 고르고 사고 들을 수 있다</div>
          <div>· 조합은 슬롯·파트마다 스템을 바꾼 배치이고, 발행되면 그 순간의 IR(facts·정책·조합 지분·멤버)이 봉인된다</div>
          <div>· 발행 승인 대기는 없다 — 게이트를 통과하면 바로 봉인(결정 MD8, 72시간 승인 큐는 상용 단계)</div>
          <div>· 플랫폼은 승인하지 않는다(TR5). 플랫폼은 관제·정산만</div>
          <div style={{ paddingTop: 10, borderTop: "1px solid var(--p-line)", display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--p-fg-2)" }}>
            <b style={{ fontSize: 14, color: "var(--p-fg)" }}>출시 뒤 관리</b>
            <span title="팩 일시정지 API가 포털에 없다(운영 화면에서)">일시정지 — 새 발행을 멈춘다(이미 발행된 조합은 정책대로)</span>
            <span>권리가 바뀌면 — 원곡 권리에서 새 버전 → 분배 규칙 재고정 → 다음 발행부터</span>
            <span>멤버 동의 철회 — 그 멤버 스템이 든 조합 노출 중지(자동)</span>
          </div>
        </aside>
      </div>
    </>
  );
}


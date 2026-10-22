import { Link } from "react-router";
import { useGet } from "../../../api/hooks.ts";
import { activatePack } from "../../../api/issuance.ts";
import { activateVersion, approveVersion } from "../../../api/policy.ts";
import type { PolicyVersionDetail } from "../../../api/types.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Section } from "../../../components/Section.tsx";
import { ReadyMark, useMe, useReadiness, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";
import { ReleaseSteps, usePackAndPolicy } from "./Policy.tsx";

type Cond = { ok: boolean | "warn"; label: string; note: string };

/**
 * 승인·출시 탭(시안 Song-Release, P6): 컴파일 · 승인 · 활성화 · 출시(팩 활성화) 흐름과 단계별 서명, 출시 조건.
 * 조건이 안 되면 버튼을 막고 이유를 보인다. 반려(새 초안)·일시정지는 코어 API가 없어 이 화면에 없다.
 */
export function ReleaseTab({ ctx }: { ctx: WsCtx }) {
  const { pack, policy, error } = usePackAndPolicy(ctx.scopeId);
  const version = policy?.latestVersion;
  const pv = useGet<PolicyVersionDetail>(["policy-version", policy?.policyId, version], `/policies/${encodeURIComponent(policy?.policyId ?? "")}/versions/${version ?? 0}`, { enabled: !!policy });
  const ready = useReadiness(ctx.scopeId);
  const { me } = useMe();
  const w = useWrite();
  const d = pv.data;
  const item = (k: string) => ready.data?.items.find((i) => i.key === k);
  const blocksOk = item("blocks")?.ok === true;
  const tenantActive = me?.tenantStatus === undefined ? true : me.tenantStatus === "ACTIVE";
  const approved = d !== undefined && (d.status === "APPROVED" || d.status === "ACTIVE");
  const active = d?.status === "ACTIVE";
  const released = pack?.status === "ACTIVE";
  const conds: Cond[] = [
    { ok: blocksOk, label: "정합성 점검 차단 0", note: item("blocks")?.detail ?? "—" },
    { ok: tenantActive, label: "테넌트 활성", note: tenantActive ? "권리 보유 증빙 확인됨" : `지금 ${me?.tenantStatus ?? "—"} — 운영이 권리 보유 증빙을 확인하면 활성` },
    { ok: approved, label: "분배 규칙 승인", note: approved ? "승인됨" : "승인 뒤 활성화" },
    { ok: item("consents")?.ok ?? "warn", label: "멤버 팬앱 이용 동의", note: item("consents")?.detail ?? "—" },
    { ok: item("audio")?.ok ?? "warn", label: "스템 오디오", note: item("audio")?.detail ?? "—" },
    { ok: item("confirmations")?.ok ?? "warn", label: "확인 대기", note: `${item("confirmations")?.detail ?? "—"} · 기한이 지나면 차단` },
  ];
  const sig = (role: string) => d?.approvals.filter((a) => a.role === role) ?? [];
  const activateWhy = !approved ? "먼저 승인한다" : !blocksOk ? "정합성 점검 차단이 남아 있다" : !tenantActive ? "테넌트가 아직 활성이 아니다" : "";
  const releaseWhy = !active ? "분배 규칙을 먼저 활성화한다" : !tenantActive ? "테넌트가 아직 활성이 아니다" : "";
  const step = !d ? 2 : !approved ? 3 : !active ? 4 : released ? 6 : 5;
  if (!pack || !policy) {
    return <><ReleaseSteps now={!pack ? 1 : 2} /><p className="muted">아직 컴파일한 분배 규칙이 없습니다. <Link to={`/works/${encodeURIComponent(ctx.work.workId)}/policy`}>분배 규칙·팩</Link>에서 팩을 만들고 컴파일한다.</p><ErrorPanel error={error} /></>;
  }
  return (
    <>
      <ReleaseSteps now={step} />
      <div className="ws-grid">
        <div>
          <Section title={`승인 흐름 — 분배 규칙 ${policy.policyId} v${version}`}>
            <p className="muted small">직무 분리 설정은 운영이 관리한다(이 화면은 조회만). 서명은 단계별로 남는다.</p>
            <ErrorPanel error={error ?? pv.error ?? w.err} />
            {w.notice && <p role="status" className="muted">{w.notice}</p>}
            <div className="kpis">
              <div className="kpi"><div className="label">컴파일 · IR 생성</div><div className="value" style={{ fontSize: 15 }}>{d ? <>{d.createdBy} · <Instant iso={d.createdAt} /></> : "—"}</div><div className="note">facts 고정 · 정책 digest</div></div>
              <div className="kpi"><div className="label">승인</div><div className="value" style={{ fontSize: 15 }}>{sig("WORK_APPROVER").map((a) => a.userId).join(", ") || "대기"}</div><div className="note">규칙 내용·미리보기 확인 뒤</div></div>
              <div className="kpi"><div className="label">활성화</div><div className="value" style={{ fontSize: 15 }}>{d?.activatedAt ? <Instant iso={d.activatedAt} /> : "대기"}</div><div className="note">정합성 차단 0 · 테넌트 활성 필요</div></div>
              <div className="kpi"><div className="label">출시(팩 활성화)</div><div className="value" style={{ fontSize: 15 }}>{released ? "출시됨" : "대기"}</div><div className="note">팩 {pack.packCode}</div></div>
            </div>
            <div className="row-actions">
              {ctx.can("policy.approve") && <button type="button" className="btn" disabled={!d || approved || w.busy} onClick={() => void w.run(() => approveVersion(policy.policyId, version!), "승인했습니다")}>{approved ? "승인됨" : "승인"}</button>}
              {ctx.can("policy.activate") && <button type="button" className="btn" disabled={active || activateWhy !== "" || w.busy} title={activateWhy || undefined} onClick={() => void w.run(() => activateVersion(policy.policyId, version!), "분배 규칙을 활성화했습니다")}>{active ? "활성화됨" : "활성화"}</button>}
              {ctx.can("pack.activate") && <button type="button" className="btn primary" disabled={released || releaseWhy !== "" || w.busy} title={releaseWhy || undefined} onClick={() => void w.run(() => activatePack(pack.packId), "출시했습니다 — 팬앱에서 조합·구매 시작")}>{released ? "출시됨" : "출시(팩 활성화)"}</button>}
            </div>
            {!active && activateWhy !== "" && approved && <p className="error-text" role="note">활성화할 수 없다: {activateWhy}</p>}
            {active && !released && releaseWhy !== "" && <p className="error-text" role="note">출시할 수 없다: {releaseWhy}</p>}
          </Section>
          <Section title="출시 조건 — 활성화·출시 버튼이 열리는 조건">
            <ul className="plain" aria-label="출시 조건">{conds.map((c) => <li key={c.label}><ReadyMark ok={c.ok} /> <b>{c.label}</b> <span className="muted small">{c.note}</span></li>)}</ul>
          </Section>
        </div>
        <aside className="note-box" aria-label="출시하면">
          <strong>출시하면</strong>
          <span>· 팬앱에서 이 곡의 보컬 조합을 고르고 사고 들을 수 있다</span>
          <span>· 조합은 슬롯·파트마다 스템을 바꾼 배치이고, 발행되면 그 순간의 IR(facts·정책·조합 지분·멤버)이 봉인된다</span>
          <span>· 발행 승인 대기는 없다 — 게이트를 통과하면 바로 봉인(결정 MD8)</span>
          <span>· 플랫폼은 승인하지 않는다(TR5). 플랫폼은 관제·정산만</span>
          <strong>출시 뒤 관리</strong>
          <span>권리가 바뀌면 — 원곡 권리에서 새 버전 → 분배 규칙 재고정 → 다음 발행부터</span>
          <span>멤버 동의 철회 — 그 멤버 스템이 든 조합 노출 중지(자동)</span>
        </aside>
      </div>
    </>
  );
}

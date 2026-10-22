import type { ReactNode } from "react";
import { Link, NavLink, useParams } from "react-router";
import type { WorkFacts, WorkOverview } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { currentClaims, slotPartRows, type PartRow } from "./model.ts";
import { ReadyMark, useFacts, useMe, useParties, useReadiness, useWork } from "./data.tsx";
import { RightsTab } from "./tabs/Rights.tsx";
import { StemsTab } from "./tabs/Stems.tsx";
import { ConfirmTab } from "./tabs/Confirm.tsx";
import { ContractsTab } from "./tabs/Contracts.tsx";
import { PolicyTab } from "./tabs/Policy.tsx";
import { ReleaseTab } from "./tabs/Release.tsx";

/** 워크스페이스 탭이 같이 쓰는 곡 맥락. */
export type WsCtx = {
  work: WorkOverview; scopeId: string; facts: WorkFacts; rows: PartRow[]; names: Map<string, string>; name: (p: string) => string;
  sealed: boolean; can: (perm: string) => boolean; recordingId: string | null;
  /** 이 곡의 멤버(보이스 소유자와 파트 원곡 담당), 등록 순. */
  members: { partyId: string; name: string }[];
  now: string;
};

export const WS_TABS = [["rights", "원곡 권리"], ["stems", "스템"], ["confirm", "확인·동의"], ["contracts", "문서·계약"], ["policy", "분배 규칙·팩"], ["release", "승인·출시"]] as const;
/** 워크스페이스 탭 → 작품 목록 하단 요약 탭(돌아갈 때 그대로 연다). */
const BACK_TAB: Record<string, string> = { rights: "rights", stems: "stems", confirm: "confirm", contracts: "docs", policy: "policy", release: "policy" };

export function membersOf(facts: WorkFacts, names: Map<string, string>): { partyId: string; name: string }[] {
  const ids: string[] = [];
  // 원곡에서 처음 부른 순서(슬롯 → 파트) 다음에 보이스만 있는 멤버.
  for (const r of slotPartRows(facts.slots)) if (r.original && !ids.includes(r.original)) ids.push(r.original);
  for (const c of currentClaims(facts.claims)) if (c.edge === "OWNED_BY" && !ids.includes(c.targetId)) ids.push(c.targetId);
  return ids.map((partyId) => ({ partyId, name: names.get(partyId) ?? partyId }));
}

/**
 * 곡 워크스페이스(시안 Song-*): 작품 목록 복귀, IR 생성 준비 띠, 제목·녹음·IR 상태, 탭 6개(+ 변경 기록은 다음 단계).
 * IR 생성 전에는 등록·조회·수정, 생성 뒤에는 조회만(바로잡기는 새 버전).
 */
export function Workspace() {
  const { workId = "", tab = "rights" } = useParams();
  const { work, ...o } = useWork(workId);
  const scopeId = work?.scopeId ?? null;
  const facts = useFacts(scopeId);
  const ready = useReadiness(scopeId);
  const parties = useParties();
  const { can } = useMe();
  if (o.isLoading) return <p className="muted">불러오는 중…</p>;
  if (!work) return <><ErrorPanel error={o.error} /><p>작품 <code>{workId}</code>을 찾을 수 없습니다. <Link to="/works">작품 목록</Link></p></>;
  const sealed = work.sealed;
  const f = facts.data;
  const rec = f?.recordings[0];
  const ctx: WsCtx | null = f && scopeId ? {
    work, scopeId, facts: f, rows: slotPartRows(f.slots), names: parties.names, name: (p) => parties.names.get(p) ?? p, sealed, can,
    recordingId: rec?.recordingId ?? null, members: membersOf(f, parties.names), now: new Date().toISOString(),
  } : null;
  const body: Record<string, (c: WsCtx) => ReactNode> = {
    rights: (c) => <RightsTab ctx={c} />, stems: (c) => <StemsTab ctx={c} />, confirm: (c) => <ConfirmTab ctx={c} />,
    contracts: (c) => <ContractsTab ctx={c} />, policy: (c) => <PolicyTab ctx={c} />, release: (c) => <ReleaseTab ctx={c} />,
  };
  return (
    <>
      <div className="crumb"><Link to={`/works?sel=${encodeURIComponent(workId)}&tab=${BACK_TAB[tab] ?? "overview"}`}>← 작품 목록</Link><span>작품 › {work.title}</span></div>
      {sealed ? (
        <div className="ready-strip" role="status"><strong>IR 생성됨</strong><span>facts·정책 digest 고정</span><span>원곡 권리·스템은 조회만(바로잡기는 새 버전)</span></div>
      ) : (
        <div className="ready-strip" role="status" aria-label="IR 생성 준비">
          <strong>IR 생성 준비</strong>
          {(ready.data?.items ?? []).map((i) => <span key={i.key} title={i.detail}><ReadyMark ok={i.ok} /> {i.label} · {i.detail}</span>)}
        </div>
      )}
      <div className="page-head">
        <div><h1>{work.title}</h1><div className="muted small">녹음 {rec?.versionTitle ?? "없음"}{rec ? ` · ${parties.names.get(rec.masterOwnerPartyId) ?? rec.masterOwnerPartyId}` : ""}</div></div>
        <span className={`badge ${sealed ? "info" : "ok"}`} aria-label="IR 상태">
          {sealed ? <>IR 생성됨 · <Instant iso={work.sealedThrough} /> — 권리 정보 조회만</> : "IR 생성 전 — 등록·조회·수정 가능"}
        </span>
      </div>
      <nav className="tabs" aria-label="워크스페이스 탭">
        {WS_TABS.map(([k, l]) => <NavLink key={k} to={`/works/${encodeURIComponent(workId)}/${k}`} aria-current={tab === k ? "page" : undefined}>{l}</NavLink>)}
        <span className="tab disabled" aria-disabled="true" title="감사 로그 연결은 다음 단계">변경 기록</span>
      </nav>
      <ErrorPanel error={facts.error ?? ready.error} />
      {!scopeId ? <p className="muted">이 곡에는 권리 범위가 없습니다. 새 곡 마법사로 범위·녹음을 만듭니다.</p>
        : !ctx ? <p className="muted">불러오는 중…</p> : (body[tab] ?? body.rights!)(ctx)}
    </>
  );
}

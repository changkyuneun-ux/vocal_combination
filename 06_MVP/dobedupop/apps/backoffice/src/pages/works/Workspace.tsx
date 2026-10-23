import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { ReadinessItem, WorkFacts, WorkOverview } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { currentClaims, slotPartRows, type PartRow } from "./model.ts";
import { useFacts, useMe, useParties, useReadiness, useWork } from "./data.tsx";
import { RightsTab } from "./tabs/Rights.tsx";
import { StemsTab } from "./tabs/Stems.tsx";
import { ConfirmTab } from "./tabs/Confirm.tsx";
import { ContractsTab } from "./tabs/Contracts.tsx";
import { PolicyTab } from "./tabs/Policy.tsx";
import { ReleaseTab } from "./tabs/Release.tsx";
import { ContractImportTab } from "./tabs/ContractImport.tsx";
import { ClaimConfirmTab } from "./tabs/ClaimConfirm.tsx";
import { usePackAndPolicy } from "./tabs/Policy.tsx";

/** 워크스페이스 탭이 같이 쓰는 곡 맥락. */
export type WsCtx = {
  work: WorkOverview; scopeId: string; facts: WorkFacts; rows: PartRow[]; names: Map<string, string>; name: (p: string) => string;
  sealed: boolean; can: (perm: string) => boolean; recordingId: string | null;
  /** 이 곡의 멤버(보이스 소유자와 파트 원곡 담당), 등록 순. */
  members: { partyId: string; name: string }[];
  now: string;
};

/** 문서·계약 아래 화면(시안 Song-Import·Song-ClaimConfirm): 제목·설명·본문. */
const SUB_PAGES: Record<string, { title: string; desc: string; body: (c: WsCtx) => ReactNode }> = {
  import: { title: "계약서 불러오기", desc: "원본 계약서에서 권리 정보 후보를 채우고, IR에 필요한 것 중 빠진 것을 입력한 뒤 권리 확인서로 서명한다", body: (c) => <ContractImportTab ctx={c} /> },
  confirm: { title: "권리 확인서", desc: "불러온 계약서와 입력한 값으로 만든 표준 계약. 서명하면 권리 주장이 서명본을 근거로 바로 VERIFIED가 된다", body: (c) => <ClaimConfirmTab ctx={c} /> },
};

export const WS_TABS = [["rights", "원곡 권리"], ["stems", "스템"], ["confirm", "확인·동의"], ["contracts", "문서·계약"], ["policy", "분배 규칙·팩"], ["release", "승인·출시"]] as const;
/** 워크스페이스 탭 → 작품 목록 하단 요약 탭(돌아갈 때 그대로 연다). */

export function membersOf(facts: WorkFacts, names: Map<string, string>): { partyId: string; name: string }[] {
  const ids: string[] = [];
  // 원곡에서 처음 부른 순서(슬롯 → 파트) 다음에 보이스만 있는 멤버.
  for (const r of slotPartRows(facts.slots)) if (r.original && !ids.includes(r.original)) ids.push(r.original);
  for (const c of currentClaims(facts.claims)) if (c.edge === "OWNED_BY" && !ids.includes(c.targetId)) ids.push(c.targetId);
  // 원곡에서 맡은 보컬 파트가 많은 순, 같으면 처음 부른 순(시안 열 순서: 정국 · 지민 · 뷔 · 진 · RM · 제이홉 · 슈가).
  const parts = (p: string) => slotPartRows(facts.slots).filter((r) => r.kind === "VOCAL" && r.original === p).length;
  const seen = [...ids];
  ids.sort((a, b) => parts(b) - parts(a) || seen.indexOf(a) - seen.indexOf(b));
  return ids.map((partyId) => ({ partyId, name: names.get(partyId) ?? partyId }));
}

/**
 * 곡 워크스페이스(시안 Song-*): 작품 목록 복귀, IR 생성 준비 띠, 제목·녹음·IR 상태, 탭 6개(+ 변경 기록은 다음 단계).
 * IR 생성 전에는 등록·조회·수정, 생성 뒤에는 조회만(바로잡기는 새 버전).
 */
export function Workspace() {
  const { workId = "", tab = "rights", sub } = useParams();
  const subPage = tab === "contracts" && sub !== undefined ? SUB_PAGES[sub] : undefined;
  const { work, ...o } = useWork(workId);
  const scopeId = work?.scopeId ?? null;
  const facts = useFacts(scopeId);
  const ready = useReadiness(scopeId);
  const parties = useParties();
  const { can } = useMe();
  const pp = usePackAndPolicy(scopeId ?? "");
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
    <main className="p-main">
      {sealed ? (
        <div className="p-ready" role="status"><strong>IR v{pp.policy?.latestVersion ?? 1}</strong><span>facts · 정책 v{pp.policy?.latestVersion ?? 1} digest 고정</span><span className="p-todo">원곡 권리·스템은 조회만(바로잡기는 새 버전)</span></div>
      ) : (
        <div className="p-ready" role="status" aria-label="IR 생성 준비">
          <strong>IR 생성 준비</strong>
          {(ready.data?.items ?? []).map((i) => { const m = readyMark(i); return <span key={i.key} className={m.cls} title={i.detail}>{m.mark} {m.text}</span>; })}
        </div>
      )}
      <div className="p-title-row">
        {subPage ? <div><h1>{subPage.title}</h1><div className="p-desc">{subPage.desc}</div></div>
          : <div><h1>{work.title} · {WS_TABS.find(([k]) => k === tab)?.[1] ?? ""}</h1><div className="p-desc">녹음 {rec?.versionTitle ?? "없음"}{rec ? ` · ${parties.names.get(rec.masterOwnerPartyId) ?? rec.masterOwnerPartyId}` : ""}</div></div>}
        <span className={`p-badge lg ${sealed ? "ir" : "ok"}`} aria-label="IR 상태">
          {sealed ? `IR 생성됨 v${pp.policy?.latestVersion ?? 1} · ${(work.sealedThrough ?? "").slice(0, 16).replace("T", " ")} — 권리 정보 조회만` : "IR 생성 전 — 등록·조회·수정 가능"}
        </span>
      </div>
      <nav className="p-tabs" aria-label="워크스페이스 탭">
        {WS_TABS.map(([k, l]) => <Link key={k} to={`/works/${encodeURIComponent(workId)}/${k}`} aria-current={tab === k ? "page" : undefined}>{l}</Link>)}
        <span className="off" aria-disabled="true" title="곡 단위 감사 로그 조회가 없다 — 최근 변경은 원곡 권리 탭 오른쪽과 작품 목록의 변경 이력에">변경 기록</span>
      </nav>
      <ErrorPanel error={facts.error ?? ready.error} />
      {!scopeId ? <p className="p-sub">이 곡에는 권리 범위가 없습니다. 새 곡 마법사로 범위·녹음을 만듭니다.</p>
        : !ctx ? <p className="p-sub">불러오는 중…</p> : subPage ? subPage.body(ctx) : (body[tab] ?? body.rights!)(ctx)}
    </main>
  );
}

/** 준비 띠 한 칸(시안: ✓ 완료 · ! 확인 필요 · · 남은 일). 문구는 짧게. */
export function readyMark(i: ReadinessItem): { mark: string; cls: string; text: string } {
  const nums = (i.detail.match(/\d+/g) ?? []).map(Number);
  const text: Record<string, string> = {
    shares: i.ok === true ? "합계 100%" : `합계 ${i.detail}`,
    evidence: i.ok === true ? "근거 문서" : `근거 문서 ${nums[0] ?? ""}건 없음`,
    originalStems: i.ok === true ? `원곡 스템 ${nums[0] ?? ""}` : i.detail,
    confirmations: i.ok === true ? "확인 완료" : `확인 ${nums[0] ?? ""} 남음`,
    consents: `이용 동의 ${nums[0] ?? 0}/${nums[1] ?? 0}`,
    mandates: `위임 서명 ${nums[0] ?? 0}/${nums[1] ?? 0}`,
    audio: i.ok === true ? "오디오" : `오디오 ${nums[0] ?? ""} 검사 중`,
    blocks: `차단 ${nums[0] ?? 0}`,
  };
  const soft = ["consents", "mandates", "audio"].includes(i.key);
  return i.ok === true ? { mark: "✓", cls: "p-ok", text: text[i.key] ?? i.label }
    : soft ? { mark: "·", cls: "p-todo", text: text[i.key] ?? i.label } : { mark: "!", cls: "p-warn", text: text[i.key] ?? i.label };
}

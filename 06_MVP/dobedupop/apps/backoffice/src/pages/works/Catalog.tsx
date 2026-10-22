import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { WorkOverview } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { currentClaims, pctText, slotPartRows, stageBars, stageLabel, STAGES } from "./model.ts";
import { ReadyMark, useFacts, useMe, useOverview, useParties, useReadiness, WorkStatusBadge } from "./data.tsx";

const STATUS_TABS = ["전체", "입력 중", "확인 대기", "IR 생성됨", "판매 중", "분쟁·보류"] as const;
const PANEL_TABS = [["overview", "개요"], ["rights", "원곡 권리"], ["stems", "스템"], ["docs", "문서·계약"], ["confirm", "확인·동의"], ["policy", "분배 규칙·팩"], ["money", "정산"], ["history", "변경 이력"]] as const;
type PanelTab = (typeof PANEL_TABS)[number][0];
/** 하단 요약 탭 → 워크스페이스 탭 경로. */
export const MANAGE_TAB: Partial<Record<PanelTab, string>> = { rights: "rights", stems: "stems", docs: "contracts", confirm: "confirm", policy: "policy" };

export function StageBars({ stage }: { stage: number }) {
  return (
    <div>
      <div className="stage-bars" role="img" aria-label={`진행 ${STAGES.map((s, i) => `${s}${i < stage ? " 완료" : i === stage ? " 진행 중" : ""}`).join(", ")}`}>
        {stageBars(stage).map((s, i) => <span key={i} className={s} />)}
      </div>
      <div className="small muted">{stageLabel(stage)}</div>
    </div>
  );
}

const rightsText = (w: WorkOverview) => `작품 ${w.rights.work} · 녹음 ${w.rights.master} · 실연 ${w.rights.performers === 0 && w.slots === 0 ? "입력 전" : `슬롯 ${w.slots}·보컬 파트 ${w.vocalParts}`}`;

/** 지금 목록을 CSV로 내려받는다(엑셀 다운로드). */
function downloadCsv(rows: WorkOverview[]) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["관리번호", "곡명", "녹음", "작사·작곡", "원곡 권리", "스템", "확인 대기", "진행", "상태"];
  const body = rows.map((w) => [w.workId, w.title, w.recordingTitle ?? "", w.authors.join(" · "), rightsText(w), w.stems, w.pendingConfirmations, STAGES[w.stage], w.status].map(esc).join(","));
  const blob = new Blob([`﻿${[head.map(esc).join(","), ...body].join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "works.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 작품 목록(시작점, 시안 Catalog): 현황 숫자 · 상태 탭 · 검색 · 진행 5단계 막대. 행을 고르면 아래에 조회 전용 요약이 열리고,
 * 탭마다 "○○ 관리 →"로 그 곡의 워크스페이스 탭에 들어간다. 선택과 탭은 URL(?sel=&tab=)에 남아 워크스페이스에서 돌아오면 그대로다.
 */
export function WorksCatalog() {
  const o = useOverview();
  const { can } = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<(typeof STATUS_TABS)[number]>("전체");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"title" | "stage" | "id">("title");
  const works = o.data ?? [];
  const count = (s: string) => works.filter((w) => w.status === s).length;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const xs = works.filter((w) => (status === "전체" || w.status === status)
      && (needle === "" || [w.title, w.workId, w.recordingTitle ?? "", ...w.authors].some((s) => s.toLowerCase().includes(needle))));
    return [...xs].sort((a, b) => (sort === "stage" ? a.stage - b.stage : sort === "id" ? (a.workId < b.workId ? -1 : 1) : a.title.localeCompare(b.title, "ko")));
  }, [works, status, q, sort]);
  const selId = params.get("sel") ?? list[0]?.workId ?? "";
  const sel = works.find((w) => w.workId === selId);
  const tab = (params.get("tab") ?? "overview") as PanelTab;
  const pick = (patch: Record<string, string>) => setParams({ ...Object.fromEntries(params), ...patch }, { replace: true });
  const kpis = [
    { label: "전체 곡", value: works.length, note: "등록한 작품" },
    { label: "권리 입력 중", value: count("입력 중"), note: "원곡 권리·스템" },
    { label: "확인 대기", value: count("확인 대기"), note: `확인 요청 ${works.reduce((a, w) => a + w.pendingConfirmations, 0)}건` },
    { label: "IR 생성됨", value: count("IR 생성됨"), note: "분배 규칙 고정" },
    { label: "판매 중", value: count("판매 중"), note: "팩 활성" },
    { label: "분쟁·보류", value: count("분쟁·보류"), note: "처리 필요" },
  ];

  return (
    <>
      <div className="page-head">
        <div><div className="crumb">작품</div><h1>작품 관리</h1></div>
        <div className="row-actions">
          <button type="button" className="btn" disabled title="상용 단계(결정 ED1)">CSV 일괄 등록 · 상용</button>
          <button type="button" className="btn" onClick={() => downloadCsv(list)} disabled={list.length === 0}>엑셀 다운로드</button>
          {can("rights.edit") && <Link className="btn primary" to="/works/new">+ 새 곡 워크스페이스</Link>}
        </div>
      </div>
      <div className="kpis">
        {kpis.map((k) => <div key={k.label} className="kpi"><div className="label">{k.label}</div><div className="value">{k.value}</div><div className="note">{k.note}</div></div>)}
      </div>
      <div className="tabs" role="tablist" aria-label="진행 상태">
        {STATUS_TABS.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}>
            {s}<span className="count">{s === "전체" ? works.length : count(s)}</span>
          </button>
        ))}
      </div>
      <div className="inline-form">
        <label className="field"><span>작품 검색</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="곡명, 작사·작곡가, 관리번호, 녹음" />
        </label>
        <label className="field"><span>정렬</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="title">곡명순</option><option value="stage">진행 단계순</option><option value="id">관리번호순</option>
          </select>
        </label>
        <span className="muted small">검색 결과 <b>{list.length}</b>곡</span>
      </div>
      <ErrorPanel error={o.error} />
      {o.isLoading ? <p className="muted">불러오는 중…</p> : list.length === 0 ? <p className="muted">작품이 없습니다. "+ 새 곡 워크스페이스"로 시작합니다.</p> : (
        <table className="data" aria-label="작품 목록">
          <thead><tr>{["관리번호", "곡명 / 녹음", "작사·작곡", "원곡 권리", "멤버 스템", "확인 대기", "진행", "상태", "관리"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.workId} className={`clickable${w.workId === selId ? " selected" : ""}`} aria-selected={w.workId === selId} onClick={() => pick({ sel: w.workId })}>
                <td><code>{w.workId}</code></td>
                <td><div><b>{w.title}</b></div><div className="small muted">{w.recordingTitle ?? "녹음 없음"}</div></td>
                <td>{w.authors.join(" · ") || "—"}</td>
                <td>{rightsText(w)}</td>
                <td>{w.stems}</td>
                <td>{w.pendingConfirmations}</td>
                <td><StageBars stage={w.stage} /></td>
                <td><WorkStatusBadge status={w.status} /></td>
                <td><Link to={`/works/${encodeURIComponent(w.workId)}/rights`} onClick={(e) => e.stopPropagation()}>열기</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel && <SelectedWork w={sel} tab={tab} onTab={(t) => pick({ sel: sel.workId, tab: t })} onOpen={(t) => nav(`/works/${encodeURIComponent(sel.workId)}/${t}`)} />}
    </>
  );
}

type Card = { label: string; value: ReactNode; note?: string; tone?: "ok" | "warn" };
function Cards({ cards }: { cards: Card[] }) {
  return <div className="kpis">{cards.map((c) => <div key={c.label} className="kpi"><div className="label">{c.label}</div><div className="value" style={{ fontSize: 16 }}>{c.value}</div>{c.note && <div className={`note ${c.tone ?? ""}`}>{c.note}</div>}</div>)}</div>;
}

/** 선택한 작품의 조회 전용 요약(하단 패널). 등록·수정·삭제는 워크스페이스에서 한다. */
function SelectedWork({ w, tab, onTab, onOpen }: { w: WorkOverview; tab: PanelTab; onTab: (t: PanelTab) => void; onOpen: (t: string) => void }) {
  const facts = useFacts(w.scopeId);
  const ready = useReadiness(w.scopeId);
  const parties = useParties();
  const f = facts.data;
  const claims = f ? currentClaims(f.claims) : [];
  const rows = f ? slotPartRows(f.slots) : [];
  const name = (p: string) => parties.names.get(p) ?? p;
  const holders = (edge: string) => claims.filter((c) => c.edge === edge).map((c) => `${name(c.targetId)} ${pctText(c.shareBps)}`).join(" · ") || "없음";
  const pending = (edge: string) => claims.filter((c) => c.edge === edge && c.status === "ASSERTED").length;
  const vocal = rows.filter((r) => r.kind === "VOCAL"), group = rows.filter((r) => r.kind === "GROUP"), inst = rows.filter((r) => r.kind === "INSTRUMENT");
  const stems = f?.stems ?? [];
  const origStems = rows.filter((r) => stems.some((s) => s.slotId === r.slotId && s.partNo === r.partNo && (r.kind !== "VOCAL" || s.performerPartyId === r.original))).length;
  const extraStems = stems.filter((s) => vocal.some((r) => r.slotId === s.slotId && r.partNo === s.partNo && r.original !== s.performerPartyId)).length;
  const mandates = (f?.mandates ?? []).filter((m) => m.supersededAt === null && m.rightKind === "PERFORMER");
  const sealed = w.sealed;
  const cards: Record<Exclude<PanelTab, "overview" | "history">, Card[]> = {
    rights: [
      { label: "작품 · 작사·작곡", value: holders("WRITTEN_BY"), note: pending("WRITTEN_BY") > 0 ? `확인 대기 ${pending("WRITTEN_BY")}` : "확정", tone: pending("WRITTEN_BY") > 0 ? "warn" : "ok" },
      { label: "녹음 · 마스터", value: holders("CONTROLLED_BY"), note: pending("CONTROLLED_BY") > 0 ? `확인 대기 ${pending("CONTROLLED_BY")}` : "확정", tone: pending("CONTROLLED_BY") > 0 ? "warn" : "ok" },
      { label: "실연 · 슬롯별 담당", value: `슬롯 ${f?.slots.length ?? 0} · 보컬 파트 ${vocal.length}`, note: `보이스 소유 확인 ${claims.filter((c) => c.edge === "OWNED_BY" && c.status === "VERIFIED").length}/${claims.filter((c) => c.edge === "OWNED_BY").length}` },
      { label: "수령 위임", value: mandates.length === 0 ? "없음" : `${new Set(mandates.map((m) => m.fromPartyId)).size}명 → ${[...new Set(mandates.map((m) => name(m.toPartyId)))].join(", ")}`, note: `확정 ${mandates.filter((m) => m.status === "VERIFIED").length}/${mandates.length}` },
    ],
    stems: [
      { label: "슬롯 · 파트", value: `${f?.slots.length ?? 0} · 보컬 ${vocal.length} · 그룹 ${group.length} · 반주 ${inst.length}` },
      { label: "원곡 스템", value: `${origStems} / ${rows.length}`, tone: origStems < rows.length ? "warn" : "ok", note: origStems < rows.length ? "원곡 스템 없는 파트가 있다" : "모든 파트" },
      { label: "멤버 추가 녹음 스템", value: String(extraStems) },
      { label: "오디오 검수", value: ready.data?.items.find((i) => i.key === "audio")?.detail ?? "—" },
    ],
    docs: [{ label: "문서·계약", value: "워크스페이스에서", note: "표준 계약·원천 문서는 문서·계약 탭" }],
    confirm: [
      { label: "확인 요청", value: `대기 ${w.pendingConfirmations}`, tone: w.pendingConfirmations > 0 ? "warn" : "ok" },
      { label: "이용 동의", value: ready.data?.items.find((i) => i.key === "consents")?.detail ?? "—" },
    ],
    policy: [
      { label: "팩", value: w.pack ? w.pack.packId : "없음", note: w.pack?.status ?? "팩 만들기 전" },
      { label: "분배 규칙", value: w.activePolicy ? "활성" : sealed ? "컴파일됨(IR 생성)" : "컴파일 전", note: sealed ? "IR 생성됨" : "컴파일하면 IR 생성", tone: sealed ? "ok" : "warn" },
      { label: "출시", value: w.pack?.status === "ACTIVE" ? "판매 중" : "대기", note: "승인 → 활성화 → 팩 활성화" },
    ],
    money: [{ label: "정산", value: w.stage >= 4 ? "판매 중" : "—", note: "명세·지급은 점검·정산 메뉴" }],
  };
  const label = PANEL_TABS.find((t) => t[0] === tab)?.[1] ?? "개요";
  const manage = MANAGE_TAB[tab];
  return (
    <section className="section" aria-label="선택한 작품">
      <div className="section-head">
        <div>
          <div className="crumb"><code>{w.workId}</code><WorkStatusBadge status={w.status} /></div>
          <h2>{w.title}</h2>
          <div className="muted small">녹음 {w.recordingTitle ?? "없음"}</div>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="작품 상세">
        {PANEL_TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l}</button>)}
      </div>
      <div className="crumb" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span>{tab === "overview" ? "조회 전용 요약 — 관리할 탭을 고르면 그 탭의 워크스페이스로 들어간다"
          : `${label} 요약(조회 전용). 등록·수정·삭제는 워크스페이스에서${sealed ? " — IR 생성 뒤라 새 버전으로만" : " — IR 생성 전까지 가능"}`}</span>
        {manage && <button type="button" className="btn primary" onClick={() => onOpen(manage)}>{label} 관리 →</button>}
        {tab === "money" && <Link to="/statements">명세·지급 보기 →</Link>}
      </div>
      <ErrorPanel error={facts.error ?? ready.error} />
      {tab === "overview" ? (
        <div className="split">
          <dl className="kv">
            <dt>곡명</dt><dd>{w.title}</dd><dt>작사·작곡</dt><dd>{w.authors.join(" · ") || "—"}</dd><dt>녹음</dt><dd>{w.recordingTitle ?? "—"}</dd>
            <dt>원곡 권리</dt><dd>{rightsText(w)}</dd><dt>스템</dt><dd>{w.stems}</dd><dt>권리 범위</dt><dd><code>{w.scopeId ?? "없음"}</code></dd>
            <dt>IR</dt><dd>{w.sealedThrough ? <>생성됨 · <Instant iso={w.sealedThrough} /></> : "생성 전"}</dd>
          </dl>
          <div className="stack">
            <strong>진행</strong>
            <ol className="steps" aria-label="진행 단계">{STAGES.map((s, i) => <li key={s} className={i < w.stage ? "done" : i === w.stage ? "now" : ""}>{s} · {i < w.stage ? "완료" : i === w.stage ? "진행 중" : "대기"}</li>)}</ol>
            <strong>IR 생성 준비</strong>
            {!w.scopeId ? <p className="muted">권리 범위가 없다</p> : (
              <ul className="plain" aria-label="IR 생성 준비">{(ready.data?.items ?? []).map((i) => <li key={i.key}><ReadyMark ok={i.ok} /> {i.label} — {i.detail}</li>)}</ul>
            )}
          </div>
        </div>
      ) : tab === "history" ? (
        <p className="muted">변경 이력(감사 로그)은 다음 단계에서 연결한다.</p>
      ) : <Cards cards={cards[tab]} />}
    </section>
  );
}

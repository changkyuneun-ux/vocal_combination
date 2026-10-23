import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Contract } from "../../api/contracts.ts";
import { useGet } from "../../api/hooks.ts";
import type { ConfirmationRow, DocumentRow, WorkOverview } from "../../api/works.ts";
import type { IssueRow, Paged } from "../../api/types.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { currentClaims, pctText, recentChanges, slotPartRows, stageBars, stageLabel, STAGES } from "./model.ts";
import { useFacts, useMe, useOverview, useParties, useReadiness } from "./data.tsx";

const STATUS_TABS = ["전체", "입력 중", "확인 대기", "IR 생성됨", "판매 중", "분쟁·보류"] as const;
const PANEL_TABS = [["overview", "개요"], ["rights", "원곡 권리"], ["stems", "스템"], ["docs", "문서·계약"], ["confirm", "확인·동의"], ["policy", "분배 규칙·팩"], ["money", "정산"], ["history", "변경 이력"]] as const;
type PanelTab = (typeof PANEL_TABS)[number][0];
/** 하단 요약 탭 → 워크스페이스 탭 경로(시안 Catalog manageHref). */
export const MANAGE_TAB: Partial<Record<PanelTab, string>> = { rights: "rights", stems: "stems", docs: "contracts", confirm: "confirm", policy: "policy" };
export const STATUS_TONE: Record<string, string> = { "입력 중": "muted", "확인 대기": "warn", "IR 생성됨": "ir", "판매 중": "ok", "분쟁·보류": "bad" };
const NO_EDIT = "작품 정보 수정·삭제 화면은 아직 없다 — 곡 제목·녹음은 원곡 권리 탭, 삭제는 IR 생성 전 권리 범위·녹음을 먼저 지워야 한다(CATALOG_IN_USE)";

export function StatusPill({ status }: { status: string }) {
  return <span className={`p-badge ${STATUS_TONE[status] ?? "muted"}`}>{status}</span>;
}
export function StageBars({ stage }: { stage: number }) {
  return (
    <>
      <div className="p-bars" role="img" aria-label={`진행 ${stageLabel(stage)}`}>{stageBars(stage).map((s, i) => <span key={i} className={s} />)}</div>
      <div className="p-sub" style={{ fontSize: 12, marginTop: 4 }}>{stageLabel(stage)}</div>
    </>
  );
}
const rightsText = (w: WorkOverview) => `작품 ${w.rights.work} · 녹음 ${w.rights.master} · 실연 ${w.slots === 0 ? "입력 전" : `슬롯 ${w.slots}·보컬 파트 ${w.vocalParts}`}`;
const seats = (w: WorkOverview) => (w.parts === 0 ? "—" : String(w.vocalParts * w.members + (w.parts - w.vocalParts)));
const stemText = (w: WorkOverview) => `${w.stems} / ${seats(w)}`;

function downloadCsv(rows: WorkOverview[]) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["관리번호", "곡명", "녹음", "작사·작곡", "원곡 권리", "멤버 스템", "확인 대기", "진행", "상태"];
  const body = rows.map((w) => [w.workId, w.title, w.recordingTitle ?? "", w.authors.join(" · "), rightsText(w), stemText(w), w.pendingConfirmations, STAGES[w.stage], w.status].map(esc).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([`﻿${[head.map(esc).join(","), ...body].join("\n")}\n`], { type: "text/csv;charset=utf-8" }));
  a.download = "works.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 작품 목록(시안 Catalog.dc.html): 머리 · 현황 6 · 상태 탭 · 검색 줄 · 표 · 선택한 작품(조회 전용 요약, 탭별 "관리 →").
 * 선택과 탭은 URL(?sel=&tab=)에 남아 워크스페이스에서 돌아오면 그대로다.
 */
export function WorksCatalog() {
  const o = useOverview();
  const { can, me } = useMe();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<(typeof STATUS_TABS)[number]>("전체");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "stage">("recent");
  const works = o.data ?? [];
  const org = me?.memberships?.find((m) => m.tenantId === me.tenantId)?.name ?? "";
  const count = (s: string) => works.filter((w) => w.status === s).length;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const xs = works.filter((w) => (status === "전체" || w.status === status)
      && (needle === "" || [w.title, w.workId, w.recordingTitle ?? "", ...w.authors].some((s) => s.toLowerCase().includes(needle))));
    return sort === "recent" ? xs : [...xs].sort((a, b) => (sort === "stage" ? a.stage - b.stage : a.title.localeCompare(b.title, "ko")));
  }, [works, status, q, sort]);
  const selId = params.get("sel") ?? list[0]?.workId ?? "";
  const sel = works.find((w) => w.workId === selId);
  const tab = (params.get("tab") ?? "overview") as PanelTab;
  const pick = (patch: Record<string, string>) => setParams({ ...Object.fromEntries(params), ...patch }, { replace: true });
  const kpis = [
    { label: "전체 곡", value: works.length, note: `${org} 등록` },
    { label: "권리 입력 중", value: count("입력 중"), note: "원곡 권리·스템" },
    { label: "확인 대기", value: count("확인 대기"), note: `확인 요청 ${works.reduce((a, w) => a + w.pendingConfirmations, 0)}건` },
    { label: "IR 생성됨", value: count("IR 생성됨"), note: "분배 규칙 고정" },
    { label: "판매 중", value: count("판매 중"), note: "팩 활성" },
    { label: "분쟁·보류", value: count("분쟁·보류"), note: "처리 필요" },
  ];
  return (
    <div className="p-full">
      <div className="p-cat">
        <div className="p-pagehead">
          <div><div className="p-path">{org} / 작품</div><h1>작품 관리</h1></div>
          <div className="p-row">
            <button type="button" className="p-btn wide" disabled title="상용 단계(결정 ED1)">CSV 일괄 등록 · 상용</button>
            <button type="button" className="p-btn wide" onClick={() => downloadCsv(list)}>엑셀 다운로드</button>
            {can("rights.edit") ? <Link className="p-btn primary big" to="/works/new">+ 새 곡 워크스페이스</Link>
              : <button type="button" className="p-btn big" disabled title="권리 편집 권한이 필요하다">+ 새 곡 워크스페이스</button>}
          </div>
        </div>
        <div className="p-kpis">
          {kpis.map((k) => <div key={k.label} className="p-kpi"><div className="l">{k.label}</div><div className="v">{k.value}</div><div className="n">{k.note}</div></div>)}
        </div>
        <div className="p-tabs" role="tablist" aria-label="진행 상태">
          {STATUS_TABS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}>{s} <span className="cnt">{s === "전체" ? works.length : count(s)}</span></button>
          ))}
        </div>
        <div className="p-row">
          <label htmlFor="q" className="p-sr">작품 검색</label>
          <input id="q" className="p-input" style={{ flex: "1 1 320px", padding: "9px 12px" }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="곡명, 아티스트, 작사·작곡가, 관리번호, ISRC·ISWC" />
          <select aria-label="아티스트" className="p-select" disabled title="곡에 아티스트 항목이 아직 없다"><option>아티스트 전체</option></select>
          <select aria-label="정렬" className="p-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="recent">최근 등록순</option><option value="title">곡명순</option><option value="stage">진행 단계순</option>
          </select>
          <span className="p-sub" style={{ marginLeft: "auto" }}>검색 결과 <b style={{ color: "var(--p-fg)" }}>{list.length}</b>곡</span>
        </div>
      </div>
      <ErrorPanel error={o.error} />
      <div className="p-catbl">
        <table aria-label="작품 목록">
          <thead><tr>
            <th style={{ width: 36 }}><input type="checkbox" aria-label="전체 선택" /></th>
            {["관리번호", "곡명 / 아티스트", "작사·작곡", "원곡 권리", "멤버 스템", "확인 대기"].map((h) => <th key={h}>{h}</th>)}
            <th style={{ minWidth: 170 }}>진행</th><th>상태</th><th style={{ textAlign: "right" }}>관리</th>
          </tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.workId} className={w.workId === selId ? "sel" : ""} aria-selected={w.workId === selId} onClick={() => pick({ sel: w.workId })}>
                <td><input type="checkbox" aria-label="선택" onClick={(e) => e.stopPropagation()} /></td>
                <td className="p-mono" style={{ fontSize: 13, color: "var(--p-muted)", whiteSpace: "nowrap" }}>{w.workId}</td>
                <td><div style={{ fontWeight: 600 }}>{w.title}</div><div className="p-sub" style={{ fontSize: 12 }}>{w.recordingTitle ?? "—"}</div></td>
                <td>{w.authors.join(" · ") || "—"}</td>
                <td>{rightsText(w)}</td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{stemText(w)}</td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{w.pendingConfirmations}</td>
                <td><StageBars stage={w.stage} /></td>
                <td><StatusPill status={w.status} /></td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <Link to={`/works/${encodeURIComponent(w.workId)}/rights`} onClick={(e) => e.stopPropagation()}>열기</Link> · <button type="button" className="p-linkbtn" disabled title={NO_EDIT}>수정</button> · <button type="button" className="p-linkbtn" disabled title={NO_EDIT}>삭제</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={10} className="p-sub">{o.isLoading ? "불러오는 중…" : "작품이 없습니다."}</td></tr>}
          </tbody>
        </table>
      </div>
      {sel && <SelectedWork w={sel} org={org} tab={tab} onTab={(t) => pick({ sel: sel.workId, tab: t })} />}
    </div>
  );
}

type Card = { label: string; value: ReactNode; note?: string; tone?: "ok" | "warn" | "" };

/** 선택한 작품(시안 Catalog 하단): 조회 전용 요약. 등록·수정·삭제는 워크스페이스에서. */
function SelectedWork({ w, org, tab, onTab }: { w: WorkOverview; org: string; tab: PanelTab; onTab: (t: PanelTab) => void }) {
  const facts = useFacts(w.scopeId);
  const ready = useReadiness(w.scopeId);
  const parties = useParties();
  const contracts = useGet<Contract[]>(["work-contracts", w.scopeId], `/contracts?scope=${encodeURIComponent(w.scopeId ?? "")}`, { enabled: !!w.scopeId });
  const docs = useGet<DocumentRow[]>(["documents"], "/documents");
  const confs = useGet<ConfirmationRow[]>(["work-confirmations"], "/confirmations");
  const issues = useGet<Paged<IssueRow>>(["work-issues", w.pack?.packId], `/issues?limit=200`, { enabled: !!w.pack });
  const f = facts.data;
  const claims = f ? currentClaims(f.claims) : [];
  const rows = f ? slotPartRows(f.slots) : [];
  const name = (p: string) => parties.names.get(p) ?? p;
  const holders = (edge: string) => claims.filter((c) => c.edge === edge).map((c) => `${name(c.targetId)} ${c.shareBps / 100}`).join(" · ") || "없음";
  const asserted = (edge: string) => claims.filter((c) => c.edge === edge && c.status === "ASSERTED").length;
  const vocal = rows.filter((r) => r.kind === "VOCAL");
  const stems = f?.stems ?? [];
  const origStems = rows.filter((r) => stems.some((s) => s.slotId === r.slotId && s.partNo === r.partNo && (r.kind !== "VOCAL" || s.performerPartyId === r.original))).length;
  const extraStems = stems.filter((s) => vocal.some((r) => r.slotId === s.slotId && r.partNo === s.partNo && r.original !== s.performerPartyId)).length;
  const mandates = (f?.mandates ?? []).filter((m) => m.supersededAt === null && m.rightKind === "PERFORMER");
  const owners = claims.filter((c) => c.edge === "OWNED_BY");
  const scopeConfs = (confs.data ?? []).filter((c) => c.factsScopeId === w.scopeId);
  const scopeParties = new Set(claims.map((c) => c.targetId));
  const ctrDocs = new Set((contracts.data ?? []).flatMap((c) => (c.document ? [c.document.documentId] : [])));
  const myDocs = (docs.data ?? []).filter((d) => !ctrDocs.has(d.documentId) && d.parties.some((p) => scopeParties.has(p)));
  const item = (k: string) => ready.data?.items.find((i) => i.key === k);
  const master = claims.find((c) => c.edge === "CONTROLLED_BY");
  const card = (label: string, value: ReactNode, note = "", tone: Card["tone"] = ""): Card => ({ label, value, note, tone });
  const issued = (issues.data?.items ?? []).filter((i) => i.packId === w.pack?.packId).length;
  const D: Record<Exclude<PanelTab, "overview" | "history">, Card[]> = {
    rights: [
      card("작품 · 작사·작곡", holders("WRITTEN_BY"), asserted("WRITTEN_BY") ? `확인 대기 ${asserted("WRITTEN_BY")}` : "확정", asserted("WRITTEN_BY") ? "warn" : "ok"),
      card("녹음 · 마스터", holders("CONTROLLED_BY"), asserted("CONTROLLED_BY") ? `확인 대기 ${asserted("CONTROLLED_BY")}` : "확정", asserted("CONTROLLED_BY") ? "warn" : "ok"),
      card("실연 · 슬롯별 담당", `슬롯 ${f?.slots.length ?? 0} · 보컬 파트 ${vocal.length}`, `본인 확인 ${owners.filter((c) => c.status === "VERIFIED").length}/${owners.length} · 파트 경계 추정`, owners.every((c) => c.status === "VERIFIED") ? "ok" : "warn"),
      card("수령 위임", mandates.length ? `${[...new Set(mandates.map((m) => name(m.toPartyId)))].join(", ")} ${pctText(mandates[0]!.shareBps)}` : "없음", `서명 ${mandates.filter((m) => m.status === "VERIFIED").length}/${owners.length}`, mandates.length === owners.length && owners.length > 0 ? "ok" : "warn"),
    ],
    stems: [
      card("슬롯 · 파트", `${f?.slots.length ?? 0} · 보컬 ${vocal.length} · 그룹 ${rows.filter((r) => r.kind === "GROUP").length} · 반주 ${rows.filter((r) => r.kind === "INSTRUMENT").length}`, "MV 분석 시각 · 파트 경계 추정", "warn"),
      card("원곡 스템", `${origStems} / ${rows.length}`, "", origStems < rows.length ? "warn" : "ok"),
      card("멤버 추가 녹음 스템", `${extraStems} / ${vocal.length * Math.max(owners.length - 1, 0)}`, "", extraStems < vocal.length * Math.max(owners.length - 1, 0) ? "warn" : "ok"),
      card("오디오 검수", item("audio")?.detail ?? "—", "", item("audio")?.ok === true ? "ok" : "warn"),
    ],
    docs: [
      card("원천 문서", String(myDocs.length), myDocs.map((d) => d.title).join(" · ")),
      card("표준 계약", String(contracts.data?.length ?? 0), [...new Set((contracts.data ?? []).map((c) => c.title))].slice(0, 4).join(" · ")),
    ],
    confirm: [
      card("확인 요청", String(scopeConfs.length), `확인 ${scopeConfs.filter((c) => c.status !== "OPEN").length} · 대기 ${scopeConfs.filter((c) => c.status === "OPEN").length}`, scopeConfs.some((c) => c.status === "OPEN") ? "warn" : "ok"),
      card("이용 동의", item("consents")?.detail.replace("보이스 ", "").replace(" 동의", "") ?? "—", "멤버 본인(실연자 앱)", item("consents")?.ok === true ? "ok" : "warn"),
    ],
    money: [card("발행 조합", String(issued), w.pack?.status === "ACTIVE" ? "" : "팩 활성 뒤"), card("매출", "—", "곡별 매출 집계 조회가 없다 — 명세·지급에서"), card("지급", "—", "곡별 지급 조회가 없다 — 명세·지급에서")],
    policy: [
      card("팩", w.pack?.packId ?? "없음", w.pack ? ({ ACTIVE: "활성", PAUSED: "일시정지", DRAFT: "초안" } as Record<string, string>)[w.pack.status] ?? w.pack.status : "팩 만들기 전"),
      card("분배 규칙", w.activePolicy ? "활성" : w.sealed ? "컴파일됨" : "컴파일 전", w.sealed ? "IR 생성됨" : "컴파일 전 — 컴파일하면 IR 생성", w.sealed ? "ok" : "warn"),
      card("출시", w.pack?.status === "ACTIVE" ? "판매 중" : "대기", "승인 → 활성화 → 팩 활성화"),
    ],
  };
  const PT_COUNT: Partial<Record<PanelTab, number>> = { rights: claims.filter((c) => c.edge !== "PERFORMED_BY").length, stems: stems.length, docs: myDocs.length + (contracts.data?.length ?? 0), confirm: scopeConfs.length };
  const label = PANEL_TABS.find((t) => t[0] === tab)?.[1] ?? "개요";
  const manage = MANAGE_TAB[tab];
  const timelineNote = (i: number) => (i < w.stage ? "완료" : i === w.stage ? (i === 1 ? `확인 ${w.pendingConfirmations} 남음` : "진행 중") : "대기");
  const info: [string, ReactNode][] = [
    ["곡명", w.title], ["작사·작곡", w.authors.join(" · ") || "—"], ["녹음", w.recordingTitle ?? "—"],
    ["마스터", master ? name(master.targetId) : "—"], ["실연자", owners.length ? `멤버 ${owners.length}` : "—"], ["원곡 권리", rightsText(w)], ["멤버 스템", stemText(w)],
    ["ISWC · ISRC", "— · —"], ["등록", f?.recordings[0]?.createdAt.slice(0, 10) ?? "—"],
  ];
  const lines = f ? recentChanges(f.claims, f.mandates, name, org) : [];
  return (
    <section aria-label="선택한 작품" className="p-selwork">
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 16, padding: "16px 24px 0" }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--p-muted)" }}><span className="p-mono">{w.workId}</span><StatusPill status={w.status} /></div>
          <h2 style={{ margin: "4px 0 0", fontSize: 24 }}>{w.title}</h2>
          <div className="p-sub">녹음 {w.recordingTitle ?? "—"}</div>
        </div>
        <div className="p-row" style={{ gap: 6 }}>
          <button type="button" className="p-btn mid" disabled title={NO_EDIT}>수정</button>
          <button type="button" className="p-btn mid" disabled title={NO_EDIT}>삭제</button>
        </div>
      </div>
      <div className="p-tabs" role="tablist" aria-label="작품 상세" style={{ padding: "10px 24px 0" }}>
        {PANEL_TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l} <span className="cnt" style={{ fontSize: 11 }}>{PT_COUNT[k] ?? ""}</span></button>)}
      </div>
      <div style={{ padding: "16px 24px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="p-row" style={{ gap: 12 }}>
          <span className="p-sub" style={{ flex: "1 1 400px" }}>{tab === "overview" ? "조회 전용 요약 — 관리할 탭을 고르면 그 탭의 워크스페이스로 들어간다"
            : `${label} 요약(조회 전용). 등록·수정·삭제는 워크스페이스에서${w.stage >= 2 ? " — IR 생성 뒤라 새 버전으로만" : " — IR 생성 전까지 가능"}`}</span>
          {tab !== "overview" && (manage ? <Link className="p-btn primary big" to={`/works/${encodeURIComponent(w.workId)}/${manage}`}>{label} 관리 →</Link>
            : <button type="button" className="p-btn big" disabled title={tab === "money" ? "정산은 곡 워크스페이스 탭이 없다 — 머리글 발행·정산" : "변경 이력은 조회만"}>{label} 관리 →</button>)}
        </div>
        <ErrorPanel error={facts.error ?? ready.error} />
        {tab === "overview" ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
            <div style={{ flex: "999 1 520px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "16px 24px", fontSize: 14 }}>
              {info.map(([l, v]) => <div key={l}><div style={{ fontSize: 12, color: "var(--p-muted)" }}>{l}</div><div style={{ fontWeight: 500 }}>{v}</div></div>)}
            </div>
            <div style={{ flex: "1 1 300px", maxWidth: 380, display: "flex", flexDirection: "column", gap: 8 }}>
              <strong style={{ fontSize: 15 }}>진행</strong>
              {STAGES.map((s, i) => <div key={s} className={`p-timeline ${i < w.stage ? "done" : i === w.stage ? "now" : "todo"}`}><b>{s}</b><span>{timelineNote(i)}</span></div>)}
            </div>
            <div style={{ flex: "1 1 300px", maxWidth: 380, display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
              <strong style={{ fontSize: 15 }}>IR 생성 준비</strong>
              {w.sealed ? <div style={{ display: "flex", gap: 8 }}><span className="p-ok" style={{ fontWeight: 700 }}>✓</span><span>IR 생성됨 — 수정은 새 버전으로</span></div>
                : (ready.data?.items ?? []).map((r) => (
                  <div key={r.key} style={{ display: "flex", gap: 8 }}><span className={r.ok === true ? "p-ok" : r.ok === "warn" ? "p-warn" : "p-bad"} style={{ fontWeight: 700 }}>{r.ok === true ? "✓" : r.ok === "warn" ? "!" : "·"}</span><span>{r.label} {r.detail}</span></div>
                ))}
            </div>
          </div>
        ) : tab === "history" ? (
          <div style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
            {lines.map((l, i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 130px minmax(0, 1fr)", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--p-line)" }}><span className="p-sub" style={{ fontSize: 14 }}>{l.at.slice(0, 16).replace("T", " ")}</span><span>{l.who}</span><span>{l.what}</span></div>)}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {D[tab].map((c) => <div key={c.label} className="p-mini"><div className="l">{c.label}</div><div className="v">{c.value}</div><div className={`n ${c.tone}`}>{c.note}</div></div>)}
          </div>
        )}
      </div>
    </section>
  );
}

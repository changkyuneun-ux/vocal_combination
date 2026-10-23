import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { post } from "../../api/registry.ts";
import { orgPartyIds, postRecording, type DocumentRow, type PartyRow } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { currentClaims, pctText, slugId } from "./model.ts";
import { useFacts, useOverview, useParties, useWrite } from "./data.tsx";

const STEPS = [["1 곡·녹음", "곡·녹음·근거 문서"], ["2 원곡 권리", "작품·녹음 지분"], ["3 멤버", "실연자·보이스·수령 위임"], ["4 확인", "요약 · 확인 요청 보내기"]] as const;
type Author = { partyId: string; roleDetail: string; share: string; doc: string };
const ROLE_DETAIL: [string, string][] = [["LYRICS_COMPOSITION", "작사·작곡"], ["LYRICS", "작사"], ["COMPOSITION", "작곡"]];

/**
 * 새 곡 워크스페이스(시안 Song-Create): 1 곡·녹음(곡 → 범위 → 녹음 + 녹음 권리) → 2 원곡 권리(작가 행·균등 분배·합계 검사)
 * → 3 멤버(명부에서 고르기 → 보이스·소유 주장, 멤버에게 확인 요청) → 4 확인. 단계마다 저장되고 "나중에 이어서"는 작품 목록으로.
 * 끝나면 스템 탭으로 간다. id는 제목에서(wrk_·fsc_·rcd_ + 제목, 겹치면 숫자 꼬리).
 */
export function NewWork() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const overview = useOverview();
  const parties = useParties();
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const docs = useGet<DocumentRow[]>(["documents"], "/documents");
  const w = useWrite();
  const workId = params.get("work") ?? "";
  const work = overview.data?.find((x) => x.workId === workId);
  const facts = useFacts(work?.scopeId);
  const step = Number(params.get("step") ?? (workId ? "2" : "1"));
  const go = (n: number, wid = workId) => setParams({ ...(wid && { work: wid }), step: String(n) });
  const own = orgPartyIds(mine.data);

  const [s1, setS1] = useState({ title: "", version: "Original", owner: "", doc: "" });
  const [authors, setAuthors] = useState<Author[]>([{ partyId: "", roleDetail: "LYRICS_COMPOSITION", share: "100", doc: "" }]);
  const [members, setMembers] = useState<string[]>([]);
  const [found, setFound] = useState<PartyRow[]>([]);
  const [lookup, setLookup] = useState("");
  const total = authors.reduce((a, x) => a + Math.round(Number(x.share) * 100), 0);
  const docRef = (id: string) => { const d = (docs.data ?? []).find((x) => x.documentId === id); return d ? [{ documentId: d.documentId, version: d.version }] : undefined; };
  const labels = parties.items.filter((p) => own.has(p.partyId) && ["LABEL", "AGENCY", "ARTIST", "PUBLISHER"].includes(p.partyType));
  const authorChoices = parties.items.filter((p) => ["AUTHOR", "PUBLISHER", "ARTIST"].includes(p.partyType));
  // 공용 명부의 멤버는 이 테넌트 곡에 아직 닿지 않았으면 목록에 보이지 않는다 — 당사자 id로 찾아 더한다.
  const memberChoices = [...parties.items.filter((p) => p.partyType === "MEMBER" || (p.partyType === "ARTIST" && own.has(p.partyId))),
    ...found.filter((x) => !parties.items.some((p) => p.partyId === x.partyId))];
  const find = () => void w.run(async () => {
    const r = await api<{ items: PartyRow[] }>("GET", `/parties?id=${encodeURIComponent(lookup.trim())}`);
    if (r.items.length === 0) throw new Error(`당사자 ${lookup.trim()}를 찾을 수 없습니다`);
    setFound([...found, ...r.items]); setMembers([...members, ...r.items.map((p) => p.partyId)]); setLookup("");
  }, "명부에서 찾아 더했습니다");
  const f = facts.data;
  const claims = f ? currentClaims(f.claims) : [];

  const save1 = () => void w.run(async () => {
    const taken = new Set((overview.data ?? []).map((x) => x.workId));
    const wid = slugId("wrk", s1.title, taken);
    const tail = wid.slice(4);
    await post("/works", { workId: wid, title: s1.title.trim() });
    await post("/scopes", { factsScopeId: `fsc_${tail}`, workId: wid });
    const ev = s1.doc ? docRef(s1.doc) : undefined;
    await postRecording({ recordingId: `rcd_${tail}`, workId: wid, masterOwnerPartyId: s1.owner, versionTitle: s1.version.trim(), masterClaim: ev ? { evidenceDocuments: ev } : {} });
    go(2, wid);
  }, "곡·범위·녹음을 저장했습니다(녹음 권리 100% 함께)");
  const save2 = () => void w.run(async () => {
    for (const a of authors) {
      await post("/claims", {
        claimId: `c_work_${workId.slice(4)}_${a.partyId.replace(/^pty_/, "")}`, factsScopeId: work!.scopeId, sourceId: workId, edge: "WRITTEN_BY", targetId: a.partyId,
        shareBps: Math.round(Number(a.share) * 100), roleDetail: a.roleDetail, status: own.has(a.partyId) ? "VERIFIED" : "ASSERTED", validFrom: new Date().toISOString(),
        ...(a.doc && { evidenceDocuments: docRef(a.doc) }),
      });
    }
    go(3);
  }, "작가 지분을 저장했습니다 — 다른 관리 주체에는 확인 요청이 갔습니다");
  const save3 = () => void w.run(async () => {
    for (const m of members) {
      const voiceId = `voc_${m.replace(/^pty_/, "")}`;
      if (!f?.voices.some((v) => v.voiceId === voiceId)) await post("/voices", { voiceId, factsScopeId: work!.scopeId, kind: "HUMAN" });
      if (!claims.some((c) => c.edge === "OWNED_BY" && c.sourceId === voiceId)) {
        await post("/claims", { claimId: `c_own_${voiceId}`, factsScopeId: work!.scopeId, sourceId: voiceId, edge: "OWNED_BY", targetId: m, shareBps: 10000, status: "ASSERTED", validFrom: new Date().toISOString() });
      }
    }
    go(4);
  }, "멤버 보이스와 소유 주장을 저장했습니다 — 멤버에게 확인 요청이 갔습니다");

  const sel = { padding: "8px 10px" } as const;
  const grid = { display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) 100px minmax(0, 1.6fr) 40px", gap: 8, alignItems: "center", fontSize: 14 } as const;
  const master = claims.find((c) => c.edge === "CONTROLLED_BY");
  const stepNote = (i: number) => (i + 1 < step ? "완료" : i + 1 === step ? "입력 중" : STEPS[i]![1]);
  return (
    <main className="p-main" style={{ maxWidth: 1200, gap: 18 }}>
      <nav aria-label="위치" style={{ fontSize: 14, color: "var(--p-muted)" }}><Link to="/works">작품</Link> › 새 곡 워크스페이스</nav>
      <h1 style={{ margin: 0, fontSize: 26 }}>새 곡</h1>
      <ol aria-label="단계" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, fontSize: 14 }}>
        {STEPS.map(([t], i) => {
          const st = i + 1 < step ? { background: "var(--p-ok-bg)", border: "1px solid var(--p-ok-line)" } : i + 1 === step ? { background: "var(--p-surface)", border: "2px solid var(--p-accent)" } : { background: "var(--p-surface)", border: "1px dashed var(--p-input-line)" };
          return <li key={t} aria-current={i + 1 === step ? "step" : undefined} style={{ padding: "12px 14px", borderRadius: 10, ...st }}><b>{t}</b><br /><span className={i + 1 < step ? "p-ok" : i + 1 === step ? "" : "p-todo"} style={i + 1 === step ? { color: "var(--p-accent-dark)" } : undefined}>{stepNote(i)}</span></li>;
        })}
      </ol>
      <ErrorPanel error={w.err ?? overview.error} />
      {w.notice && <p className="p-sub" role="status" style={{ margin: 0 }}>{w.notice}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <section style={{ flex: "999 1 640px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          {step > 1 && work && (
            <div className="p-box" style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, padding: "14px 16px" }}>
              <span><b>곡</b> {work.title}</span><span><b>녹음</b> {f?.recordings[0]?.versionTitle ?? "—"}</span>
              <span><b>근거 문서</b> {master?.evidenceDigest ? "녹음 근거 연결" : "나중에"}</span>
              <button type="button" className="p-linkbtn" style={{ marginLeft: "auto" }} disabled title="1단계(곡·녹음)는 저장 뒤 원곡 권리 탭에서 고친다(IR 생성 전)">1단계 고치기</button>
            </div>
          )}
          <div className="p-box" style={{ border: "2px solid var(--p-accent)", gap: 14 }}>
            {step === 1 && <>
              <h2 style={{ margin: 0, fontSize: 18 }}>곡·녹음</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <label className="p-field lg">곡 제목<input className="p-input" value={s1.title} onChange={(e) => setS1({ ...s1, title: e.target.value })} /></label>
                <label className="p-field lg">녹음 버전<input className="p-input" value={s1.version} onChange={(e) => setS1({ ...s1, version: e.target.value })} /></label>
                <label className="p-field lg">마스터 보유(우리 당사자)<select className="p-select" value={s1.owner} onChange={(e) => setS1({ ...s1, owner: e.target.value })}><option value="">고르기</option>{labels.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}(우리)</option>)}</select></label>
                <label className="p-field lg">녹음 근거 문서<select className="p-select" value={s1.doc} onChange={(e) => setS1({ ...s1, doc: e.target.value })}><option value="">나중에</option>{(docs.data ?? []).map((d) => <option key={`${d.documentId}@${d.version}`} value={d.documentId}>{d.title} v{d.version}</option>)}</select></label>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "var(--p-muted)" }}>근거 문서 올리기는 모아 보기 › 원천 문서에서. 관리번호는 제목에서 자동으로 만든다.</p>
            </>}
            {step === 2 && work && <>
              <h2 style={{ margin: 0, fontSize: 18 }}>원곡 권리</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><b>작품 · 작사·작곡</b><span className={total === 10000 ? "p-ok" : "p-bad"} style={{ fontWeight: 600 }}>합계 {pctText(total)}</span></div>
                <div style={grid}>
                  {authors.map((a, i) => [
                    <select key={`a${i}`} className="p-select" style={sel} aria-label="작가" value={a.partyId} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, partyId: e.target.value } : x)))}>
                      <option value="">작가 고르기</option>{authorChoices.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}(공용 명부)</option>)}</select>,
                    <select key={`r${i}`} className="p-select" style={sel} aria-label="역할" value={a.roleDetail} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, roleDetail: e.target.value } : x)))}>{ROLE_DETAIL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>,
                    <input key={`s${i}`} className="p-input" style={sel} aria-label="지분" type="number" value={a.share} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, share: e.target.value } : x)))} />,
                    <select key={`d${i}`} className="p-select" style={sel} aria-label="근거" value={a.doc} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, doc: e.target.value } : x)))}>
                      <option value="">근거 문서 나중에</option>{(docs.data ?? []).map((d) => <option key={`${d.documentId}@${d.version}`} value={d.documentId}>{d.title}</option>)}</select>,
                    <button key={`x${i}`} type="button" className="p-btn" aria-label="삭제" onClick={() => setAuthors(authors.filter((_, k) => k !== i))}>×</button>,
                  ])}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="p-btn" style={{ padding: "6px 12px" }} onClick={() => setAuthors([...authors, { partyId: "", roleDetail: "LYRICS_COMPOSITION", share: "0", doc: "" }])}>+ 작가</button>
                  <button type="button" className="p-linkbtn" style={{ padding: "6px 12px", textDecoration: "none", fontSize: 14 }} disabled={authors.length === 0} onClick={() => {
                    const n = authors.length, base = Math.floor(10000 / n);
                    setAuthors(authors.map((x, k) => ({ ...x, share: String((base + (k < 10000 - base * n ? 1 : 0)) / 100) })));
                  }}>균등 분배</button>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid var(--p-line)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><b>녹음 · 마스터</b><span className="p-ok" style={{ fontWeight: 600 }}>합계 {master ? pctText(master.shareBps) : "0%"}</span></div>
                <div style={grid}>
                  <select className="p-select" style={sel} aria-label="보유자" disabled title="녹음 권리는 1단계에서 녹음과 함께 저장됐다 — 바로잡기는 원곡 권리 탭"><option>{master ? `${parties.names.get(master.targetId) ?? master.targetId}(우리)` : "—"}</option></select>
                  <span>마스터 보유</span>
                  <input className="p-input" style={sel} aria-label="녹음 지분" type="number" disabled value={master ? master.shareBps / 100 : 0} readOnly />
                  <select className="p-select" style={sel} aria-label="녹음 근거" disabled title="녹음 근거 문서는 1단계에서"><option>{master?.evidenceDigest ? "근거 문서 연결" : "근거 문서 없음"}</option></select><span />
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "var(--p-muted)" }}>실연(멤버)은 다음 단계에서. 갈래 사이 비율은 분배 규칙에서 정한다.</p>
            </>}
            {step === 3 && work && <>
              <h2 style={{ margin: 0, fontSize: 18 }}>멤버 — 실연자·보이스</h2>
              <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 12, fontSize: 14 }}><legend style={{ fontWeight: 600, marginBottom: 6 }}>멤버(실연자 명부)</legend>
                {memberChoices.map((p) => (
                  <label key={p.partyId}><input type="checkbox" checked={members.includes(p.partyId)} onChange={(e) => setMembers(e.target.checked ? [...members, p.partyId] : members.filter((x) => x !== p.partyId))} /> {p.displayName}</label>
                ))}
              </fieldset>
              <div className="p-row">
                <label className="p-field lg" style={{ flex: "1 1 260px" }}>명부에서 당사자 id로 찾기<input className="p-input" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="pty_…" /></label>
                <button type="button" className="p-btn" style={{ alignSelf: "flex-end", padding: "9px 14px" }} disabled={lookup.trim() === ""} onClick={find}>찾아 더하기</button>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "var(--p-muted)" }}>고른 멤버마다 이 곡의 보이스와 소유 주장을 만들고 멤버에게 확인 요청을 보낸다. 수령 위임은 문서·계약 탭에서 표준 계약으로.</p>
            </>}
            {step === 4 && work && <>
              <h2 style={{ margin: 0, fontSize: 18 }}>확인</h2>
              <dl className="p-dl">
                <dt>곡</dt><dd>{work.title} · <span className="p-mono">{work.workId}</span></dd>
                <dt>녹음</dt><dd>{f?.recordings.map((r) => r.versionTitle).join(", ")}</dd>
                <dt>작품</dt><dd>{claims.filter((c) => c.edge === "WRITTEN_BY").map((c) => `${parties.names.get(c.targetId) ?? c.targetId} ${pctText(c.shareBps)}`).join(" · ") || "없음"}</dd>
                <dt>멤버·보이스</dt><dd>{claims.filter((c) => c.edge === "OWNED_BY").map((c) => parties.names.get(c.targetId) ?? c.targetId).join(" · ") || "없음"}</dd>
                <dt>확인 요청</dt><dd>대기 {work.pendingConfirmations}건 — 저장할 때 이미 보냈다</dd>
              </dl>
            </>}
          </div>
        </section>
        <aside className="p-box" style={{ flex: "1 1 300px", maxWidth: 360 }}>
          <strong>저장하면</strong>
          <span>· 레이블 마스터 100% → 바로 확정(우리 당사자)</span>
          <span>· 작가 지분 {authors.length}건 → 확인 요청(작가 전자서명 링크)</span>
          <span>· 단계마다 저장된다. 나가도 "입력 중"으로 남고 이어서 한다</span>
          <span style={{ color: "var(--p-muted)", fontSize: 13, paddingTop: 6, borderTop: "1px solid var(--p-line)" }}>당사자가 명부에 없으면: 우리 당사자는 조직 › 당사자에서, 외부 작가·멤버는 플랫폼에 등록을 요청한다.</span>
        </aside>
      </div>
      <div className="p-row" style={{ justifyContent: "flex-end", paddingTop: 12, borderTop: "1px solid var(--p-line)" }}>
        <Link className="p-btn" style={{ padding: "10px 14px", color: "var(--p-fg)" }} to={workId ? `/works?sel=${encodeURIComponent(workId)}` : "/works"}>나중에 이어서</Link>
        <button type="button" className="p-btn" style={{ padding: "10px 14px" }} disabled={step <= 2} title={step <= 2 ? "1단계는 저장 뒤 원곡 권리 탭에서 고친다" : undefined} onClick={() => go(step - 1)}>이전</button>
        {step === 1 && <button type="button" className="p-btn primary" style={{ padding: "10px 18px" }} disabled={w.busy || s1.title.trim() === "" || s1.owner === "" || s1.version.trim() === ""} onClick={save1}>저장하고 2 원곡 권리로</button>}
        {step === 2 && <button type="button" className="p-btn primary" style={{ padding: "10px 18px" }} disabled={w.busy || total !== 10000 || authors.some((a) => a.partyId === "")} title={total !== 10000 ? "합계 100%여야 저장" : undefined} onClick={save2}>저장하고 3 멤버로</button>}
        {step === 3 && <button type="button" className="p-btn primary" style={{ padding: "10px 18px" }} disabled={w.busy || members.length === 0} onClick={save3}>저장하고 4 확인으로</button>}
        {step === 4 && <button type="button" className="p-btn primary" style={{ padding: "10px 18px" }} onClick={() => nav(`/works/${encodeURIComponent(workId)}/rights`)}>워크스페이스로 — 슬롯·파트 등록</button>}
      </div>
      <p style={{ margin: 0, textAlign: "right", fontSize: 13, color: "var(--p-muted)" }}>4단계 뒤 곡 화면의 원곡 권리 탭으로 이동한다 — 슬롯·파트를 만들고 스템 탭에서 멤버별 원곡 스템과 추가 녹음 스템 등록</p>
    </main>
  );
}

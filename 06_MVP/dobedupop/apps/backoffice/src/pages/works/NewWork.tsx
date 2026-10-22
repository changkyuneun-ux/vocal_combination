import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useGet } from "../../api/hooks.ts";
import { post } from "../../api/registry.ts";
import { postRecording, type DocumentRow, type PartyRow } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Section } from "../../components/Section.tsx";
import { currentClaims, pctText, slugId } from "./model.ts";
import { useFacts, useOverview, useParties, useWrite } from "./data.tsx";

const STEPS = [["1 곡·녹음", "제목·녹음·마스터 보유"], ["2 원곡 권리", "작가 지분"], ["3 멤버", "실연자·보이스"], ["4 확인", "요약 · 확인 요청"]] as const;
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
  const own = new Set((mine.data ?? []).map((p) => p.partyId));

  const [s1, setS1] = useState({ title: "", version: "Original", owner: "", doc: "" });
  const [authors, setAuthors] = useState<Author[]>([{ partyId: "", roleDetail: "LYRICS_COMPOSITION", share: "100", doc: "" }]);
  const [members, setMembers] = useState<string[]>([]);
  const total = authors.reduce((a, x) => a + Math.round(Number(x.share) * 100), 0);
  const docRef = (id: string) => { const d = (docs.data ?? []).find((x) => x.documentId === id); return d ? [{ documentId: d.documentId, version: d.version }] : undefined; };
  const labels = parties.items.filter((p) => own.has(p.partyId) && ["LABEL", "AGENCY", "ARTIST", "PUBLISHER"].includes(p.partyType));
  const authorChoices = parties.items.filter((p) => ["AUTHOR", "PUBLISHER", "ARTIST"].includes(p.partyType));
  const memberChoices = parties.items.filter((p) => p.partyType === "MEMBER" || (p.partyType === "ARTIST" && own.has(p.partyId)));
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

  return (
    <>
      <nav className="crumb" aria-label="위치"><Link to="/works">작품</Link> › 새 곡 워크스페이스</nav>
      <h1>새 곡{work ? ` — ${work.title}` : ""}</h1>
      <ol className="steps" aria-label="단계">{STEPS.map(([t, d], i) => <li key={t} className={i + 1 < step ? "done" : i + 1 === step ? "now" : ""} aria-current={i + 1 === step ? "step" : undefined}><b>{t}</b> · {i + 1 < step ? "완료" : d}</li>)}</ol>
      <ErrorPanel error={w.err ?? overview.error} />
      {w.notice && <p role="status" className="muted">{w.notice}</p>}
      <div className="ws-grid">
        <div>
          {step === 1 && (
            <Section title="곡·녹음">
              <div className="form-grid">
                <label className="field"><span>곡 제목</span><input value={s1.title} onChange={(e) => setS1({ ...s1, title: e.target.value })} /></label>
                <label className="field"><span>녹음 버전</span><input value={s1.version} onChange={(e) => setS1({ ...s1, version: e.target.value })} /></label>
                <label className="field"><span>마스터 보유(우리 당사자)</span>
                  <select value={s1.owner} onChange={(e) => setS1({ ...s1, owner: e.target.value })}><option value="">고르기</option>{labels.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}</select>
                </label>
                <label className="field"><span>녹음 근거 문서</span>
                  <select value={s1.doc} onChange={(e) => setS1({ ...s1, doc: e.target.value })}><option value="">나중에</option>{(docs.data ?? []).map((d) => <option key={`${d.documentId}@${d.version}`} value={d.documentId}>{d.title} v{d.version}</option>)}</select>
                </label>
              </div>
              <p className="muted small">근거 문서 올리기는 <Link to="/documents">원천 문서</Link>에서 한다. id는 제목에서 자동으로 만든다.</p>
            </Section>
          )}
          {step === 2 && work && (
            <Section title="원곡 권리">
              <div className="crumb"><span><b>곡</b> {work.title}</span><span><b>녹음</b> {f?.recordings[0]?.versionTitle ?? "—"}</span></div>
              <h3>작품 · 작사·작곡 <span className={total === 10000 ? "mark-ok" : "mark-warn"}>합계 {pctText(total)}</span></h3>
              {authors.map((a, i) => (
                <div key={i} className="inline-form" aria-label={`작가 ${i + 1}`}>
                  <select aria-label="작가" value={a.partyId} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, partyId: e.target.value } : x)))}>
                    <option value="">작가(공용 명부)</option>{authorChoices.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}
                  </select>
                  <select aria-label="역할" value={a.roleDetail} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, roleDetail: e.target.value } : x)))}>{ROLE_DETAIL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  <input aria-label="지분" type="number" value={a.share} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, share: e.target.value } : x)))} style={{ width: 90 }} />
                  <select aria-label="근거" value={a.doc} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, doc: e.target.value } : x)))}>
                    <option value="">근거 문서 나중에</option>{(docs.data ?? []).map((d) => <option key={`${d.documentId}@${d.version}`} value={d.documentId}>{d.title}</option>)}
                  </select>
                  <button type="button" className="btn tiny" aria-label="삭제" onClick={() => setAuthors(authors.filter((_, k) => k !== i))}>×</button>
                </div>
              ))}
              <div className="row-actions">
                <button type="button" className="btn" onClick={() => setAuthors([...authors, { partyId: "", roleDetail: "LYRICS_COMPOSITION", share: "0", doc: "" }])}>+ 작가</button>
                <button type="button" className="btn" disabled={authors.length === 0} onClick={() => {
                  const n = authors.length, base = Math.floor(10000 / n);
                  setAuthors(authors.map((x, k) => ({ ...x, share: String((base + (k < 10000 - base * n ? 1 : 0)) / 100) })));
                }}>균등 분배</button>
              </div>
              <h3>녹음 · 마스터</h3>
              <p>{claims.filter((c) => c.edge === "CONTROLLED_BY").map((c) => `${parties.names.get(c.targetId) ?? c.targetId} ${pctText(c.shareBps)} (${c.status === "VERIFIED" ? "확정" : "확인 대기"})`).join(", ") || "1단계에서 함께 저장된다"}</p>
              <p className="muted small">실연(멤버)은 다음 단계에서. 갈래 사이 비율은 분배 규칙에서 정한다.</p>
            </Section>
          )}
          {step === 3 && work && (
            <Section title="멤버 — 실연자·보이스">
              <fieldset className="field"><legend>멤버(실연자 명부)</legend>
                {memberChoices.map((p) => (
                  <label key={p.partyId} className="check"><input type="checkbox" checked={members.includes(p.partyId)} onChange={(e) => setMembers(e.target.checked ? [...members, p.partyId] : members.filter((x) => x !== p.partyId))} />{p.displayName}</label>
                ))}
              </fieldset>
              <p className="muted small">고른 멤버마다 이 곡의 보이스와 소유 주장을 만들고 멤버에게 확인 요청을 보낸다. 수령 위임은 문서·계약 탭에서 표준 계약으로.</p>
            </Section>
          )}
          {step === 4 && work && (
            <Section title="확인">
              <dl className="kv">
                <dt>곡</dt><dd>{work.title} · <code>{work.workId}</code></dd>
                <dt>녹음</dt><dd>{f?.recordings.map((r) => r.versionTitle).join(", ")}</dd>
                <dt>작품</dt><dd>{claims.filter((c) => c.edge === "WRITTEN_BY").map((c) => `${parties.names.get(c.targetId) ?? c.targetId} ${pctText(c.shareBps)}`).join(" · ") || "없음"}</dd>
                <dt>멤버·보이스</dt><dd>{claims.filter((c) => c.edge === "OWNED_BY").map((c) => parties.names.get(c.targetId) ?? c.targetId).join(" · ") || "없음"}</dd>
                <dt>확인 요청</dt><dd>대기 {work.pendingConfirmations}건 — 저장할 때 이미 보냈다</dd>
              </dl>
              <p className="muted small">다음: 스템 탭에서 슬롯·파트별 원곡 스템과 멤버 추가 녹음 스템을 등록한다(슬롯·파트는 원곡 권리 탭).</p>
            </Section>
          )}
        </div>
        <aside className="note-box">
          <strong>저장하면</strong>
          <span>· 우리 당사자의 마스터 100% → 바로 확정</span>
          <span>· 작가 지분 → 확인 요청(플랫폼 위탁 작가는 운영이 원문 대조)</span>
          <span>· 멤버 보이스 소유 → 멤버에게 확인 요청(실연자 앱)</span>
          <span>· 단계마다 저장된다. 나가도 "입력 중"으로 남고 이어서 한다</span>
          <span>당사자가 명부에 없으면: 우리 당사자는 모아 보기 › 당사자에서, 외부 작가·멤버는 플랫폼에 등록을 요청한다.</span>
        </aside>
      </div>
      <div className="row-actions" style={{ marginTop: 16 }}>
        <Link className="btn" to={workId ? `/works?sel=${encodeURIComponent(workId)}` : "/works"}>나중에 이어서</Link>
        {step > 1 && <button type="button" className="btn" onClick={() => go(step - 1)} disabled={step === 2}>이전</button>}
        {step === 1 && <button type="button" className="btn primary" disabled={w.busy || s1.title.trim() === "" || s1.owner === "" || s1.version.trim() === ""} onClick={save1}>저장하고 2 원곡 권리로</button>}
        {step === 2 && <button type="button" className="btn primary" disabled={w.busy || total !== 10000 || authors.some((a) => a.partyId === "")} onClick={save2}>저장하고 3 멤버로</button>}
        {step === 3 && <button type="button" className="btn primary" disabled={w.busy || members.length === 0} onClick={save3}>저장하고 4 확인으로</button>}
        {step === 4 && <button type="button" className="btn primary" onClick={() => nav(`/works/${encodeURIComponent(workId)}/rights`)}>워크스페이스로 — 슬롯·파트 등록</button>}
        {step === 2 && total !== 10000 && <span className="error-text" role="alert">합계 100%여야 저장</span>}
      </div>
    </>
  );
}

import { DropZone } from "../../components/DropZone.tsx";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { post } from "../../api/registry.ts";
import { orgPartyIds, postRecording, uploadOriginal, type PartyRow } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { B, Card, Kv, Note, TableCard } from "../ops/common.tsx";
import { currentClaims, pctText, slugId } from "./model.ts";
import { useFacts, useOverview, useParties, useWrite } from "./data.tsx";

const STEPS = ["곡·녹음 · 녹음 계약서", "원곡 권리 · 작품 계약서", "멤버 · 보이스·파트", "확인 · 확인 요청 보내기"] as const;
type Author = { partyId: string; roleDetail: string; share: string };
const ROLE_DETAIL: [string, string][] = [["LYRICS_COMPOSITION", "작사·작곡"], ["LYRICS", "작사"], ["COMPOSITION", "작곡"]];

/**
 * 새 곡 워크스페이스(시안 Song-Create v2, 2026-10-24 곡 절차): 곡 진행 ① 원본 계약서 → ② 권리 등록까지.
 * 1 곡·녹음(곡 → 범위 → 녹음 계약서를 이 곡에 묶어 올림 → 녹음 + 녹음 권리, 근거 = 그 계약서) → 2 원곡 권리(작품 계약서 올림 → 작가 행·균등 분배·합계 검사, 근거 = 그 계약서)
 * → 3 멤버(명부에서 고르기 → 보이스·소유 주장, 멤버에게 확인 요청) → 4 확인. 단계마다 저장되고 "나중에 이어서"는 작품 목록으로.
 * 끝나면 스템 탭으로 간다. id는 제목에서(wrk_·fsc_·rcd_ + 제목, 겹치면 숫자 꼬리).
 */
export function NewWork() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const overview = useOverview();
  const parties = useParties();
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const w = useWrite();
  const workId = params.get("work") ?? "";
  const work = overview.data?.find((x) => x.workId === workId);
  const facts = useFacts(work?.scopeId);
  const step = Number(params.get("step") ?? (workId ? "2" : "1"));
  const go = (n: number, wid = workId) => setParams({ ...(wid && { work: wid }), step: String(n) });
  const own = orgPartyIds(mine.data);

  const [s1, setS1] = useState({ title: "", version: "Original", owner: "" });
  const [authors, setAuthors] = useState<Author[]>([{ partyId: "", roleDetail: "LYRICS_COMPOSITION", share: "100" }]);
  // 이 곡의 원본 계약서(0048): 단계 1 녹음 계약서, 단계 2 작품 계약서. 저장할 때 이 곡에 묶어 올리고 권리 주장의 근거로 건다.
  const [masterFile, setMasterFile] = useState<File | null>(null);
  const [workFile, setWorkFile] = useState<File | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [found, setFound] = useState<PartyRow[]>([]);
  const [lookup, setLookup] = useState("");
  const total = authors.reduce((a, x) => a + Math.round(Number(x.share) * 100), 0);
  // 유형별 거르기(원곡 권리 "새 버전 만들기"와 같은 규칙): 마스터 보유 = 빅히트 관리 레이블만, 작가 = 작가 당사자만.
  const labels = parties.items.filter((p) => own.has(p.partyId) && p.partyType === "LABEL");
  const authorChoices = parties.items.filter((p) => p.partyType === "AUTHOR");
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
    const doc = masterFile ? await uploadOriginal(masterFile, { kind: "MASTER_CONTRACT", title: `${s1.title.trim()} 녹음 계약서`, parties: [s1.owner], scope: `fsc_${tail}` }) : null;
    const ev = doc ? [{ documentId: doc.documentId, version: doc.versions[0]!.version }] : undefined;
    await postRecording({ recordingId: `rcd_${tail}`, workId: wid, masterOwnerPartyId: s1.owner, versionTitle: s1.version.trim(), masterClaim: ev ? { evidenceDocuments: ev } : {} });
    go(2, wid);
  }, "곡·범위·녹음을 저장했습니다(녹음 권리 100% 함께, 녹음 계약서는 이 곡의 원본 계약서)");
  const save2 = () => void w.run(async () => {
    const doc = workFile ? await uploadOriginal(workFile, { kind: "PUBLISHING", title: `${work!.title} 작품 퍼블리싱 계약서`, parties: authors.map((a) => a.partyId), scope: work!.scopeId! }) : null;
    const ev = doc ? [{ documentId: doc.documentId, version: doc.versions[0]!.version }] : undefined;
    for (const a of authors) {
      await post("/claims", {
        claimId: `c_work_${workId.slice(4)}_${a.partyId.replace(/^pty_/, "")}`, factsScopeId: work!.scopeId, sourceId: workId, edge: "WRITTEN_BY", targetId: a.partyId,
        shareBps: Math.round(Number(a.share) * 100), roleDetail: a.roleDetail, status: own.has(a.partyId) ? "VERIFIED" : "ASSERTED", validFrom: new Date().toISOString(),
        ...(ev && { evidenceDocuments: ev }),
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

  const sel = { padding: "10px 12px" } as const;
  const grid = { display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) 100px 40px", gap: 8, alignItems: "center", fontSize: 14 } as const;
  const master = claims.find((c) => c.edge === "CONTROLLED_BY");
  const field = (label: string, control: React.ReactNode, hint?: string) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}><span style={{ fontSize: 14, fontWeight: 700, color: "var(--p-fg)" }}>{label}</span>{control}
      {hint && <span style={{ fontSize: 12, color: "var(--p-muted)" }}>{hint}</span>}</label>
  );
  /** 이 곡의 원본 계약서 올리기(시안: 점선 상자 + 올린 문서 표). 저장할 때 이 곡에 묶어 올린다. */
  const drop = (what: string, basis: string, file: File | null, set: (f: File | null) => void) => (
    <>
      <DropZone id={`f-${what}`} label={what} accept="pdf" variant="large" what={what} file={file} onFile={set}
        hint="PDF · 이 곡에 묶여 원본 계약서가 된다 — 다른 곡의 계약서는 보이지 않는다" />
      {file && (
        <TableCard cols={["올린 문서", "근거가 될 권리", "상태"]} count={1} paged={false} minW={600} label={`올린 ${what}`}>
          <tr><td>{file.name}</td><td>{basis}</td><td><B tone="muted">저장하면 올림</B></td></tr>
        </TableCard>
      )}
    </>
  );
  const ownerName = labels.find((p) => p.partyId === s1.owner)?.displayName;
  return (
    <main className="p-main" style={{ maxWidth: 1200 }}>
      <div className="p-title-row"><div><h1>새 곡</h1><div className="p-desc">곡 진행 ① 원본 계약서 → ② 권리 등록까지 이 마법사에서 한다. 4단계 뒤 곡 화면의 원곡 권리 탭으로 간다</div></div></div>
      <ol aria-label="단계" className="p-steps imp">
        {STEPS.map((t, i) => <li key={t} className={i + 1 < step ? "done" : i + 1 === step ? "now" : ""} aria-current={i + 1 === step ? "step" : undefined}>{i + 1 < step ? "✓ " : ""}{i + 1} {t}</li>)}
      </ol>
      <ErrorPanel error={w.err ?? overview.error} />
      {w.notice && <p className="p-sub" role="status" style={{ margin: 0 }}>{w.notice}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 640px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          {step === 1 && (
            <Card title="곡·녹음">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
                {field("곡 제목", <input className="p-input" aria-label="곡 제목" value={s1.title} onChange={(e) => setS1({ ...s1, title: e.target.value })} />)}
                {field("녹음 버전", <input className="p-input" aria-label="녹음 버전" value={s1.version} onChange={(e) => setS1({ ...s1, version: e.target.value })} />)}
                {field("마스터 보유", <select className="p-select" aria-label="마스터 보유" value={s1.owner} onChange={(e) => setS1({ ...s1, owner: e.target.value })}><option value="">고르기</option>{labels.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}</select>, "레이블만 보인다")}
                {field("녹음 계약서", <div style={{ padding: "10px 0", fontSize: 14, fontWeight: 400 }}>아래에서 올린 문서가 근거가 된다</div>)}
              </div>
              {drop("녹음 계약서", "녹음 · 마스터 보유", masterFile, setMasterFile)}
            </Card>
          )}
          {step > 1 && work && (
            <div className="p-note" style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <span><b>곡</b> {work.title}</span><span><b>녹음</b> {f?.recordings[0]?.versionTitle ?? "—"}</span>
              <span><b>녹음 계약서</b> {master?.evidenceDigest ? "이 곡의 원본 계약서로 연결" : "없음 — 문서·계약 탭에서 올린다"}</span>
            </div>
          )}
          {step === 2 && work && (
            <Card title="원곡 권리" hint={`작품 · 작사·작곡 합계 ${pctText(total)}`}>
              <div style={grid}>
                {authors.map((a, i) => [
                  <select key={`a${i}`} className="p-select" style={sel} aria-label="작가" value={a.partyId} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, partyId: e.target.value } : x)))}>
                    <option value="">작가 고르기</option>{authorChoices.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}</select>,
                  <select key={`r${i}`} className="p-select" style={sel} aria-label="역할" value={a.roleDetail} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, roleDetail: e.target.value } : x)))}>{ROLE_DETAIL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>,
                  <input key={`s${i}`} className="p-input" style={sel} aria-label="지분" type="number" value={a.share} onChange={(e) => setAuthors(authors.map((x, k) => (k === i ? { ...x, share: e.target.value } : x)))} />,
                  <button key={`x${i}`} type="button" className="p-btn" aria-label="삭제" style={{ padding: "8px 0" }} onClick={() => setAuthors(authors.filter((_, k) => k !== i))}>×</button>,
                ])}
              </div>
              <div className="p-row">
                <button type="button" className="p-btn sm" onClick={() => setAuthors([...authors, { partyId: "", roleDetail: "LYRICS_COMPOSITION", share: "0" }])}>+ 작가</button>
                <button type="button" className="p-btn sm" disabled={authors.length === 0} onClick={() => {
                  const n = authors.length, base = Math.floor(10000 / n);
                  setAuthors(authors.map((x, k) => ({ ...x, share: String((base + (k < 10000 - base * n ? 1 : 0)) / 100) })));
                }}>균등 분배</button>
                <span className={total === 10000 ? "p-ok" : "p-bad"} style={{ marginLeft: "auto", fontWeight: 700 }}>합계 {pctText(total)}</span>
              </div>
              {drop("작품 계약서", "작품 · 작가 지분", workFile, setWorkFile)}
              <span className="p-sub">녹음 · 마스터는 1단계에서 저장했다({master ? `${parties.names.get(master.targetId) ?? master.targetId} ${pctText(master.shareBps)}` : "—"}). 실연(멤버)은 다음 단계에서.</span>
            </Card>
          )}
          {step === 3 && work && (
            <Card title="멤버 · 보이스">
              <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 12, fontSize: 14 }}><legend style={{ fontWeight: 700, marginBottom: 6 }}>멤버(실연자 명부)</legend>
                {memberChoices.map((p) => (
                  <label key={p.partyId}><input type="checkbox" checked={members.includes(p.partyId)} onChange={(e) => setMembers(e.target.checked ? [...members, p.partyId] : members.filter((x) => x !== p.partyId))} /> {p.displayName}</label>
                ))}
              </fieldset>
              <div className="p-row">
                {field("명부에서 당사자 id로 찾기", <input className="p-input" aria-label="명부에서 당사자 id로 찾기" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="pty_…" />)}
                <button type="button" className="p-btn" style={{ alignSelf: "flex-end" }} disabled={lookup.trim() === ""} onClick={find}>찾아 더하기</button>
              </div>
              <span className="p-sub">고른 멤버마다 이 곡의 보이스와 소유 주장을 만들고 멤버에게 확인 요청을 보낸다. 수령 위임은 문서·계약 탭에서 표준 계약으로.</span>
            </Card>
          )}
          {step === 4 && work && (
            <Card title="확인">
              <Kv pairs={[["곡", <>{work.title} · <span className="p-mono">{work.workId}</span></>], ["녹음", f?.recordings.map((r) => r.versionTitle).join(", ") ?? "—"],
                ["작품", claims.filter((c) => c.edge === "WRITTEN_BY").map((c) => `${parties.names.get(c.targetId) ?? c.targetId} ${pctText(c.shareBps)}`).join(" · ") || "없음"],
                ["멤버·보이스", claims.filter((c) => c.edge === "OWNED_BY").map((c) => parties.names.get(c.targetId) ?? c.targetId).join(" · ") || "없음"],
                ["확인 요청", `대기 ${work.pendingConfirmations}건 — 저장할 때 이미 보냈다`]]} />
            </Card>
          )}
        </div>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}>
          <Card title="저장하면">
            {step === 1 ? <Kv pairs={[["마스터 보유", `${ownerName ?? "레이블"} 100% · 바로 확정`], ["녹음 계약서", masterFile ? "이 곡의 원본 계약서로 저장" : "나중에(문서·계약 탭)"], ["다음 단계", "② 작품 계약서 올리기 · 작가 지분"]]} />
              : step === 2 ? <Kv pairs={[["작가 지분", `${authors.length}건 → 작가 전자서명 링크로 확인`], ["작품 계약서", workFile ? "이 곡의 원본 계약서로 저장" : "나중에(문서·계약 탭)"], ["다음 단계", "③ 멤버 · 보이스"]]} />
              : <Kv pairs={[["멤버", `${members.length}명 → 실연자 앱에서 본인 확인`], ["다음 단계", step === 3 ? "④ 확인" : "원곡 권리 탭 — 슬롯·파트"]]} />}
            <Note>단계마다 저장된다. 나가도 '입력 중'으로 남고 이어서 한다. 당사자가 명부에 없으면 운영 관리 › 조직 › 내 조직에서 등록한다.</Note>
          </Card>
        </div>
      </div>
      <div className="p-row" style={{ justifyContent: "flex-end" }}>
        <Link className="p-btn" to={workId ? `/works?sel=${encodeURIComponent(workId)}` : "/works"}>나중에 이어서</Link>
        <button type="button" className="p-btn" disabled={step <= 2} title={step <= 2 ? "1단계는 저장 뒤 원곡 권리 탭에서 고친다" : undefined} onClick={() => go(step - 1)}>이전</button>
        {step === 1 && <button type="button" className="p-btn primary" disabled={w.busy || s1.title.trim() === "" || s1.owner === "" || s1.version.trim() === ""} onClick={save1}>저장하고 ② 원곡 권리로</button>}
        {step === 2 && <button type="button" className="p-btn primary" disabled={w.busy || total !== 10000 || authors.some((a) => a.partyId === "")} title={total !== 10000 ? "합계 100%여야 저장" : undefined} onClick={save2}>저장하고 ③ 멤버로</button>}
        {step === 3 && <button type="button" className="p-btn primary" disabled={w.busy || members.length === 0} onClick={save3}>저장하고 ④ 확인으로</button>}
        {step === 4 && <button type="button" className="p-btn primary" onClick={() => nav(`/works/${encodeURIComponent(workId)}/rights`)}>워크스페이스로 — 슬롯·파트 등록</button>}
      </div>
    </main>
  );

}

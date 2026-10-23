import { Fragment, useState } from "react";
import { Link } from "react-router";
import { post } from "../../../api/registry.ts";
import { useGet } from "../../../api/hooks.ts";
import { deleteCatalog, postSlot, postSlotPart, putSlotPart, type DocumentRow, type PartKind, type PartyRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { mmss, pctText, recentChanges, rightsBuckets, shortAt, type Bucket, type BucketRow, type PartRow } from "../model.ts";
import { useParties, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

const ROLE_DETAIL: [string, string][] = [["LYRICS_COMPOSITION", "작사·작곡"], ["LYRICS", "작사"], ["COMPOSITION", "작곡"]];
const roleText = (r: string | null) => ROLE_DETAIL.find(([k]) => k === r)?.[1] ?? r ?? "—";
const PART_ROLE: Record<string, string> = { LEAD: "리드", HARMONY: "화음", ADLIB: "애드리브", UNISON: "제창", RAP: "랩" };
const KIND: Record<PartKind, string> = { VOCAL: "보컬", GROUP: "그룹", INSTRUMENT: "반주" };
const sec = (ms: number) => String(ms / 1000);
const msOf = (s: string) => Math.round(Number(s) * 1000);
const NO_CLAIM_DELETE = "권리 주장 삭제 API가 없다 — 지분 0%나 새 버전으로 바로잡는다";

type Summary = { lines: { records: { type: string; id: string }[]; evidence: { title: string; version: number }[] }[] };
/** 주장 → 근거 문서 이름(권리 요약 줄의 근거 문서). */
function useEvidenceTitles(scopeId: string) {
  const s = useGet<Summary>(["readiness", "summary", scopeId], `/scopes/${encodeURIComponent(scopeId)}/summary`);
  const m = new Map<string, string>();
  for (const l of s.data?.lines ?? []) for (const r of l.records) if (l.evidence.length) m.set(r.id, l.evidence.map((e) => `${e.title} v${e.version}`).join(", "));
  return m;
}

/**
 * 원곡 권리 탭(시안 Song-Rights.dc.html, IR 생성 뒤 Song-Locked.dc.html): 세 갈래(작품·녹음·실연 슬롯·파트) + 수령 위임, 오른쪽 저장 규칙·최근 변경.
 */
export function RightsTab({ ctx }: { ctx: WsCtx }) {
  if (ctx.sealed) return <LockedRights ctx={ctx} />;
  const buckets = rightsBuckets(ctx.facts.claims, ctx.names);
  const editable = ctx.can("rights.edit");
  const lines = recentChanges(ctx.facts.claims, ctx.facts.mandates, ctx.name, "권리 편집").slice(0, 4).reverse();
  return (
    <>
      <p className="p-lead">원곡의 권리를 세 갈래로 관리한다. 갈래 안의 지분은 여기서, 갈래 사이 비율(녹음 40 · 실연 45 · 작품 15)은 분배 규칙에서 정한다. 다른 관리 주체의 권리는 저장하면 그쪽에 확인 요청이 간다.</p>
      <div className="p-cols">
        <div className="main">
          <ShareBucket ctx={ctx} bucket={buckets[0]!} editable={editable} sourceId={ctx.work.workId} addLabel="+ 작가 추가" partyTypes={["AUTHOR", "PUBLISHER", "ARTIST"]} note="합계" />
          {ctx.recordingId && <ShareBucket ctx={ctx} bucket={buckets[1]!} editable={editable} sourceId={ctx.recordingId} addLabel="+ 공동 보유자" partyTypes={["LABEL", "AGENCY", "PUBLISHER", "ARTIST"]} note="합계" extraNote="멤버 추가 녹음 스템도 이 녹음에 속한다" />}
          <PerformerBucket ctx={ctx} />
          <MandateBucket ctx={ctx} />
        </div>
        <aside className="side" aria-label="이 곡의 권리 상태">
          <div className="p-box">
            <strong>저장 규칙</strong>
            <span>· 갈래마다 합계 100%여야 저장된다</span>
            <span>· 권리자는 명부에서 고른다(빅히트 당사자 · 공용 명부의 작가·멤버)</span>
            <span>· 자기 당사자 권리는 바로 확정, 다른 관리 주체는 확인 요청</span>
            <span>· 지분을 바꾸면 그 권리의 확인을 다시 받는다</span>
            <span>· IR 생성 전까지 수정·삭제, 생성 뒤에는 새 버전으로</span>
          </div>
          <div className="p-box sm">
            <strong style={{ fontSize: 14 }}>최근 변경</strong>
            {lines.map((l, i) => <span key={i}>{shortAt(l.at)} · {l.what}</span>)}
            <Link to={`/works?sel=${encodeURIComponent(ctx.work.workId)}&tab=history`}>변경 기록 전체</Link>
          </div>
        </aside>
      </div>
    </>
  );
}

type Draft = { claimId?: string; partyId: string; shareBps: number; roleDetail: string; doc: string };

/** 작품·녹음 갈래(시안 카드 + 표). "수정"은 그 행을, "+ 추가"는 새 행을 표 안에서 편집한다. 갈래 합계 100%일 때만 저장. */
function ShareBucket({ ctx, bucket, editable, sourceId, addLabel, partyTypes, extraNote }: { ctx: WsCtx; bucket: Bucket; editable: boolean; sourceId: string; addLabel: string; partyTypes: string[]; note: string; extraNote?: string }) {
  const parties = useParties();
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const docs = useGet<DocumentRow[]>(["documents"], "/documents");
  const ev = useEvidenceTitles(ctx.scopeId);
  const w = useWrite();
  const rows = bucket.rows.filter((r) => r.sourceId === sourceId);
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const own = new Set((mine.data ?? []).map((p) => p.partyId));
  const isWork = bucket.key === "work";
  const draftOf = (r: BucketRow): Draft => ({ claimId: r.claimId, partyId: r.partyId, shareBps: r.shareBps, roleDetail: r.roleDetail ?? "LYRICS_COMPOSITION", doc: "" });
  const editing = Object.keys(edits).length > 0;
  const total = rows.reduce((a, r) => a + (edits[r.claimId]?.shareBps ?? r.shareBps), 0) + Object.entries(edits).filter(([k]) => k.startsWith("new")).reduce((a, [, d]) => a + d.shareBps, 0);
  const choices = parties.items.filter((p) => partyTypes.includes(p.partyType) || own.has(p.partyId));
  const set = (k: string, patch: Partial<Draft>) => setEdits((e) => ({ ...e, [k]: { ...e[k]!, ...patch } }));
  const subOf = (p: string) => (own.has(p) ? "자기 당사자" : parties.items.find((x) => x.partyId === p)?.partyType === "AUTHOR" ? "플랫폼 위탁 작가" : "");
  const save = () => void w.run(async () => {
    for (const d of Object.values(edits)) {
      const doc = (docs.data ?? []).find((x) => x.documentId === d.doc);
      await post("/claims", {
        claimId: d.claimId ?? `c_${isWork ? "work" : "master"}_${sourceId.replace(/^(wrk|rcd)_/, "")}_${d.partyId.replace(/^pty_/, "")}`,
        factsScopeId: ctx.scopeId, sourceId, edge: bucket.edge, targetId: d.partyId, shareBps: d.shareBps,
        ...(isWork && { roleDetail: d.roleDetail }), status: own.has(d.partyId) ? "VERIFIED" : "ASSERTED", validFrom: new Date().toISOString(),
        ...(doc && { evidenceDocuments: [{ documentId: doc.documentId, version: doc.version }] }),
      });
    }
    setEdits({});
  }, "저장했습니다 — 다른 관리 주체에는 확인 요청이 갔습니다");
  const editRow = (k: string, d: Draft) => (
    <tr key={k} className="sel">
      <td><label className="p-field">권리자{d.claimId ? <b style={{ fontSize: 14, color: "var(--p-fg)" }}>{ctx.name(d.partyId)}</b> : (
        <select className="p-select sm" value={d.partyId} onChange={(e) => set(k, { partyId: e.target.value })}>
          <option value="">명부에서 고르기</option>{choices.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}
        </select>)}</label></td>
      <td>{isWork ? <label className="p-field">역할<select className="p-select sm" value={d.roleDetail} onChange={(e) => set(k, { roleDetail: e.target.value })}>{ROLE_DETAIL.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label> : "마스터 보유"}</td>
      <td className="r"><label className="p-field">지분(%)<input className="p-input sm" type="number" style={{ width: 72, textAlign: "right" }} value={d.shareBps / 100} onChange={(e) => set(k, { shareBps: Math.round(Number(e.target.value) * 100) })} /></label></td>
      <td><label className="p-field">근거 문서<select className="p-select sm" value={d.doc} onChange={(e) => set(k, { doc: e.target.value })}>
        <option value="">{d.claimId ? ev.get(d.claimId) ?? "그대로" : "고르기"}</option>{(docs.data ?? []).map((x) => <option key={`${x.documentId}@${x.version}`} value={x.documentId}>{x.title} v{x.version}</option>)}
      </select></label></td>
      <td className="p-warn" style={{ fontSize: 13 }}>{total !== 10000 ? `합계 100%여야 저장(지금 ${pctText(total)})` : own.has(d.partyId) ? "저장하면 바로 확정" : d.claimId ? "저장하면 확인 요청 다시 보냄" : "저장하면 확인 요청 보냄"}</td>
      <td className="r nw"><button type="button" className="p-btn sm primary" disabled={total !== 10000 || w.busy || Object.values(edits).some((x) => x.partyId === "")} onClick={save}>저장</button> <button type="button" className="p-btn sm" onClick={() => setEdits({})}>취소</button></td>
    </tr>
  );
  return (
    <section className="p-card" aria-labelledby={`b-${bucket.key}`}>
      <div className="p-card-head">
        <h2 id={`b-${bucket.key}`}>{bucket.title}</h2><span className="note">합계 {pctText(total)}{extraNote ? ` · ${extraNote}` : ""}</span>
        {editable && <button type="button" className="p-btn" style={{ marginLeft: "auto" }} onClick={() => setEdits((e) => ({ ...e, [`new${Date.now()}`]: { partyId: "", shareBps: 0, roleDetail: "LYRICS_COMPOSITION", doc: "" } }))}>{addLabel}</button>}
      </div>
      <div className="p-scroll"><table className="p-table" style={{ minWidth: isWork ? 760 : undefined }}>
        {isWork && <thead><tr><th>권리자</th><th>역할</th><th className="r">지분</th><th>근거 문서</th><th>확인</th><th className="r">관리</th></tr></thead>}
        <tbody>
          {rows.map((r) => edits[r.claimId] ? editRow(r.claimId, edits[r.claimId]!) : (
            <tr key={r.claimId}>
              <td className="b">{r.name}<div className="sub">{subOf(r.partyId)}</div></td>
              <td>{isWork ? roleText(r.roleDetail) : "마스터 보유"}</td>
              <td className="r">{pctText(r.shareBps)}</td>
              <td>{ev.get(r.claimId) ?? <span className="p-todo">없음</span>}</td>
              <td className={r.status === "VERIFIED" ? "p-ok" : "p-warn"}>{r.status === "VERIFIED" ? "확정" : r.partyId && subOf(r.partyId) === "플랫폼 위탁 작가" ? "운영 원문 대조 대기" : "확인 대기"}</td>
              <td className="r nw">{editable ? <><button type="button" className="p-linkbtn" onClick={() => setEdits((e) => ({ ...e, [r.claimId]: draftOf(r) }))}>수정</button> · <button type="button" className="p-linkbtn" disabled title={NO_CLAIM_DELETE}>삭제</button></> : null}</td>
            </tr>
          ))}
          {Object.entries(edits).filter(([k]) => k.startsWith("new")).map(([k, d]) => editRow(k, d))}
          {rows.length === 0 && !editing && <tr><td colSpan={6} className="p-todo">권리자가 없습니다.</td></tr>}
        </tbody>
      </table></div>
      {w.err && <div className="p-card-body"><ErrorPanel error={w.err} /></div>}
      {w.notice && <div className="p-card-foot" role="status">{w.notice}</div>}
    </section>
  );
}

type PartDraft = { slotId: string; partNo: number; kind: PartKind; role: string; start: string; end: string; original: string; isNew: boolean };

/** 실연 · 슬롯(원곡 흐름)별 파트와 담당(시안 표: # · 슬롯 · 시간 · 파트 · 원곡 담당 · 역할 · 확인 · 관리). */
function PerformerBucket({ ctx }: { ctx: WsCtx }) {
  const w = useWrite();
  const [draft, setDraft] = useState<PartDraft | null>(null);
  const [slotForm, setSlotForm] = useState<{ label: string; start: string; end: string } | null>(null);
  const editable = ctx.can("rights.edit");
  const owned = rightsBuckets(ctx.facts.claims, ctx.names)[2]!.rows;
  const counts = { VOCAL: 0, GROUP: 0, INSTRUMENT: 0 };
  for (const r of ctx.rows) counts[r.kind]++;
  const state = (r: PartRow): [string, string] => {
    if (r.kind === "INSTRUMENT") return ["—", "p-todo"];
    if (r.kind === "GROUP") return ["그룹 · 교체 불가", "p-todo"];
    const st = ctx.facts.stems.find((s) => s.slotId === r.slotId && s.partNo === r.partNo && s.performerPartyId === r.original);
    const c = st && ctx.facts.claims.find((x) => x.edge === "PERFORMED_BY" && x.sourceId === st.stemId && x.supersededAt === null);
    return !st ? ["원곡 스템 없음", "p-warn"] : !c ? ["실연 주장 없음", "p-warn"] : c.status === "VERIFIED" ? ["확인됨", "p-ok"] : ["확인 대기", "p-warn"];
  };
  const edit = (r: PartRow) => setDraft({ slotId: r.slotId, partNo: r.partNo, kind: r.kind, role: r.role ?? "", start: sec(r.startMs), end: sec(r.endMs), original: r.original ?? "", isNew: false });
  const addPart = (r: PartRow) => setDraft({ slotId: r.slotId, partNo: Math.max(...ctx.rows.filter((x) => x.slotId === r.slotId).map((x) => x.partNo)) + 1, kind: "VOCAL", role: "LEAD", start: sec(r.slotStartMs), end: sec(r.slotEndMs), original: "", isNew: true });
  const savePart = (d: PartDraft) => void w.run(async () => {
    const body = { kind: d.kind, role: d.role !== "" && d.kind !== "INSTRUMENT" ? d.role : null, startMs: msOf(d.start), endMs: msOf(d.end), originalPartyId: d.kind === "VOCAL" ? d.original : null };
    if (d.isNew) await postSlotPart({ slotId: d.slotId, partNo: d.partNo, ...body } as Parameters<typeof postSlotPart>[0]);
    else await putSlotPart(d.slotId, d.partNo, body as Parameters<typeof putSlotPart>[2]);
    setDraft(null);
  }, `파트 ${d.partNo} 저장`);
  const lastEnd = Math.max(0, ...ctx.facts.slots.map((s) => s.endMs));
  const addSlot = (f: { label: string; start: string; end: string }) => void w.run(async () => {
    const startMs = msOf(f.start), endMs = msOf(f.end);
    await postSlot({ slotId: `slt_${ctx.scopeId.replace(/^fsc_/, "")}_${String(ctx.facts.slots.length + 1).padStart(2, "0")}`, recordingId: ctx.recordingId!, startMs, endMs,
      sortOrder: Math.max(0, ...ctx.facts.slots.map((s) => s.sortOrder)) + 1, sectionLabel: f.label, parts: [{ partNo: 1, kind: "INSTRUMENT", role: null, startMs, endMs, originalPartyId: null }] });
    setSlotForm(null);
  }, "슬롯을 추가했습니다(반주 파트 1)");
  const del = (r: PartRow, first: boolean) => void w.run(() => (first && ctx.rows.filter((x) => x.slotId === r.slotId).length === 1 ? deleteCatalog("slot", r.slotId) : deleteCatalog("slot-part", r.slotId, r.partNo)), `슬롯 ${r.slotNo} 파트 ${r.partNo} 삭제`);
  const editor = (d: PartDraft) => <>
    <td><div className="p-row" style={{ gap: 4 }}>
      <select className="p-select sm" aria-label="파트 종류" value={d.kind} onChange={(e) => setDraft({ ...d, kind: e.target.value as PartKind })}>{(Object.keys(KIND) as PartKind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select>
      <input className="p-input sm" aria-label="파트 시작(초)" type="number" value={d.start} onChange={(e) => setDraft({ ...d, start: e.target.value })} style={{ width: 70 }} />
      <input className="p-input sm" aria-label="파트 끝(초)" type="number" value={d.end} onChange={(e) => setDraft({ ...d, end: e.target.value })} style={{ width: 70 }} />
    </div></td>
    <td>{d.kind === "VOCAL" ? <select className="p-select sm" aria-label="원곡 담당" value={d.original} onChange={(e) => setDraft({ ...d, original: e.target.value })}>
      <option value="">멤버 고르기</option>{ctx.members.map((m) => <option key={m.partyId} value={m.partyId}>{m.name}</option>)}</select> : "—"}</td>
    <td>{d.kind === "INSTRUMENT" ? "반주" : <select className="p-select sm" aria-label="역할" value={d.role} onChange={(e) => setDraft({ ...d, role: e.target.value })}>{Object.entries(PART_ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</td>
    <td />
    <td className="r nw"><button type="button" className="p-btn sm primary" disabled={w.busy} onClick={() => savePart(d)}>저장</button> <button type="button" className="p-btn sm" onClick={() => setDraft(null)}>취소</button></td>
  </>;
  return (
    <section className="p-card" aria-labelledby="b-perf">
      <div className="p-card-head">
        <h2 id="b-perf">실연 · 슬롯(원곡 흐름)별 파트와 담당</h2><span className="p-badge sm ir">MV 분석 시각 · 파트 경계는 추정(음원에서 확정)</span>
        {editable && <button type="button" className="p-btn" style={{ marginLeft: "auto" }} disabled={!ctx.recordingId} onClick={() => setSlotForm({ label: "", start: sec(lastEnd), end: sec(lastEnd + 10000) })}>+ 슬롯 추가</button>}
      </div>
      <div className="p-row" style={{ padding: "10px 16px", fontSize: 13, borderBottom: "1px solid var(--p-line)" }}>
        <span className="p-todo">멤버·보이스 {owned.length}:</span>
        {owned.map((o) => <span key={o.claimId} className={`p-chip${o.status === "VERIFIED" ? " on" : ""}`}>{o.name} · {o.sourceId}</span>)}
        <span className="p-todo" style={{ marginLeft: "auto" }}>슬롯 {ctx.facts.slots.length} · 보컬 파트 {counts.VOCAL} · 그룹 파트 {counts.GROUP} · 반주 파트 {counts.INSTRUMENT}</span>
      </div>
      {slotForm && (
        <div className="p-row" aria-label="슬롯 추가" style={{ padding: "10px 16px", background: "var(--p-accent-soft)", borderBottom: "1px solid var(--p-line)" }}>
          <label className="p-field">구간 이름<input className="p-input sm" value={slotForm.label} onChange={(e) => setSlotForm({ ...slotForm, label: e.target.value })} /></label>
          <label className="p-field">시작(초)<input className="p-input sm" type="number" value={slotForm.start} onChange={(e) => setSlotForm({ ...slotForm, start: e.target.value })} /></label>
          <label className="p-field">끝(초)<input className="p-input sm" type="number" value={slotForm.end} onChange={(e) => setSlotForm({ ...slotForm, end: e.target.value })} /></label>
          <button type="button" className="p-btn sm primary" disabled={slotForm.label.trim() === "" || w.busy} onClick={() => addSlot(slotForm)}>슬롯 저장</button>
          <button type="button" className="p-btn sm" onClick={() => setSlotForm(null)}>취소</button>
        </div>
      )}
      <div className="p-scroll"><table className="p-table tight" style={{ minWidth: 860 }} aria-label="슬롯·파트별 담당">
        <thead><tr><th>#</th><th>슬롯</th><th>시간</th><th>파트</th><th>원곡 담당</th><th>역할</th><th>확인</th><th className="r">관리</th></tr></thead>
        <tbody>{ctx.rows.map((r, i) => {
          const first = i === 0 || ctx.rows[i - 1]!.slotId !== r.slotId;
          const lastOfSlot = ctx.rows[i + 1]?.slotId !== r.slotId;
          const onlyInst = first && !ctx.rows.some((x) => x.slotId === r.slotId && x.kind !== "INSTRUMENT");
          const d = draft && !draft.isNew && draft.slotId === r.slotId && draft.partNo === r.partNo ? draft : null;
          const [st, cls] = state(r);
          return (
            <Fragment key={`${r.slotId}#${r.partNo}`}>
              <tr className={first ? "" : "cont"} style={r.kind !== "VOCAL" ? { color: "var(--p-muted)" } : undefined}>
                <td className="p-todo">{first ? r.slotNo : ""}</td>
                <td className="b" style={{ color: "var(--p-fg)" }}>{first ? `${r.section}${onlyInst ? " · 연주만" : ""}` : ""}</td>
                <td className="p-todo">{first ? `${mmss(r.slotStartMs)}~${mmss(r.slotEndMs)}` : ""}</td>
                {d ? editor(d) : <>
                  <td>파트 {r.partNo} · {mmss(r.startMs)}~{mmss(r.endMs)}{r.kind === "VOCAL" ? " 추정" : ""}</td>
                  <td>{r.kind === "VOCAL" ? ctx.name(r.original!) : r.kind === "GROUP" ? "전원(그룹)" : "반주(원곡 녹음)"}</td>
                  <td>{r.kind === "INSTRUMENT" ? "반주" : r.kind === "GROUP" ? `전원 ${PART_ROLE[r.role ?? ""] ?? ""}` : PART_ROLE[r.role ?? ""] ?? "—"}</td>
                  <td className={cls}>{st}</td>
                  <td className="r nw">{editable && <>
                    <button type="button" className="p-act" onClick={() => edit(r)}>수정</button>
                    {first && <> · <button type="button" className="p-act" onClick={() => addPart(r)}>파트 추가</button></>}
                    {" · "}<button type="button" className="p-act" onClick={() => del(r, first)} aria-label={`슬롯 ${r.slotNo} 파트 ${r.partNo} 삭제`}>삭제</button>
                  </>}</td>
                </>}
              </tr>
              {draft?.isNew && draft.slotId === r.slotId && lastOfSlot && (
                <tr className="cont sel"><td /><td /><td className="p-todo">새 파트 {draft.partNo}</td>{editor(draft)}</tr>
              )}
            </Fragment>
          );
        })}
          {ctx.rows.length === 0 && <tr><td colSpan={8} className="p-todo">슬롯이 없습니다. "+ 슬롯 추가"로 원곡 흐름 구간을 만든다.</td></tr>}
        </tbody>
      </table></div>
      {w.err && <div className="p-card-body"><ErrorPanel error={w.err} /></div>}
      {w.notice && <div className="p-card-foot" role="status">{w.notice}</div>}
      <div className="p-card-foot">슬롯 = 원곡이 정한 흐름 구간(연주·보컬 구분 없음). 파트 = 그 슬롯을 이루는 원곡 트랙 — 멤버별 보컬 파트(구간 안 시작~끝)와 반주 파트. 2차 이용은 파트마다 스템을 바꾸는 배치이고, 몫은 고른 보컬 스템의 파트 길이(부른 시간)로 정해진다.</div>
    </section>
  );
}

/** 수령 위임 — 몫을 대신 받는 쪽(시안: 점선 카드 한 줄). */
function MandateBucket({ ctx }: { ctx: WsCtx }) {
  const ms = ctx.facts.mandates.filter((m) => m.supersededAt === null && m.rightKind === "PERFORMER");
  const owners = rightsBuckets(ctx.facts.claims, ctx.names)[2]!.rows;
  const byTo = new Map<string, typeof ms>();
  for (const m of ms) byTo.set(m.toPartyId, [...(byTo.get(m.toPartyId) ?? []), m]);
  const contracts = `/works/${encodeURIComponent(ctx.work.workId)}/contracts`;
  return (
    <section className="p-card dashed" aria-labelledby="b-mandate">
      <div className="p-card-head">
        <h2 id="b-mandate">수령 위임 — 몫을 대신 받는 쪽</h2><span className="note">지분이 아니라 받는 경로. 표준 계약에 멤버·소속사가 서명하면 기록된다</span>
        {ctx.can("contract.draft") && <Link className="p-btn" style={{ marginLeft: "auto" }} to={contracts}>+ 위임 계약 만들기</Link>}
      </div>
      <table className="p-table"><tbody>
        {[...byTo].map(([to, xs]) => {
          const signed = xs.filter((m) => m.status === "VERIFIED");
          return (
            <tr key={to} style={{ borderTop: 0 }}><td>멤버 {xs.length}명 → <b>{ctx.name(to)}</b></td><td>실연 몫 {pctText(xs[0]!.shareBps)}</td>
              <td>{xs[0]!.validFrom.slice(0, 10)} ~ {xs[0]!.validTo?.slice(0, 10) ?? "—"}</td>
              <td className={signed.length === owners.length ? "p-ok" : "p-warn"}>서명 {signed.length}/{owners.length}{signed.length > 0 && signed.length < 3 ? `(${signed.map((m) => ctx.name(m.fromPartyId)).join(", ")})` : ""}</td>
              <td className="r"><Link to={contracts}>계약 보기</Link></td></tr>
          );
        })}
        {ms.length === 0 && <tr style={{ borderTop: 0 }}><td className="p-todo">수령 위임이 없습니다.</td></tr>}
      </tbody></table>
    </section>
  );
}

/** IR 생성 뒤(시안 Song-Locked.dc.html): 조회만 + 새 버전으로 바로잡기. 슬롯·파트는 CATALOG_SEALED라 고치지 않는다. */
function LockedRights({ ctx }: { ctx: WsCtx }) {
  const buckets = rightsBuckets(ctx.facts.claims, ctx.names);
  const parties = useParties();
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const docs = useGet<DocumentRow[]>(["documents"], "/documents");
  const w = useWrite();
  const [fix, setFix] = useState<{ bucket: "work" | "master"; rows: Draft[]; from: string; doc: string } | null>(null);
  const own = new Set((mine.data ?? []).map((p) => p.partyId));
  const ir = "IR";
  const start = (b: Bucket) => setFix({ bucket: b.key as "work" | "master", rows: [...b.rows.map((r) => ({ claimId: r.claimId, partyId: r.partyId, shareBps: r.shareBps, roleDetail: r.roleDetail ?? "LYRICS_COMPOSITION", doc: "" })), { partyId: "", shareBps: 0, roleDetail: "LYRICS_COMPOSITION", doc: "" }], from: new Date().toISOString().slice(0, 10), doc: "" });
  const total = fix ? fix.rows.reduce((a, r) => a + r.shareBps, 0) : 0;
  const save = () => void w.run(async () => {
    const b = buckets.find((x) => x.key === fix!.bucket)!;
    const sourceId = b.key === "work" ? ctx.work.workId : ctx.recordingId!;
    const doc = (docs.data ?? []).find((x) => x.documentId === fix!.doc);
    for (const d of fix!.rows.filter((r) => r.partyId !== "" && (r.claimId === undefined ? r.shareBps > 0 : b.rows.find((x) => x.claimId === r.claimId)?.shareBps !== r.shareBps))) {
      await post("/claims", {
        claimId: d.claimId ?? `c_${b.key}_${sourceId.replace(/^(wrk|rcd)_/, "")}_${d.partyId.replace(/^pty_/, "")}`, factsScopeId: ctx.scopeId, sourceId, edge: b.edge, targetId: d.partyId,
        shareBps: d.shareBps, ...(b.key === "work" && { roleDetail: d.roleDetail }), status: own.has(d.partyId) ? "VERIFIED" : "ASSERTED", validFrom: new Date(`${fix!.from}T00:00:00.000Z`).toISOString(),
        ...(doc && { evidenceDocuments: [{ documentId: doc.documentId, version: doc.version }] }),
      });
    }
    setFix(null);
  }, "새 버전을 기록했습니다 — 확인이 끝나면 분배 규칙을 재고정한다");
  return (
    <>
      <div className="p-box irs" role="status">
        <span style={{ flex: "1 1 520px" }}>분배 규칙을 만들 때 이 곡의 권리가 {ir}로 고정됐다. 이미 발행된 조합과 정산은 그 {ir}을 쓴다. 바로잡을 것이 있으면 <b>새 버전</b>으로 기록하고, 분배 규칙을 다시 고정(재고정)해야 다음 발행부터 반영된다.</span>
        {ctx.can("rights.edit") && <button type="button" className="p-btn wide ir" onClick={() => start(buckets[1]!)}>새 버전으로 바로잡기</button>}
      </div>
      {buckets.map((b) => (
        <section key={b.key} className="p-card" aria-label={b.title}>
          <div className="p-card-head"><h2>{b.title}</h2><span className="note">수정·삭제 닫힘</span></div>
          <table className="p-table">
            <thead><tr><th>권리자</th><th className="r">지분</th><th>버전</th><th>{ir}</th><th>상태</th></tr></thead>
            <tbody>{b.rows.map((r) => (
              <tr key={r.claimId}><td>{r.name}{b.key === "performer" ? ` · ${r.sourceId}` : ""}</td><td className="r">{pctText(r.shareBps)}</td><td>v{r.version}</td>
                <td>{ctx.work.sealedThrough && r.version === 1 ? "포함" : "다음 재고정부터"}</td><td className={r.status === "VERIFIED" ? "p-ok" : "p-warn"}>{r.status === "VERIFIED" ? "확정" : "확인 대기"}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ))}
      {fix && (
        <section className="p-card irline" aria-label="새 버전 만들기">
          <div className="p-card-head"><h2>새 버전 만들기 —</h2>
            <select className="p-select sm" aria-label="바로잡을 갈래" value={fix.bucket} onChange={(e) => start(buckets.find((b) => b.key === e.target.value)!)}><option value="master">녹음 · 마스터</option><option value="work">작품 · 작사·작곡</option></select>
            <span className="note">이전 버전은 그대로 남는다</span></div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) 100px minmax(0, 1.4fr) minmax(0, 1.4fr)", gap: 8, alignItems: "center" }}>
              {fix.rows.map((r, i) => (
                <Fragment key={r.claimId ?? `new${i}`}>
                  {r.claimId ? <span><b>{ctx.name(r.partyId)}</b> v{buckets.find((b) => b.key === fix.bucket)!.rows.find((x) => x.claimId === r.claimId)?.version} {pctText(buckets.find((b) => b.key === fix.bucket)!.rows.find((x) => x.claimId === r.claimId)?.shareBps ?? 0)} → 새 버전</span>
                    : <select className="p-select" aria-label="(새) 권리자" value={r.partyId} onChange={(e) => setFix({ ...fix, rows: fix.rows.map((x, k) => (k === i ? { ...x, partyId: e.target.value } : x)) })}>
                      <option value="">(새) 권리자 — 명부에서</option>{parties.items.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}</select>}
                  <input className="p-input" aria-label={r.claimId ? "새 지분" : "지분"} type="number" value={r.shareBps / 100} onChange={(e) => setFix({ ...fix, rows: fix.rows.map((x, k) => (k === i ? { ...x, shareBps: Math.round(Number(e.target.value) * 100) } : x)) })} />
                  {i === 0 ? <label className="p-field">효력 시작<input className="p-input sm" type="date" value={fix.from} onChange={(e) => setFix({ ...fix, from: e.target.value })} /></label> : <span className="p-warn" style={{ fontSize: 13 }}>{r.claimId || own.has(r.partyId) ? "" : "확인 요청 → 상대 관리 주체"}</span>}
                  {i === 0 ? <label className="p-field">근거 문서<select className="p-select sm" value={fix.doc} onChange={(e) => setFix({ ...fix, doc: e.target.value })}><option value="">고르기</option>{(docs.data ?? []).map((d) => <option key={`${d.documentId}@${d.version}`} value={d.documentId}>{d.title} v{d.version}</option>)}</select></label> : <span />}
                </Fragment>
              ))}
            </div>
            <div className="p-hint">저장하면: 새 버전 기록 → 확인이 끝나면 ⑧ "재고정 필요" → 분배 규칙 재고정(청구권자가 바뀌면 새 버전 승인·활성화) → 다음 발행부터 새 IR</div>
            {w.err && <ErrorPanel error={w.err} />}
            <div className="p-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="p-btn wide" onClick={() => setFix(null)}>취소</button>
              <button type="button" className="p-btn big ir" style={{ fontWeight: 600 }} disabled={total !== 10000 || w.busy} title={total !== 10000 ? `합계 100%여야 저장(지금 ${pctText(total)})` : undefined} onClick={save}>새 버전 저장</button>
            </div>
          </div>
        </section>
      )}
      {w.notice && <p className="p-sub" role="status">{w.notice}</p>}
      <section className="p-box" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, padding: "14px 16px" }}>
        <div><b>스템</b><br />IR 생성 뒤 새 스템 추가는 된다(다음 IR에 들어감). 기존 스템은 삭제 대신 "쓰지 않음"으로</div>
        <div><b>파트 길이</b><br />바꾸면 새 파트 버전. 이미 발행된 조합의 몫은 그대로</div>
        <div><b>멤버 동의 철회</b><br />권리 화면이 아니라 실연자 앱에서. 철회하면 새 발행이 막히고 기존 조합 노출이 멈춘다</div>
      </section>
    </>
  );
}

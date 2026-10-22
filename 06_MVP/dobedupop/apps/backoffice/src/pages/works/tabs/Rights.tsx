import { useState } from "react";
import { Link } from "react-router";
import { post } from "../../../api/registry.ts";
import { useGet } from "../../../api/hooks.ts";
import { deleteCatalog, postSlot, postSlotPart, putSlot, putSlotPart, type DocumentRow, type PartKind, type PartyRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { Section } from "../../../components/Section.tsx";
import { mmss, pctText, rightsBuckets, type Bucket, type PartRow } from "../model.ts";
import { useParties, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

const ROLE_DETAIL: [string, string][] = [["LYRICS_COMPOSITION", "작사·작곡"], ["LYRICS", "작사"], ["COMPOSITION", "작곡"]];
const roleText = (r: string | null) => ROLE_DETAIL.find(([k]) => k === r)?.[1] ?? r ?? "—";
const CLAIM_STATUS: Record<string, string> = { VERIFIED: "확정", ASSERTED: "확인 대기", DISPUTED: "분쟁 중" };
const PART_ROLE: Record<string, string> = { LEAD: "리드", HARMONY: "화음", ADLIB: "애드리브", UNISON: "제창", RAP: "랩" };
const KIND: Record<PartKind, string> = { VOCAL: "보컬", GROUP: "그룹", INSTRUMENT: "반주" };
const sec = (ms: number) => String(ms / 1000);
const ms = (s: string) => Math.round(Number(s) * 1000);

type Draft = { claimId?: string; partyId: string; shareBps: number; roleDetail: string; doc: string; changed: boolean };

/**
 * 원곡 권리 탭(시안 Song-Rights, P2): 작품·녹음·실연 세 갈래와 슬롯·파트별 원곡 담당, 수령 위임.
 * 갈래 안 지분은 갈래 합계 100%일 때만 저장된다. 다른 관리 주체의 권리는 저장하면 그쪽에 확인 요청이 간다(코어).
 * IR 생성 뒤에는 수정·삭제를 숨기고 "새 버전으로 바로잡기"(주장 새 버전)만 남긴다. 슬롯·파트는 생성 뒤 409 CATALOG_SEALED라 고칠 수 없다.
 */
export function RightsTab({ ctx }: { ctx: WsCtx }) {
  const buckets = rightsBuckets(ctx.facts.claims, ctx.names);
  const [fixing, setFixing] = useState(false);
  const editable = ctx.can("rights.edit") && (!ctx.sealed || fixing);
  return (
    <>
      {ctx.sealed && (
        <div className="note-box warn" role="status">
          <span>분배 규칙을 컴파일할 때 이 곡의 권리가 IR로 고정됐다. 이미 발행된 조합과 정산은 그 IR을 쓴다. 바로잡을 것이 있으면 <b>새 버전</b>으로 기록하고, 분배 규칙을 다시 고정(재고정)해야 다음 발행부터 반영된다.</span>
          {ctx.can("rights.edit") && <div><button type="button" className="btn" aria-pressed={fixing} onClick={() => setFixing(!fixing)}>{fixing ? "바로잡기 닫기" : "새 버전으로 바로잡기"}</button></div>}
        </div>
      )}
      <p className="muted">원곡의 권리를 세 갈래로 관리한다. 갈래 안의 지분은 여기서, 갈래 사이 비율(녹음 · 실연 · 작품)은 분배 규칙에서 정한다. 다른 관리 주체의 권리는 저장하면 그쪽에 확인 요청이 간다.</p>
      <div className="ws-grid">
        <div>
          <ShareBucket ctx={ctx} bucket={buckets[0]!} editable={editable} sourceId={ctx.work.workId} addLabel="+ 작가 추가" partyTypes={["AUTHOR", "PUBLISHER", "ARTIST"]} />
          {ctx.recordingId && <ShareBucket ctx={ctx} bucket={buckets[1]!} editable={editable} sourceId={ctx.recordingId} addLabel="+ 공동 보유자" partyTypes={["LABEL", "AGENCY", "PUBLISHER", "ARTIST"]} />}
          <PerformerBucket ctx={ctx} />
          <MandateBucket ctx={ctx} />
        </div>
        <aside aria-label="이 곡의 권리 상태">
          <div className="note-box">
            <strong>저장 규칙</strong>
            <span>· 갈래마다 합계 100%여야 저장된다</span>
            <span>· 권리자는 명부에서 고른다(우리 당사자 · 공용 명부의 작가·멤버)</span>
            <span>· 자기 당사자 권리는 바로 확정, 다른 관리 주체는 확인 요청</span>
            <span>· 지분을 바꾸면 그 권리의 확인을 다시 받는다</span>
            <span>· IR 생성 전까지 수정·삭제, 생성 뒤에는 새 버전으로</span>
          </div>
        </aside>
      </div>
    </>
  );
}

/** 작품·녹음 갈래: 행 안 수정, 추가, 합계 100%일 때만 저장(바뀐 행마다 주장 새 버전). */
function ShareBucket({ ctx, bucket, editable, sourceId, addLabel, partyTypes }: { ctx: WsCtx; bucket: Bucket; editable: boolean; sourceId: string; addLabel: string; partyTypes: string[] }) {
  const parties = useParties();
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const docs = useGet<(DocumentRow & { documentId: string })[]>(["documents"], "/documents");
  const w = useWrite();
  const rows = bucket.rows.filter((r) => r.sourceId === sourceId);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const start = () => setDrafts(rows.map((r) => ({ claimId: r.claimId, partyId: r.partyId, shareBps: r.shareBps, roleDetail: r.roleDetail ?? "LYRICS_COMPOSITION", doc: "", changed: false })));
  const total = (drafts ?? rows).reduce((a, x) => a + x.shareBps, 0);
  const own = new Set((mine.data ?? []).map((p) => p.partyId));
  const choices = parties.items.filter((p) => partyTypes.includes(p.partyType) || own.has(p.partyId));
  const set = (i: number, patch: Partial<Draft>) => setDrafts((d) => d!.map((x, k) => (k === i ? { ...x, ...patch, changed: true } : x)));
  const isWork = bucket.key === "work";
  const save = () => void w.run(async () => {
    for (const d of drafts!.filter((x) => x.changed && x.partyId !== "")) {
      const doc = (docs.data ?? []).find((x) => x.documentId === d.doc);
      await post("/claims", {
        claimId: d.claimId ?? `c_${isWork ? "work" : "master"}_${sourceId.replace(/^(wrk|rcd)_/, "")}_${d.partyId.replace(/^pty_/, "")}`,
        factsScopeId: ctx.scopeId, sourceId, edge: bucket.edge, targetId: d.partyId, shareBps: d.shareBps,
        ...(isWork && { roleDetail: d.roleDetail }), status: own.has(d.partyId) ? "VERIFIED" : "ASSERTED", validFrom: new Date().toISOString(),
        ...(doc && { evidenceDocuments: [{ documentId: doc.documentId, version: doc.version }] }),
      });
    }
    setDrafts(null);
  }, `${bucket.title} 저장 — 다른 관리 주체에는 확인 요청이 갔습니다`);
  const headId = `b-${bucket.key}`;
  return (
    <section className="section" aria-labelledby={headId}>
      <div className="section-head">
        <h2 id={headId}>{bucket.title}</h2>
        <div className="actions">
          <span className={total === 10000 ? "mark-ok" : "mark-warn"}>합계 {pctText(total)}</span>
          {editable && drafts === null && <button type="button" className="btn" onClick={start}>수정</button>}
          {editable && <button type="button" className="btn" onClick={() => { if (drafts === null) start(); setDrafts((d) => [...(d ?? rows.map((r) => ({ claimId: r.claimId, partyId: r.partyId, shareBps: r.shareBps, roleDetail: r.roleDetail ?? "LYRICS_COMPOSITION", doc: "", changed: false }))), { partyId: "", shareBps: 0, roleDetail: "LYRICS_COMPOSITION", doc: "", changed: true }]); }}>{addLabel}</button>}
        </div>
      </div>
      {drafts === null ? (
        rows.length === 0 ? <p className="muted">권리자가 없습니다.</p> : (
          <table className="data">
            <thead><tr><th scope="col">권리자</th><th scope="col">역할</th><th scope="col">지분</th><th scope="col">근거 문서</th><th scope="col">확인</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.claimId}><td>{r.name}<div className="small muted">v{r.version}</div></td><td>{isWork ? roleText(r.roleDetail) : "마스터 보유"}</td><td>{pctText(r.shareBps)}</td>
                <td>{r.evidence ?? <span className="muted">없음</span>}</td><td><span className={`badge ${r.status === "VERIFIED" ? "ok" : "warn"}`}>{CLAIM_STATUS[r.status] ?? r.status}</span></td></tr>
            ))}</tbody>
          </table>
        )
      ) : (
        <>
          <table className="data">
            <thead><tr><th scope="col">권리자</th>{isWork && <th scope="col">역할</th>}<th scope="col">지분(%)</th><th scope="col">근거 문서</th><th scope="col">저장하면</th></tr></thead>
            <tbody>{drafts.map((d, i) => (
              <tr key={d.claimId ?? `new${i}`}>
                <td>{d.claimId ? ctx.name(d.partyId) : (
                  <select aria-label="권리자" value={d.partyId} onChange={(e) => set(i, { partyId: e.target.value })}>
                    <option value="">명부에서 고르기</option>
                    {choices.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}{own.has(p.partyId) ? "(우리)" : ""}</option>)}
                  </select>
                )}</td>
                {isWork && <td><select aria-label="역할" value={d.roleDetail} onChange={(e) => set(i, { roleDetail: e.target.value })}>{ROLE_DETAIL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>}
                <td><input aria-label="지분(%)" type="number" min="0" max="100" step="0.01" value={d.shareBps / 100} onChange={(e) => set(i, { shareBps: Math.round(Number(e.target.value) * 100) })} /></td>
                <td><select aria-label="근거 문서" value={d.doc} onChange={(e) => set(i, { doc: e.target.value })}>
                  <option value="">그대로</option>{(docs.data ?? []).map((x) => <option key={`${x.documentId}@${x.version}`} value={x.documentId}>{x.title} v{x.version}</option>)}
                </select></td>
                <td className="small muted">{!d.changed ? "그대로" : own.has(d.partyId) ? "바로 확정" : "확인 요청 보냄"}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={total !== 10000 || w.busy || drafts.some((d) => d.partyId === "")} onClick={save}>{ctx.sealed ? "새 버전 저장" : "저장"}</button>
            <button type="button" className="btn" onClick={() => setDrafts(null)}>취소</button>
            {total !== 10000 && <span className="error-text" role="alert">합계 100%여야 저장(지금 {pctText(total)})</span>}
          </div>
        </>
      )}
      <ErrorPanel error={w.err} />
      {w.notice && <p role="status" className="muted">{w.notice}</p>}
    </section>
  );
}

type PartDraft = { slotId: string; partNo: number; kind: PartKind; role: string; start: string; end: string; original: string; isNew: boolean };

/** 실연 갈래: 멤버·보이스와 슬롯(원곡 흐름)별 파트·원곡 담당. 수정·파트 추가·삭제와 슬롯 추가는 IR 생성 전만. */
function PerformerBucket({ ctx }: { ctx: WsCtx }) {
  const w = useWrite();
  const [draft, setDraft] = useState<PartDraft | null>(null);
  const [slotForm, setSlotForm] = useState<{ label: string; start: string; end: string } | null>(null);
  const editable = !ctx.sealed && ctx.can("rights.edit");
  const owned = rightsBuckets(ctx.facts.claims, ctx.names)[2]!.rows;
  const counts = { slots: ctx.facts.slots.length, VOCAL: 0, GROUP: 0, INSTRUMENT: 0 };
  for (const r of ctx.rows) counts[r.kind]++;
  const state = (r: PartRow) => {
    if (r.kind === "INSTRUMENT") return "—";
    if (r.kind === "GROUP") return "그룹 · 교체 불가";
    const st = ctx.facts.stems.find((s) => s.slotId === r.slotId && s.partNo === r.partNo && s.performerPartyId === r.original);
    if (!st) return "원곡 스템 없음";
    const c = ctx.facts.claims.find((x) => x.edge === "PERFORMED_BY" && x.sourceId === st.stemId && x.supersededAt === null);
    return c ? (c.status === "VERIFIED" ? "확인됨" : "확인 대기") : "실연 주장 없음";
  };
  const edit = (r: PartRow) => setDraft({ slotId: r.slotId, partNo: r.partNo, kind: r.kind, role: r.role ?? "", start: sec(r.startMs), end: sec(r.endMs), original: r.original ?? "", isNew: false });
  const addPart = (r: PartRow) => {
    const next = Math.max(...ctx.rows.filter((x) => x.slotId === r.slotId).map((x) => x.partNo)) + 1;
    setDraft({ slotId: r.slotId, partNo: next, kind: "VOCAL", role: "LEAD", start: sec(r.slotStartMs), end: sec(r.slotEndMs), original: "", isNew: true });
  };
  const savePart = (d: PartDraft) => void w.run(async () => {
    const body = { kind: d.kind, ...(d.role !== "" && d.kind !== "INSTRUMENT" ? { role: d.role } : { role: null }), startMs: ms(d.start), endMs: ms(d.end), originalPartyId: d.kind === "VOCAL" ? d.original : null };
    if (d.isNew) await postSlotPart({ slotId: d.slotId, partNo: d.partNo, ...body } as Parameters<typeof postSlotPart>[0]);
    else await putSlotPart(d.slotId, d.partNo, body as Parameters<typeof putSlotPart>[2]);
    setDraft(null);
  }, `파트 ${d.partNo} 저장`);
  const lastEnd = Math.max(0, ...ctx.facts.slots.map((s) => s.endMs));
  const nextNo = ctx.facts.slots.length + 1;
  const slotPrefix = ctx.scopeId.replace(/^fsc_/, "");
  const addSlot = (f: { label: string; start: string; end: string }) => void w.run(async () => {
    const startMs = ms(f.start), endMs = ms(f.end);
    await postSlot({ slotId: `slt_${slotPrefix}_${String(nextNo).padStart(2, "0")}`, recordingId: ctx.recordingId!, startMs, endMs, sortOrder: Math.max(0, ...ctx.facts.slots.map((s) => s.sortOrder)) + 1,
      sectionLabel: f.label, parts: [{ partNo: 1, kind: "INSTRUMENT", role: null, startMs, endMs, originalPartyId: null }] });
    setSlotForm(null);
  }, "슬롯을 추가했습니다(반주 파트 1). 보컬 파트는 \"파트 추가\"로");
  const delPart = (r: PartRow) => void w.run(() => deleteCatalog("slot-part", r.slotId, r.partNo), `파트 ${r.slotNo}-${r.partNo} 삭제`);
  const delSlot = (r: PartRow) => void w.run(() => deleteCatalog("slot", r.slotId), `슬롯 ${r.section} 삭제`);
  const memberChoices = ctx.members;
  return (
    <section className="section" aria-labelledby="b-perf">
      <div className="section-head">
        <h2 id="b-perf">실연 · 슬롯(원곡 흐름)별 파트와 담당</h2>
        <div className="actions">{editable && ctx.recordingId && <button type="button" className="btn" onClick={() => setSlotForm({ label: "", start: sec(lastEnd), end: sec(lastEnd + 10000) })}>+ 슬롯 추가</button>}</div>
      </div>
      <div className="chips">
        <span>멤버·보이스 {owned.length}:</span>
        {owned.map((o) => <span key={o.claimId} className="chip">{o.name} · {o.sourceId}{o.status !== "VERIFIED" ? " (확인 대기)" : ""}</span>)}
        <span className="muted">슬롯 {counts.slots} · 보컬 파트 {counts.VOCAL} · 그룹 파트 {counts.GROUP} · 반주 파트 {counts.INSTRUMENT}</span>
      </div>
      {slotForm && (
        <div className="inline-form" aria-label="슬롯 추가">
          <label className="field"><span>구간 이름</span><input value={slotForm.label} onChange={(e) => setSlotForm({ ...slotForm, label: e.target.value })} placeholder="Chorus 1" /></label>
          <label className="field"><span>시작(초)</span><input type="number" value={slotForm.start} onChange={(e) => setSlotForm({ ...slotForm, start: e.target.value })} /></label>
          <label className="field"><span>끝(초)</span><input type="number" value={slotForm.end} onChange={(e) => setSlotForm({ ...slotForm, end: e.target.value })} /></label>
          <button type="button" className="btn primary" disabled={slotForm.label.trim() === "" || w.busy} onClick={() => addSlot(slotForm)}>슬롯 저장</button>
          <button type="button" className="btn" onClick={() => setSlotForm(null)}>취소</button>
        </div>
      )}
      {ctx.rows.length === 0 ? <p className="muted">슬롯이 없습니다.{editable ? " \"+ 슬롯 추가\"로 원곡 흐름 구간을 만듭니다." : ""}</p> : (
        <table className="data" aria-label="슬롯·파트별 담당">
          <thead><tr>{["#", "슬롯", "시간", "파트", "원곡 담당", "역할", "확인", ...(editable ? ["관리"] : [])].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{ctx.rows.map((r, i) => {
            const first = i === 0 || ctx.rows[i - 1]!.slotId !== r.slotId;
            const d = draft && draft.slotId === r.slotId && draft.partNo === r.partNo && !draft.isNew ? draft : null;
            return [
              <tr key={`${r.slotId}#${r.partNo}`}>
                <td>{first ? r.slotNo : ""}</td><td>{first ? r.section : ""}</td><td>{first ? `${mmss(r.slotStartMs)}~${mmss(r.slotEndMs)}` : ""}</td>
                {d ? <PartEditor d={d} onChange={setDraft} members={memberChoices} /> : <>
                  <td>파트 {r.partNo} · {KIND[r.kind]} · {mmss(r.startMs)}~{mmss(r.endMs)}</td>
                  <td>{r.kind === "VOCAL" ? ctx.name(r.original!) : r.kind === "GROUP" ? "전원(그룹)" : "반주(원곡 녹음)"}</td>
                  <td>{r.role ? PART_ROLE[r.role] ?? r.role : r.kind === "INSTRUMENT" ? "반주" : "—"}</td>
                </>}
                <td>{state(r)}</td>
                {editable && <td><div className="row-actions">
                  {d ? <><button type="button" className="btn tiny primary" disabled={w.busy} onClick={() => savePart(d)}>저장</button><button type="button" className="btn tiny" onClick={() => setDraft(null)}>취소</button></>
                    : <><button type="button" className="btn tiny" onClick={() => edit(r)}>수정</button>
                      {first && <button type="button" className="btn tiny" onClick={() => addPart(r)}>파트 추가</button>}
                      <button type="button" className="btn tiny danger" onClick={() => delPart(r)} aria-label={`슬롯 ${r.slotNo} 파트 ${r.partNo} 삭제`}>삭제</button>
                      {first && <button type="button" className="btn tiny danger" onClick={() => delSlot(r)} aria-label={`슬롯 ${r.slotNo} 삭제`}>슬롯 삭제</button>}</>}
                </div></td>}
              </tr>,
              draft?.isNew && draft.slotId === r.slotId && ctx.rows[i + 1]?.slotId !== r.slotId ? (
                <tr key={`${r.slotId}#new`}><td /><td /><td className="small muted">새 파트 {draft.partNo}</td><PartEditor d={draft} onChange={setDraft} members={memberChoices} /><td />
                  <td><div className="row-actions"><button type="button" className="btn tiny primary" disabled={w.busy} onClick={() => savePart(draft)}>저장</button><button type="button" className="btn tiny" onClick={() => setDraft(null)}>취소</button></div></td></tr>
              ) : null,
            ];
          })}</tbody>
        </table>
      )}
      {ctx.sealed && <p className="muted small">IR 생성 뒤라 슬롯·파트는 고칠 수 없다(CATALOG_SEALED). 파트 길이를 바꾸려면 새 파트 버전이 필요하다 — 상용 단계.</p>}
      <p className="muted small">슬롯 = 원곡이 정한 흐름 구간(연주·보컬 구분 없음). 파트 = 그 슬롯을 이루는 원곡 트랙 — 멤버별 보컬 파트(구간 안 시작~끝)와 반주 파트. 2차 이용은 파트마다 스템을 바꾸는 배치이고, 몫은 고른 보컬 스템의 파트 길이(부른 시간)로 정해진다.</p>
      <ErrorPanel error={w.err} />
      {w.notice && <p role="status" className="muted">{w.notice}</p>}
    </section>
  );
}

function PartEditor({ d, onChange, members }: { d: PartDraft; onChange: (d: PartDraft) => void; members: { partyId: string; name: string }[] }) {
  const parties = useParties();
  const memberOpts = members.length > 0 ? members : parties.items.filter((p) => p.partyType === "MEMBER" || p.partyType === "ARTIST").map((p) => ({ partyId: p.partyId, name: p.displayName }));
  return <>
    <td><div className="inline-form" style={{ margin: 0 }}>
      <select aria-label="파트 종류" value={d.kind} onChange={(e) => onChange({ ...d, kind: e.target.value as PartKind })}>{(Object.keys(KIND) as PartKind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select>
      <input aria-label="파트 시작(초)" type="number" value={d.start} onChange={(e) => onChange({ ...d, start: e.target.value })} style={{ width: 80 }} />
      <input aria-label="파트 끝(초)" type="number" value={d.end} onChange={(e) => onChange({ ...d, end: e.target.value })} style={{ width: 80 }} />
    </div></td>
    <td>{d.kind === "VOCAL" ? (
      <select aria-label="원곡 담당" value={d.original} onChange={(e) => onChange({ ...d, original: e.target.value })}>
        <option value="">멤버 고르기</option>{memberOpts.map((m) => <option key={m.partyId} value={m.partyId}>{m.name}</option>)}
      </select>) : <span className="muted">—</span>}</td>
    <td>{d.kind === "INSTRUMENT" ? <span className="muted">반주</span> : (
      <select aria-label="역할" value={d.role} onChange={(e) => onChange({ ...d, role: e.target.value })}>{Object.entries(PART_ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>)}</td>
  </>;
}

/** 수령 위임(실연 몫을 대신 받는 쪽). 위임은 표준 계약에 멤버·소속사가 서명하고 반영하면 기록된다. */
function MandateBucket({ ctx }: { ctx: WsCtx }) {
  const ms_ = ctx.facts.mandates.filter((m) => m.supersededAt === null && m.rightKind === "PERFORMER");
  const byTo = new Map<string, typeof ms_>();
  for (const m of ms_) byTo.set(m.toPartyId, [...(byTo.get(m.toPartyId) ?? []), m]);
  return (
    <section className="section" aria-labelledby="b-mandate">
      <div className="section-head">
        <h2 id="b-mandate">수령 위임 — 몫을 대신 받는 쪽</h2>
        <div className="actions">{ctx.can("contract.draft") && <Link className="btn" to={`/works/${encodeURIComponent(ctx.work.workId)}/contracts`}>+ 위임 계약 만들기</Link>}</div>
      </div>
      <p className="muted small">지분이 아니라 받는 경로. 표준 계약에 멤버·소속사가 서명하고 반영하면 기록된다.</p>
      {ms_.length === 0 ? <p className="muted">수령 위임이 없습니다.</p> : (
        <table className="data"><tbody>{[...byTo].map(([to, xs]) => (
          <tr key={to}><td>멤버 {xs.length}명 → <b>{ctx.name(to)}</b><div className="small muted">{xs.map((m) => ctx.name(m.fromPartyId)).join(", ")}</div></td>
            <td>실연 몫 {pctText(xs[0]!.shareBps)}</td><td>{xs[0]!.validFrom.slice(0, 10)} ~ {xs[0]!.validTo?.slice(0, 10) ?? "—"}</td>
            <td>확정 {xs.filter((m) => m.status === "VERIFIED").length}/{xs.length}</td>
            <td><Link to={`/works/${encodeURIComponent(ctx.work.workId)}/contracts`}>계약 보기</Link></td></tr>
        ))}</tbody></table>
      )}
    </section>
  );
}

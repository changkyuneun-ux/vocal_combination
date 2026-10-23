import { useState } from "react";
import { useGet } from "../../../api/hooks.ts";
import { deleteCatalog, postStem, putStem, type StemRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { currentClaims, mmss, stemIdFor, stemMatrix, type PartRow } from "../model.ts";
import { useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

type Filter = "all" | "original" | "extra" | "multi";
type Pick = { row: PartRow; singer: string | null; stem: StemRow | null };
const PART_ROLE: Record<string, string> = { LEAD: "리드", HARMONY: "화음", ADLIB: "애드리브", UNISON: "제창", RAP: "랩" };
const sec = (r: PartRow) => Math.round((r.endMs - r.startMs) / 1000);

/**
 * 스템 탭(시안 Song-Stems.dc.html): 슬롯 흐름 카드 · 스템 표(보컬 파트 × 부른 멤버, 그룹·반주는 한 칸) · 오른쪽 선택 상세 · 아래 안내 띠.
 * 빈 칸이나 "+ 스템 추가"는 같은 자리에 추가 폼(권리 주장 함께 — 그 멤버에게 확인 요청). 수정·삭제는 IR 생성 전만.
 */
export function StemsTab({ ctx }: { ctx: WsCtx }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [pick, setPick] = useState<Pick | null>(null);
  const audio = useGet<{ stemId: string; status: string }[]>(["work-stem-audio", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/stem-audio`);
  const singers = ctx.members.map((m) => m.partyId);
  const vocal = ctx.rows.filter((r) => r.kind === "VOCAL");
  const matrix = stemMatrix(ctx.rows, ctx.facts.stems, singers);
  const stems = ctx.facts.stems;
  const stemOf = (r: PartRow) => stems.find((s) => s.slotId === r.slotId && s.partNo === r.partNo) ?? null;
  const groups = ctx.rows.filter((r) => r.kind === "GROUP").length, insts = ctx.rows.filter((r) => r.kind === "INSTRUMENT").length;
  const extraCount = matrix.flat().filter((c) => c.state === "registered").length;
  const multi = new Set(ctx.facts.slots.filter((s) => s.parts.filter((p) => p.kind === "VOCAL").length > 1).map((s) => s.slotId));
  const slots = [...ctx.facts.slots].sort((a, b) => a.sortOrder - b.sortOrder);
  const first = slots[0]?.startMs ?? 0, last = slots.length ? Math.max(...slots.map((s) => s.endMs)) : 0;
  const shown = ctx.rows.filter((r) => (filter === "multi" ? multi.has(r.slotId) : filter === "extra" ? r.kind === "VOCAL" : true));
  const firstEmpty = (): Pick | null => {
    for (const [i, r] of vocal.entries()) { const k = matrix[i]!.findIndex((c) => c.state === "empty"); if (k >= 0) return { row: r, singer: singers[k]!, stem: null }; }
    return null;
  };
  return (
    <>
      <section className="p-card p-pad g10" aria-labelledby="sec" style={{ borderRadius: 12 }}>
        <div className="p-row" style={{ gap: 10 }}>
          <h2 id="sec" style={{ margin: 0, fontSize: 17 }}>슬롯 {slots.length} — 원곡 흐름 {mmss(first)}~{mmss(last)}</h2>
          <span className="p-badge sm ir">MV 분석 시각 · 파트 경계 추정</span>
          <span className="p-sub">슬롯·파트는 원곡 권리 탭에서 관리</span>
        </div>
        <div className="p-flow" aria-label="슬롯 흐름">
          {slots.map((s, i) => {
            const v = [...s.parts].sort((a, b) => a.partNo - b.partNo).filter((p) => p.kind === "VOCAL");
            const g = s.parts.find((p) => p.kind === "GROUP");
            return (
              <div key={s.slotId} className={v.length === 0 ? "inst" : ""} style={{ flex: `${s.endMs - s.startMs} 1 0` }} title={`${i + 1} ${s.sectionLabel ?? s.slotId}`}>
                <span className="n">{i + 1} {s.sectionLabel ?? s.slotId}</span>
                <span>{mmss(s.startMs)} · {v.length ? v.map((p) => ctx.name(p.originalPartyId!)).join("→") : g ? `전원 ${PART_ROLE[g.role ?? ""] ?? ""}` : "반주"}</span>
              </div>
            );
          })}
        </div>
      </section>
      <div className="p-cols">
        <section className="p-card p-pad" aria-labelledby="stems" style={{ flex: "999 1 720px", minWidth: 0 }}>
          <div className="p-row" style={{ gap: 10 }}>
            <h2 id="stems" style={{ margin: 0, fontSize: 17 }}>스템 — 슬롯·보컬 파트 × 부른 멤버</h2>
            <span className="p-sub">개인 보컬 파트 {vocal.length} × 멤버 {singers.length} = {vocal.length * singers.length} + 그룹 {groups} + 반주 {insts}</span>
            {ctx.can("rights.edit") && !ctx.sealed
              ? <button type="button" className="p-btn primary" style={{ marginLeft: "auto", fontWeight: 400 }} disabled={firstEmpty() === null} title={firstEmpty() === null ? "빈 자리가 없다" : undefined} onClick={() => setPick(firstEmpty())}>+ 스템 추가</button>
              : <button type="button" className="p-btn" style={{ marginLeft: "auto" }} disabled title={ctx.sealed ? "IR 생성 뒤 새 스템은 다음 IR — 이 화면에서는 아직 지원하지 않는다" : "권리 편집 권한이 필요하다"}>+ 스템 추가</button>}
          </div>
          <div className="p-pills" role="tablist" aria-label="스템 구분">
            {([["all", `전체 ${stems.length}`], ["original", `원곡 스템 ${vocal.length + groups + insts}(보컬 ${vocal.length} · 그룹 ${groups} · 반주 ${insts})`], ["extra", `멤버 추가 녹음 ${extraCount}`], ["multi", "여러 명 슬롯만"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <div className="p-scroll">
            <table className="p-matrix" aria-label="스템 표">
              <thead><tr><th>슬롯 · 파트 (원곡 담당) ↓ · 부른 멤버 →</th>{ctx.members.map((m) => <th key={m.partyId}>{m.name}</th>)}</tr></thead>
              <tbody>{shown.map((r, i) => {
                const firstOfSlot = i === 0 || shown[i - 1]!.slotId !== r.slotId;
                const head = r.kind === "VOCAL" ? `${firstOfSlot ? `${r.slotNo} ${r.section}` : ""} · 파트 ${r.partNo} (${ctx.name(r.original!)})`
                  : `${firstOfSlot ? `${r.slotNo} ${r.section}` : ""} · ${r.kind === "GROUP" ? `전원 ${PART_ROLE[r.role ?? ""] ?? ""}(그룹 파트, 교체 불가)` : "반주 파트(권리 부담 없음)"}`;
                if (r.kind !== "VOCAL") {
                  const st = stemOf(r);
                  const on = pick?.row === r;
                  return (
                    <tr key={`${r.slotId}#${r.partNo}`}><th className={`rowh${firstOfSlot ? "" : " cont"}`}>{head}</th>
                      <td>{filter !== "extra" && <button type="button" className={`p-cell ${st ? (r.kind === "GROUP" ? "group" : "inst") : ""}`} aria-pressed={on}
                        aria-label={`${head} ${st ? "원곡" : "없음"}`} onClick={() => setPick({ row: r, singer: null, stem: st })}>{on ? "선택" : st ? (r.kind === "GROUP" ? "그룹 원곡" : "원곡") : "—"}</button>}</td>
                      {singers.slice(1).map((s) => <td key={s} />)}
                    </tr>
                  );
                }
                const cells = matrix[vocal.indexOf(r)]!;
                return (
                  <tr key={`${r.slotId}#${r.partNo}`}><th className={`rowh${firstOfSlot ? "" : " cont"}`}>{head}</th>
                    {cells.map((c, k) => {
                      const isOrigSeat = singers[k] === r.original;
                      const visible = filter === "original" ? isOrigSeat : filter === "extra" ? !isOrigSeat : true;
                      const stem = c.stemId ? stems.find((s) => s.stemId === c.stemId) ?? null : null;
                      const on = pick?.row === r && pick.singer === singers[k];
                      const cls = c.state === "original" ? "orig" : isOrigSeat ? "origslot" : c.state === "registered" ? "reg" : "";
                      const text = on ? "선택" : c.state === "original" || isOrigSeat ? "원곡" : c.state === "registered" ? "등록" : "—";
                      return (
                        <td key={singers[k]}>{visible && (
                          <button type="button" className={`p-cell ${cls}`} aria-pressed={on} aria-label={`${head} ${ctx.members[k]!.name} ${c.state === "original" ? "원곡" : c.state === "registered" ? "등록" : "없음"}`}
                            onClick={() => setPick({ row: r, singer: singers[k]!, stem })}>{text}</button>
                        )}</td>
                      );
                    })}
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <div className="p-legend" aria-label="범례">
            <span><i className="orig" />원곡 스템 등록됨</span><span><i className="origslot" />원곡 스템 자리</span><span><i className="reg" />추가 녹음 등록됨</span><span><i className="empty" />아직 없음</span><span><i className="sel" />선택</span>
          </div>
        </section>
        {pick && <StemDetail key={`${pick.row.slotId}#${pick.row.partNo}#${pick.singer}`} ctx={ctx} pick={pick} audio={audio.data ?? []} onDone={() => setPick(null)} />}
      </div>
      <section className="p-box" style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, padding: "12px 16px", borderRadius: 10 }}>
        <span><b>스템 추가</b> = 슬롯 · 파트 · 부른 멤버 · 오디오 → 실연 권리가 함께 등록되고 그 멤버에게 확인 요청</span>
        <span><b>수정·삭제</b> = IR 생성 전까지</span>
        <span><b>2차 이용</b> = 모든 슬롯의 모든 파트에 스템 하나씩, 바꾸지 않은 파트는 원곡 스템(빠지면 PART_MISSING)</span>
      </section>
    </>
  );
}

/** 오른쪽 선택 상세(시안: 2px 진한 테두리) / 스템 추가 폼(2px 주색 테두리). */
function StemDetail({ ctx, pick, audio, onDone }: { ctx: WsCtx; pick: Pick; audio: { stemId: string; status: string }[]; onDone: () => void }) {
  const w = useWrite();
  const { row, singer, stem } = pick;
  const [rb, setRb] = useState(stem?.rightsBearing ?? row.kind === "VOCAL");
  const [edit, setEdit] = useState(false);
  const editable = !ctx.sealed && ctx.can("rights.edit");
  const role = row.kind === "INSTRUMENT" ? "반주" : PART_ROLE[row.role ?? ""] ?? "—";
  const slotText = `${row.slotNo} ${row.section} · ${mmss(row.slotStartMs)}~${mmss(row.slotEndMs)}`;
  const partText = `파트 ${row.partNo} · ${role}${row.original ? ` · 원곡 담당 ${ctx.name(row.original)}` : ""} · ${mmss(row.startMs)}~${mmss(row.endMs)}(${row.kind === "VOCAL" ? "추정, " : ""}${sec(row)}초)`;
  const basics = (who: string, bearing: boolean) => (
    <div><div className="p-sec-label">기본</div>
      <dl className="p-dl"><dt>슬롯</dt><dd>{slotText}</dd><dt>파트</dt><dd>{partText}</dd><dt>부른 멤버</dt><dd>{who}</dd><dt>권리 부담</dt><dd>{bearing ? "예" : "아니오"}</dd></dl></div>
  );
  if (stem === null) {
    const id = singer ? stemIdFor(row.slotId, row.partNo, singer) : `stm_${row.slotId.replace(/^slt_/, "")}_p${row.partNo}_${row.kind === "GROUP" ? "group" : "inst"}`;
    return (
      <aside className="p-panel form" aria-label="스템 추가" style={{ flex: "1 1 380px", maxWidth: 440 }}>
        <div className="p-pad" style={{ borderBottom: "1px solid var(--p-line)", gap: 0 }}>
          <div className="p-sub" style={{ fontSize: 12 }}>스템 추가 · 슬롯 {row.slotNo} {row.section}</div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{row.kind === "VOCAL" ? `${row.section} ${ctx.name(row.original!)} 파트를 ${ctx.name(singer!)}${singer === row.original ? "(원곡)" : "이 부름"}` : `${row.section} ${row.kind === "GROUP" ? "그룹" : "반주"} 원곡 스템`}</h2>
          <div className="p-sub p-mono" style={{ fontSize: 12 }}>{id}</div>
        </div>
        <div className="p-pad g14">
          {basics(singer ? ctx.name(singer) : "—", row.kind === "VOCAL" && rb)}
          {row.kind === "VOCAL" && <label className="p-row" style={{ gap: 6 }}><input type="checkbox" checked={rb} onChange={(e) => setRb(e.target.checked)} /> 권리 부담(실연 몫이 있다)</label>}
          <div><div className="p-sec-label">오디오</div><span className="p-tag" title="스템 오디오 올리기는 모아 보기 › 스템 오디오·검수 화면에서">올리기 전</span></div>
          <span className="p-sub">{row.kind === "VOCAL" ? "저장하면 실연 권리가 함께 등록되고 그 멤버에게 확인 요청이 간다." : "그룹·반주 스템은 권리 부담 없이 원곡 스템으로 등록한다."}</span>
          {w.err && <ErrorPanel error={w.err} />}
          <div className="p-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="p-btn" onClick={onDone}>취소</button>
            <button type="button" className="p-btn primary" disabled={!editable || w.busy || !ctx.recordingId} title={!editable ? (ctx.sealed ? "IR 생성 뒤 새 스템은 다음 IR — 이 화면에서는 아직 지원하지 않는다" : "권리 편집 권한이 필요하다") : undefined}
              onClick={() => void w.run(async () => { await postStem({ stemId: id, slotId: row.slotId, partNo: row.partNo, recordingId: ctx.recordingId!, ...(singer && { performerPartyId: singer }), rightsBearing: row.kind === "VOCAL" && rb, withClaims: true }); onDone(); }, `스템 ${id}을 등록했습니다`)}>스템 저장</button>
          </div>
        </div>
      </aside>
    );
  }
  const cur = currentClaims(ctx.facts.claims);
  const perf = cur.find((c) => c.edge === "PERFORMED_BY" && c.sourceId === stem.stemId);
  const master = cur.filter((c) => c.edge === "CONTROLLED_BY");
  const authors = cur.filter((c) => c.edge === "WRITTEN_BY");
  const au = audio.find((a) => a.stemId === stem.stemId);
  const isOrig = row.kind !== "VOCAL" || stem.performerPartyId === row.original;
  const title = row.kind !== "VOCAL" ? `${row.section} ${row.kind === "GROUP" ? "그룹" : "반주"} 원곡 스템` : isOrig ? `${row.section} ${ctx.name(row.original!)} 파트 원곡` : `${row.section} ${ctx.name(row.original!)} 파트를 ${ctx.name(stem.performerPartyId!)}이 부름`;
  return (
    <aside className="p-panel" aria-labelledby="sel" style={{ flex: "1 1 380px", maxWidth: 440 }}>
      <div className="p-row" style={{ padding: "14px 16px", borderBottom: "1px solid var(--p-line)", gap: 8 }}>
        <div style={{ flex: "1 1 200px" }}>
          <div className="p-sub" style={{ fontSize: 12 }}>{isOrig ? "원곡 스템" : "멤버 추가 녹음"} · 슬롯 {row.slotNo} {row.section}</div>
          <h2 id="sel" style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <div className="p-sub p-mono" style={{ fontSize: 12 }}>{stem.stemId}</div>
        </div>
        {editable ? <>
          <button type="button" className="p-linkbtn" style={{ fontSize: 14 }} onClick={() => setEdit(!edit)}>수정</button>
          <button type="button" className="p-linkbtn" style={{ fontSize: 14 }} onClick={() => void w.run(async () => { await deleteCatalog("stem", stem.stemId); onDone(); }, `스템 ${stem.stemId} 삭제`)}>삭제</button>
        </> : <><button type="button" className="p-linkbtn" disabled title="IR 생성 뒤에는 수정·삭제 닫힘">수정</button><button type="button" className="p-linkbtn" disabled title="IR 생성 뒤에는 수정·삭제 닫힘">삭제</button></>}
      </div>
      <div className="p-pad g14">
        {basics(stem.performerPartyId ? ctx.name(stem.performerPartyId) : "—", stem.rightsBearing)}
        {edit && (
          <div className="p-row">
            <label className="p-row" style={{ gap: 6 }}><input type="checkbox" checked={rb} onChange={(e) => setRb(e.target.checked)} /> 권리 부담</label>
            <button type="button" className="p-btn sm primary" onClick={() => void w.run(async () => { await putStem(stem.stemId, { rightsBearing: rb }); setEdit(false); }, "스템을 고쳤습니다")}>저장</button>
          </div>
        )}
        <div><div className="p-sec-label">이 스템의 권리</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="p-kvbox">실연 — {perf ? <>{ctx.name(stem.performerPartyId ?? "")}({perf.targetId}) · <span className={perf.status === "VERIFIED" ? "p-ok" : "p-warn"}>{perf.status === "VERIFIED" ? "본인 확인됨" : "본인 확인 대기"}</span></> : "실연 주장 없음(권리 부담 없음)"}</div>
            <div className="p-kvbox">녹음 — {master.map((c) => `${ctx.name(c.targetId)} ${c.shareBps / 100}%`).join(", ") || "없음"}(원곡 권리를 따른다)</div>
            <div className="p-kvbox">작품 — 작가 {authors.length}명 {authors.map((c) => c.shareBps / 100).join("·")}</div>
          </div></div>
        <div><div className="p-sec-label">조합에서</div><span>{row.kind === "VOCAL" ? (isOrig ? `바꾸지 않은 배치(원곡)에서 ${row.section} 슬롯의 파트 ${row.partNo}를 채운다.` : `2차 이용 = ${row.section} 슬롯의 파트 ${row.partNo}를 원곡(${ctx.name(row.original!)}) 대신 이 스템으로 바꾸는 배치. ${ctx.name(stem.performerPartyId!)}의 부른 시간은 ${sec(row)}초 늘고 ${ctx.name(row.original!)}은 ${sec(row)}초 준다(SL2)`)
          : row.kind === "GROUP" ? "그룹 파트는 바꿀 수 없고 사용 시간에 넣지 않는다(SL7)" : "반주 파트는 권리 부담이 없어 사용 시간에 넣지 않는다(SL6)"}</span></div>
        <div><div className="p-sec-label">오디오</div><span className={au?.status === "READY" ? "p-badge ok" : "p-tag"}>{au ? au.status : "올리기 전"}</span></div>
        {w.err && <ErrorPanel error={w.err} />}
      </div>
    </aside>
  );
}

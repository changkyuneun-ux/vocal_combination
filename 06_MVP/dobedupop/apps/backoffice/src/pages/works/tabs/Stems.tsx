import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useGet } from "../../../api/hooks.ts";
import { postStem, putStem, putStemAudio, retireStem, type StemAudio, type StemRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { currentClaims, mmss, stemIdFor, stemMatrix, type PartRow } from "../model.ts";
import { useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";
import { B, Kv, Note } from "../../ops/common.tsx";

type Filter = "all" | "original" | "extra" | "multi";
const PART_ROLE: Record<string, string> = { LEAD: "리드", HARMONY: "화음", ADLIB: "애드리브", UNISON: "제창", RAP: "랩" };
const sec = (r: PartRow) => Math.round((r.endMs - r.startMs) / 1000);

/**
 * 스템 탭(시안 Song-Stems.dc.html): 슬롯 흐름 카드 · 스템 표(보컬 파트 × 부른 멤버, 그룹·반주는 한 칸) · 오른쪽 선택 상세 · 아래 안내 띠.
 * 오른쪽 칸(시안 Song-Stems-Panel)은 한 번에 하나(상세·수정·추가): 같은 칸을 다시 누르거나 × 를 누르면 닫히고 표가 넓어진다.
 * "+ 스템 추가"(제목 줄)도 다시 누르면 닫힌다. 수정은 오디오·권리 부담만(슬롯·파트·부른 멤버는 쓰지 않음 후 새로 추가).
 * IR 고정 뒤: 추가는 된다(다음 IR), 기존 스템은 지우지 않고 쓰지 않음, 오디오 바꾸기는 새 버전(다음 재고정부터).
 */
export function StemsTab({ ctx }: { ctx: WsCtx }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("ws-title-actions")), []);
  const audio = useGet<StemAudio[]>(["work-stem-audio", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/stem-audio`);
  const singers = ctx.members.map((m) => m.partyId);
  const vocal = ctx.rows.filter((r) => r.kind === "VOCAL");
  const matrix = stemMatrix(ctx.rows, ctx.facts.stems.filter((s) => !s.retiredAt), singers);
  const stems = ctx.facts.stems.filter((s) => !s.retiredAt); // 쓰지 않음으로 뺀 스템은 표에 두지 않는다
  const stemOf = (r: PartRow) => stems.find((s) => s.slotId === r.slotId && s.partNo === r.partNo) ?? null;
  const groups = ctx.rows.filter((r) => r.kind === "GROUP").length, insts = ctx.rows.filter((r) => r.kind === "INSTRUMENT").length;
  const extraCount = matrix.flat().filter((c) => c.state === "registered").length;
  const multi = new Set(ctx.facts.slots.filter((s) => s.parts.filter((p) => p.kind === "VOCAL").length > 1).map((s) => s.slotId));
  const slots = [...ctx.facts.slots].sort((a, b) => a.sortOrder - b.sortOrder);
  const first = slots[0]?.startMs ?? 0, last = slots.length ? Math.max(...slots.map((s) => s.endMs)) : 0;
  const shown = ctx.rows.filter((r) => (filter === "multi" ? multi.has(r.slotId) : filter === "extra" ? r.kind === "VOCAL" : true));
  const same = (r: PartRow, singer: string | null) => panel !== null && panel.row !== null && panel.row.slotId === r.slotId && panel.row.partNo === r.partNo && panel.singer === singer;
  /** 칸 누르기: 같은 칸이면 닫는다(토글). 스템이 있으면 상세, 없으면 그 자리로 추가 폼. */
  const toggle = (r: PartRow, singer: string | null, stem: StemRow | null) =>
    setPanel(same(r, singer) ? null : stem ? { mode: "detail", row: r, singer, stem } : { mode: "add", row: r, singer });
  const addOpen = panel?.mode === "add" && panel.row === null;
  const addBtn = ctx.can("rights.edit")
    ? <button type="button" className="p-btn primary" aria-pressed={addOpen} onClick={() => setPanel(addOpen ? null : { mode: "add", row: null, singer: null })}>+ 스템 추가</button>
    : <button type="button" className="p-btn primary" disabled title="권리 편집 권한이 필요하다">+ 스템 추가</button>;
  return (
    <>
      {slot && createPortal(addBtn, slot)}
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
                  const on = same(r, null);
                  return (
                    <tr key={`${r.slotId}#${r.partNo}`}><th className={`rowh${firstOfSlot ? "" : " cont"}`}>{head}</th>
                      <td>{filter !== "extra" && <button type="button" className={`p-cell ${st ? (r.kind === "GROUP" ? "group" : "inst") : ""}`} aria-pressed={on}
                        aria-label={`${head} ${st ? "원곡" : "없음"}`} onClick={() => toggle(r, null, st)}>{on ? "선택" : st ? (r.kind === "GROUP" ? "그룹 원곡" : "원곡") : "—"}</button>}</td>
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
                      const on = same(r, singers[k]!);
                      const cls = c.state === "original" ? "orig" : isOrigSeat ? "origslot" : c.state === "registered" ? "reg" : "";
                      const text = on ? "선택" : c.state === "original" || isOrigSeat ? "원곡" : c.state === "registered" ? "등록" : "—";
                      return (
                        <td key={singers[k]}>{visible && (
                          <button type="button" className={`p-cell ${cls}`} aria-pressed={on} aria-label={`${head} ${ctx.members[k]!.name} ${c.state === "original" ? "원곡" : c.state === "registered" ? "등록" : "없음"}`}
                            onClick={() => toggle(r, singers[k]!, stem)}>{text}</button>
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
        {panel && (panel.mode === "add"
          ? <AddSide key={`add#${panel.row?.slotId}#${panel.row?.partNo}#${panel.singer}`} ctx={ctx} seed={panel.row} seedSinger={panel.singer} onClose={() => setPanel(null)} />
          : <StemSide key={`${panel.stem.stemId}#${panel.mode}`} ctx={ctx} panel={panel} audio={audio.data ?? []} onClose={() => setPanel(null)} onMode={(m) => setPanel({ ...panel, mode: m })} />)}
      </div>
      <section className="p-box" style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, padding: "12px 16px", borderRadius: 10 }}>
        <span><b>스템 추가</b> = 슬롯 · 파트 · 부른 멤버 · 오디오 → 실연 권리가 함께 등록되고 그 멤버에게 확인 요청</span>
        <span><b>수정</b> = 오디오·권리 부담만(잘못 넣었으면 쓰지 않음 후 새로 추가)</span>
        <span><b>IR 고정 뒤</b> = 추가는 다음 IR, 기존 스템은 쓰지 않음, 오디오는 새 버전(다음 재고정부터)</span>
        <span><b>2차 이용</b> = 모든 슬롯의 모든 파트에 스템 하나씩, 바꾸지 않은 파트는 원곡 스템(빠지면 PART_MISSING)</span>
      </section>
    </>
  );
}

/** 오른쪽 칸(시안 Song-Stems-Panel side_panel): 머리(작은 제목 · 제목 · id · × 닫기) → 본문 → 아래 버튼. 2px 주색 테두리. */
export function SidePanel({ label, kicker, title, sid, onClose, children, actions }: { label: string; kicker: string; title: string; sid?: string; onClose: () => void; children: ReactNode; actions: ReactNode }) {
  return (
    <aside className="p-card" aria-label={label} style={{ flex: "1 1 380px", maxWidth: 440, border: "2px solid var(--p-accent)", display: "flex", flexDirection: "column", alignSelf: "flex-start" }}>
      <div style={{ padding: "16px 18px", display: "flex", gap: 10, alignItems: "flex-start", borderBottom: "1px solid var(--p-line)" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: "var(--p-muted)" }}>{kicker}</div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{title}</h2>
          {sid && <div className="p-mono" style={{ fontSize: 13, color: "var(--p-muted)" }}>{sid}</div>}
        </div>
        <button type="button" className="p-btn" aria-label="닫기" style={{ width: 32, height: 32, padding: 0, fontSize: 18, lineHeight: 1, borderRadius: 8, flex: "0 0 auto" }} onClick={onClose}>×</button>
      </div>
      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
      <div style={{ padding: "14px 18px", borderTop: "1px solid var(--p-line)", display: "flex", gap: 8, justifyContent: "flex-end" }}>{actions}</div>
    </aside>
  );
}

/** 입력 칸(시안 field()): 위 라벨 14px 700, 아래 설명 12px. */
export const Field = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
    <span style={{ fontWeight: 700, color: "var(--p-fg)" }}>{label}</span>{children}
    {hint && <div style={{ fontSize: 12, color: "var(--p-muted)" }}>{hint}</div>}
  </div>
);

/** 예 / 아니오(반주) 칩. */
const BearingChips = ({ value, onChange, disabled, title }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) => (
  <div className="p-row" style={{ gap: 6 }} role="radiogroup" aria-label="권리 부담">
    {([[true, "예"], [false, "아니오(반주)"]] as const).map(([v, l]) => (
      <button key={l} type="button" role="radio" aria-checked={value === v} className={`p-chip2${value === v ? " on" : ""}`} disabled={disabled} title={title} onClick={() => onChange(v)}>{l}</button>
    ))}
  </div>
);

/** 오디오 파일 고르기(숨은 input). */
function FilePick({ file, current, onFile, label }: { file: File | null; current?: string; onFile: (f: File | null) => void; label: string }) {
  const id = `f-${label}`;
  return (
    <div className="p-input" style={{ display: "flex", justifyContent: "space-between", gap: 8, color: file || current ? "var(--p-fg)" : "var(--p-muted)" }}>
      <span>{file ? file.name : current ?? <>파일 끌어 놓기 또는 <label htmlFor={id} style={{ color: "var(--p-link)", fontWeight: 600, cursor: "pointer" }}>고르기</label> · WAV 48kHz</>}</span>
      {(file || current) && <label htmlFor={id} style={{ color: "var(--p-link)", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>바꾸기</label>}
      <input id={id} aria-label={label} type="file" accept="audio/*" style={{ position: "absolute", left: -9999 }} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </div>
  );
}

type Panel = { mode: "detail" | "edit"; row: PartRow; singer: string | null; stem: StemRow } | { mode: "add"; row: PartRow | null; singer: string | null };
const partLabel = (r: PartRow, name: (p: string) => string) => `${r.slotNo} ${r.section} · 파트 ${r.partNo}${r.original ? `(원곡 담당 ${name(r.original)})` : r.kind === "GROUP" ? "(그룹)" : "(반주)"}`;

/** 상세(IR 전) · IR 고정 뒤 · 수정 폼. */
function StemSide({ ctx, panel, audio, onClose, onMode }: { ctx: WsCtx; panel: Extract<Panel, { stem: StemRow }>; audio: StemAudio[]; onClose: () => void; onMode: (m: "detail" | "edit") => void }) {
  const w = useWrite();
  const { row, stem } = panel;
  const [rb, setRb] = useState(stem.rightsBearing);
  const [file, setFile] = useState<File | null>(null);
  const editable = ctx.can("rights.edit");
  const role = row.kind === "INSTRUMENT" ? "반주" : PART_ROLE[row.role ?? ""] ?? "—";
  const cur = currentClaims(ctx.facts.claims);
  const perf = cur.find((c) => c.edge === "PERFORMED_BY" && c.sourceId === stem.stemId);
  const master = cur.filter((c) => c.edge === "CONTROLLED_BY");
  const authors = cur.filter((c) => c.edge === "WRITTEN_BY");
  const au = audio.find((a) => a.stemId === stem.stemId);
  const isOrig = row.kind !== "VOCAL" || stem.performerPartyId === row.original;
  const title = row.kind !== "VOCAL" ? `${row.section} ${row.kind === "GROUP" ? "그룹" : "반주"} 원곡 스템` : isOrig ? `${row.section} ${ctx.name(row.original!)} 파트 원곡` : `${row.section} ${ctx.name(row.original!)} 파트를 ${ctx.name(stem.performerPartyId!)}이 부름`;
  const inIr = ctx.sealed && ctx.work.sealedThrough !== null && (stem.createdAt ?? "") <= ctx.work.sealedThrough;
  const kind = isOrig ? "원곡 스템" : "멤버 추가 녹음";
  const irV = `IR v${ctx.irVersion}`;
  const retire = () => void w.run(async () => { await retireStem(stem.stemId); onClose(); }, `스템 ${stem.stemId}을 쓰지 않음으로 뺐습니다 — 새 발행에 쓰지 않는다`);
  const audioText = au ? `${au.status}${au.next ? ` · 새 버전 ${au.next.status}(다음 재고정부터)` : ""}` : "올리기 전";
  if (panel.mode === "edit") {
    return (
      <SidePanel label="스템 수정" kicker={`스템 수정 · ${stem.stemId}`} title={title} onClose={onClose}
        actions={<><button type="button" className="p-btn" onClick={() => onMode("detail")}>취소</button>
          <button type="button" className="p-btn primary" disabled={w.busy || (file === null && rb === stem.rightsBearing)}
            onClick={() => void w.run(async () => {
              if (file) await putStemAudio(stem.stemId, file);
              if (rb !== stem.rightsBearing) await putStem(stem.stemId, { rightsBearing: rb });
              onMode("detail");
            }, inIr && file ? "새 오디오를 올렸습니다 — 다음 재고정부터 쓴다" : "스템을 고쳤습니다")}>저장</button></>}>
        <Field label="오디오 파일" hint={inIr ? "오디오를 바꾸면 새 버전 — 다음 재고정부터 쓴다. 이미 발행된 조합은 이전 오디오 그대로" : "오디오를 바꾸면 새 버전 — 이미 발행된 조합은 이전 오디오 그대로"}>
          <FilePick file={file} current={au ? `${stem.stemId}.wav` : undefined} onFile={setFile} label="오디오 파일" /></Field>
        <Field label="부른 멤버" hint="슬롯·파트와 부른 멤버는 바꿀 수 없다 — 잘못 넣었으면 쓰지 않음 후 새로 추가">
          <select className="p-select" aria-label="부른 멤버" disabled><option>{stem.performerPartyId ? ctx.name(stem.performerPartyId) : "—"}</option></select></Field>
        <Field label="권리 부담"><BearingChips value={rb} onChange={setRb} disabled={inIr} title={inIr ? `${irV}에 든 스템은 권리 부담을 바꾸지 않는다 — 쓰지 않음 후 새로 추가` : undefined} /></Field>
        {w.err && <ErrorPanel error={w.err} />}
      </SidePanel>
    );
  }
  if (inIr) {
    return (
      <SidePanel label="선택한 스템" kicker={`${kind} · ${irV} 포함`} title={title} sid={stem.stemId} onClose={onClose}
        actions={editable ? <><button type="button" className="p-btn" disabled={w.busy} onClick={retire}>쓰지 않음</button><button type="button" className="p-btn primary" onClick={() => onMode("edit")}>새 버전(오디오 바꾸기)</button></> : null}>
        <Note tone="warn">{irV}로 고정된 스템이다. 지울 수 없고 '쓰지 않음'으로 새 발행에서 뺀다. 오디오를 바꾸면 새 버전으로 다음 재고정부터 쓰인다.</Note>
        <Kv pairs={[["상태", <B key="s" tone="ir">{irV} 포함</B>], ["오디오", audioText], ["이미 발행된 조합", "그대로 유지"]]} />
        {w.err && <ErrorPanel error={w.err} />}
      </SidePanel>
    );
  }
  return (
    <SidePanel label="선택한 스템" kicker={`${kind} · 슬롯 ${row.slotNo} ${row.section}`} title={title} sid={stem.stemId} onClose={onClose}
      actions={editable ? <><button type="button" className="p-btn" disabled={w.busy} onClick={retire}>쓰지 않음</button><button type="button" className="p-btn primary" onClick={() => onMode("edit")}>수정</button></> : null}>
      <Kv pairs={[["슬롯", `${row.slotNo} ${row.section} · ${mmss(row.slotStartMs)}~${mmss(row.slotEndMs)}`], ["파트", `파트 ${row.partNo} · ${role}${row.original ? ` · 원곡 담당 ${ctx.name(row.original)}` : ""}`],
        ["부른 멤버", stem.performerPartyId ? ctx.name(stem.performerPartyId) : "—"], ["오디오", au ? `${stem.stemId}.wav · ${audioText}` : "올리기 전"], ["권리 부담", stem.rightsBearing ? "예" : "아니오"]]} />
      <div style={{ fontSize: 14, fontWeight: 700 }}>이 스템의 권리</div>
      <Kv pairs={[
        ["실연", perf ? <>{ctx.name(stem.performerPartyId ?? "")}({perf.targetId}) · <B tone={perf.status === "VERIFIED" ? "ok" : "warn"}>{perf.status === "VERIFIED" ? "본인 확인됨" : "본인 확인 대기"}</B></> : "실연 주장 없음(권리 부담 없음)"],
        ["녹음", `${master.map((c) => `${ctx.name(c.targetId)} ${c.shareBps / 100}%`).join(", ") || "없음"}(원곡 권리)`],
        ["작품", `작가 ${authors.length}명 ${authors.map((c) => c.shareBps / 100).join("·")}`],
      ]} />
      {w.err && <ErrorPanel error={w.err} />}
    </SidePanel>
  );
}

/** 추가 폼: 슬롯·파트 · 부른 멤버(이 곡 멤버만) · 오디오 · 권리 부담. 저장하면 실연 주장 함께 + 부른 멤버에게 확인 요청(ID3). */
function AddSide({ ctx, seed, seedSinger, onClose }: { ctx: WsCtx; seed: PartRow | null; seedSinger: string | null; onClose: () => void }) {
  const w = useWrite();
  const parts = ctx.rows;
  const key = (r: PartRow) => `${r.slotId}#${r.partNo}`;
  const firstVocal = parts.find((r) => r.kind === "VOCAL") ?? parts[0];
  const [part, setPart] = useState(seed ? key(seed) : firstVocal ? key(firstVocal) : "");
  const row = parts.find((r) => key(r) === part) ?? null;
  const [singer, setSinger] = useState(seedSinger ?? ctx.members[0]?.partyId ?? "");
  const [rb, setRb] = useState(row?.kind === "VOCAL");
  const [file, setFile] = useState<File | null>(null);
  const vocal = row?.kind === "VOCAL";
  const editable = ctx.can("rights.edit") && !!ctx.recordingId;
  const newId = () => {
    const base = vocal ? stemIdFor(row!.slotId, row!.partNo, singer) : `stm_${row!.slotId.replace(/^slt_/, "")}_p${row!.partNo}_${row!.kind === "GROUP" ? "group" : "inst"}`;
    const taken = new Set(ctx.facts.stems.map((s) => s.stemId));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_v${n}`)) return `${base}_v${n}`;
  };
  const add = () => void w.run(async () => {
    const id = newId();
    await postStem({ stemId: id, slotId: row!.slotId, partNo: row!.partNo, recordingId: ctx.recordingId!, ...(vocal && { performerPartyId: singer }), rightsBearing: vocal && rb, withClaims: true });
    if (file) await putStemAudio(id, file);
    onClose();
  }, ctx.sealed ? "스템을 추가했습니다 — 다음 IR에 들어간다" : "스템을 추가했습니다 — 부른 멤버에게 확인 요청");
  return (
    <SidePanel label="스템 추가" kicker="스템 추가" title="새 스템" onClose={onClose}
      actions={<><button type="button" className="p-btn" onClick={onClose}>취소</button>
        <button type="button" className="p-btn primary" disabled={!editable || !row || w.busy} title={editable ? undefined : "권리 편집 권한이 필요하다"} onClick={add}>추가</button></>}>
      <Field label="슬롯 · 파트"><select className="p-select" aria-label="슬롯 · 파트" value={part} onChange={(e) => { setPart(e.target.value); const r = parts.find((x) => key(x) === e.target.value); setRb(r?.kind === "VOCAL"); }}>
        {parts.map((r) => <option key={key(r)} value={key(r)}>{partLabel(r, ctx.name)}</option>)}</select></Field>
      <Field label="부른 멤버" hint={vocal ? "이 곡의 멤버만. 원곡 담당이면 원곡 스템" : "그룹·반주 파트는 원곡 스템 하나(부른 멤버 없음)"}>
        <select className="p-select" aria-label="부른 멤버" value={vocal ? singer : ""} disabled={!vocal} onChange={(e) => setSinger(e.target.value)}>
          {vocal ? ctx.members.map((m) => <option key={m.partyId} value={m.partyId}>{m.name}</option>) : <option value="">—</option>}</select></Field>
      <Field label="오디오 파일"><FilePick file={file} onFile={setFile} label="오디오 파일" /></Field>
      <Field label="권리 부담"><BearingChips value={vocal && rb} onChange={setRb} disabled={!vocal} /></Field>
      <Note>{ctx.sealed ? `저장하면 실연 주장이 함께 만들어지고 부른 멤버에게 확인 요청이 간다(ID3). IR v${ctx.irVersion}로 고정된 뒤라 다음 IR에 들어간다.` : "저장하면 실연 주장이 함께 만들어지고 부른 멤버에게 확인 요청이 간다(ID3)."}</Note>
      {w.err && <ErrorPanel error={w.err} />}
    </SidePanel>
  );
}

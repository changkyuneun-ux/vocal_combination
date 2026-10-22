import { useState } from "react";
import { Link } from "react-router";
import { useGet } from "../../../api/hooks.ts";
import { deleteCatalog, postStem, putStem, type StemRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { Section } from "../../../components/Section.tsx";
import { mmss, stemIdFor, stemMatrix, type PartRow } from "../model.ts";
import { useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

type Filter = "all" | "original" | "extra" | "multi";
type Pick = { row: PartRow; singer: string | null; stem: StemRow | null };
const KIND_LABEL: Record<string, string> = { VOCAL: "보컬", GROUP: "그룹", INSTRUMENT: "반주" };

/**
 * 스템 탭(시안 Song-Stems, P2): 슬롯 흐름 띠(길이 비례, 연주만 슬롯은 점선), 보컬 파트 × 부른 멤버 표, 그룹·반주 파트는 한 칸.
 * 칸을 누르면 오른쪽에 스템 상세, 빈 칸이면 같은 자리에 "스템 추가"(권리 주장 함께 — 그 멤버에게 확인 요청). 수정·삭제는 IR 생성 전만.
 */
export function StemsTab({ ctx }: { ctx: WsCtx }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [pick, setPick] = useState<Pick | null>(null);
  const audio = useGet<{ stemId: string; status: string }[]>(["work-stem-audio", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/stem-audio`);
  const singers = ctx.members.map((m) => m.partyId);
  const vocal = ctx.rows.filter((r) => r.kind === "VOCAL");
  const matrix = stemMatrix(ctx.rows, ctx.facts.stems, singers);
  const stems = ctx.facts.stems;
  const origCount = ctx.rows.filter((r) => stems.some((s) => s.slotId === r.slotId && s.partNo === r.partNo && (r.kind !== "VOCAL" || s.performerPartyId === r.original))).length;
  const extraCount = matrix.flat().filter((c) => c.state === "registered").length;
  const multi = new Set(ctx.facts.slots.filter((s) => s.parts.filter((p) => p.kind === "VOCAL").length > 1).map((s) => s.slotId));
  const total = ctx.facts.slots.reduce((a, s) => a + (s.endMs - s.startMs), 0);
  const first = ctx.facts.slots.length ? Math.min(...ctx.facts.slots.map((s) => s.startMs)) : 0;
  const last = ctx.facts.slots.length ? Math.max(...ctx.facts.slots.map((s) => s.endMs)) : 0;
  const slotsSorted = [...ctx.facts.slots].sort((a, b) => a.sortOrder - b.sortOrder);
  const rowsShown = ctx.rows.filter((r) => filter !== "multi" || multi.has(r.slotId));
  const show = (state: string) => filter === "all" || filter === "multi" || (filter === "original" ? state === "original" : state === "registered");
  return (
    <>
      <Section title={`슬롯 ${ctx.facts.slots.length} — 원곡 흐름 ${mmss(first)}~${mmss(last)}`}>
        <p className="muted small">슬롯·파트는 원곡 권리 탭에서 관리한다.</p>
        <div className="flow" aria-label="슬롯 흐름">
          {slotsSorted.map((s, i) => {
            const v = s.parts.filter((p) => p.kind === "VOCAL");
            const g = s.parts.find((p) => p.kind === "GROUP");
            return (
              <div key={s.slotId} className={v.length === 0 && !g ? "inst" : ""} style={{ flex: `${s.endMs - s.startMs} 1 0` }} title={`${i + 1} ${s.sectionLabel ?? s.slotId}`}>
                <span>{i + 1} {s.sectionLabel ?? s.slotId}</span>
                <span>{mmss(s.startMs)} · {v.length ? v.map((p) => ctx.name(p.originalPartyId!)).join("→") : g ? "그룹" : "반주"}</span>
              </div>
            );
          })}
          {total === 0 && <p className="muted">슬롯이 없습니다.</p>}
        </div>
      </Section>
      <div className="ws-grid">
        <Section title="스템 — 슬롯·보컬 파트 × 부른 멤버">
          <p className="muted small">보컬 파트 {vocal.length} × 멤버 {singers.length} 자리 + 그룹·반주 {ctx.rows.length - vocal.length}</p>
          <div className="tabs" role="tablist" aria-label="스템 구분">
            {([["all", `전체 ${stems.length}`], ["original", `원곡 스템 ${origCount}`], ["extra", `멤버 추가 녹음 ${extraCount}`], ["multi", "여러 명 슬롯만"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          {singers.length === 0 ? <p className="muted">멤버가 없습니다. 원곡 권리 탭에서 파트의 원곡 담당을 정하거나 새 곡 마법사의 멤버 단계를 마칩니다.</p> : (
            <div style={{ overflowX: "auto" }}>
              <table className="data matrix" aria-label="스템 표">
                <thead><tr><th scope="col">슬롯 · 파트 (원곡 담당) ↓ · 부른 멤버 →</th>{ctx.members.map((m) => <th key={m.partyId} scope="col">{m.name}</th>)}</tr></thead>
                <tbody>{rowsShown.map((r, i) => {
                  const head = `${i === 0 || rowsShown[i - 1]!.slotId !== r.slotId ? `${r.slotNo} ${r.section}` : ""} · 파트 ${r.partNo}`;
                  if (r.kind !== "VOCAL") {
                    const st = stems.find((s) => s.slotId === r.slotId && s.partNo === r.partNo) ?? null;
                    return (
                      <tr key={`${r.slotId}#${r.partNo}`}><th scope="row">{head} · {r.kind === "GROUP" ? "그룹 파트(교체 불가)" : "반주 파트(권리 부담 없음)"}</th>
                        <td colSpan={singers.length} style={{ textAlign: "left" }}>
                          <button type="button" className={`cell ${st ? (r.kind === "GROUP" ? "group" : "inst") : ""}`} style={{ width: 120 }} aria-pressed={pick?.row === r}
                            aria-label={`${head} ${KIND_LABEL[r.kind]} ${st ? "원곡 스템" : "없음"}`} onClick={() => setPick({ row: r, singer: null, stem: st })}>
                            {st ? (r.kind === "GROUP" ? "그룹 원곡" : "원곡") : "—"}
                          </button>
                        </td></tr>
                    );
                  }
                  const cells = matrix[vocal.indexOf(r)]!;
                  return (
                    <tr key={`${r.slotId}#${r.partNo}`}><th scope="row">{head} ({ctx.name(r.original!)})</th>
                      {cells.map((c, k) => {
                        const visible = show(c.state);
                        const stem = c.stemId ? stems.find((s) => s.stemId === c.stemId) ?? null : null;
                        return (
                          <td key={singers[k]}>
                            {visible && <button type="button" className={`cell ${c.state === "empty" ? "" : c.state}`} aria-pressed={pick?.row === r && pick.singer === singers[k]}
                              aria-label={`${head} ${ctx.members[k]!.name} ${c.state === "original" ? "원곡" : c.state === "registered" ? "등록" : "없음"}`}
                              onClick={() => setPick({ row: r, singer: singers[k]!, stem })}>
                              {c.state === "original" ? "원곡" : c.state === "registered" ? "등록" : "—"}
                            </button>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          <div className="chips" aria-label="범례"><span className="cell original" style={{ width: "auto" }}>원곡</span> 원곡 스템 <span className="cell registered" style={{ width: "auto" }}>등록</span> 추가 녹음 <span className="cell" style={{ width: "auto" }}>—</span> 아직 없음</div>
        </Section>
        <aside aria-label="스템 상세">{pick ? <StemDetail key={`${pick.row.slotId}#${pick.row.partNo}#${pick.singer}`} ctx={ctx} pick={pick} audio={audio.data ?? []} onDone={() => setPick(null)} /> : (
          <div className="note-box"><strong>칸을 고르면</strong><span>· 등록된 칸: 스템 상세(권리·조합에서·오디오)</span><span>· 빈 칸: 그 자리에 스템 추가(실연 권리 함께 — 멤버에게 확인 요청)</span></div>
        )}</aside>
      </div>
      <div className="note-box">
        <span><b>스템 추가</b> = 슬롯 · 파트 · 부른 멤버 → 실연 권리가 함께 등록되고 그 멤버에게 확인 요청</span>
        <span><b>수정·삭제</b> = IR 생성 전까지</span>
        <span><b>2차 이용</b> = 모든 슬롯의 모든 파트에 스템 하나씩, 바꾸지 않은 파트는 원곡 스템(빠지면 PART_MISSING)</span>
      </div>
    </>
  );
}

function StemDetail({ ctx, pick, audio, onDone }: { ctx: WsCtx; pick: Pick; audio: { stemId: string; status: string }[]; onDone: () => void }) {
  const w = useWrite();
  const { row, singer, stem } = pick;
  const [rightsBearing, setRb] = useState(row.kind === "VOCAL");
  const [edit, setEdit] = useState(false);
  const editable = !ctx.sealed && ctx.can("rights.edit");
  const where = `슬롯 ${row.slotNo} ${row.section} · ${mmss(row.slotStartMs)}~${mmss(row.slotEndMs)}`;
  const partText = `파트 ${row.partNo} · ${KIND_LABEL[row.kind]}${row.original ? ` · 원곡 담당 ${ctx.name(row.original)}` : ""} · ${mmss(row.startMs)}~${mmss(row.endMs)}(${Math.round((row.endMs - row.startMs) / 1000)}초)`;
  if (stem === null) {
    const id = singer ? stemIdFor(row.slotId, row.partNo, singer) : `stm_${row.slotId.replace(/^slt_/, "")}_p${row.partNo}_${row.kind === "GROUP" ? "group" : "inst"}`;
    return (
      <Section title="스템 추가">
        <dl className="kv"><dt>슬롯</dt><dd>{where}</dd><dt>파트</dt><dd>{partText}</dd><dt>부른 멤버</dt><dd>{singer ? ctx.name(singer) : "—"}</dd><dt>스템 id</dt><dd><code>{id}</code></dd></dl>
        {row.kind === "VOCAL" && <label className="check"><input type="checkbox" checked={rightsBearing} onChange={(e) => setRb(e.target.checked)} /> 권리 부담(실연 몫이 있다)</label>}
        <p className="muted small">{row.kind === "VOCAL" ? "저장하면 실연 권리가 함께 등록되고 그 멤버에게 확인 요청이 간다." : "그룹·반주 스템은 권리 부담 없이 원곡 스템으로 등록한다."}</p>
        {editable ? (
          <button type="button" className="btn primary" disabled={w.busy || !ctx.recordingId} onClick={() => void w.run(async () => {
            await postStem({ stemId: id, slotId: row.slotId, partNo: row.partNo, recordingId: ctx.recordingId!, ...(singer && { performerPartyId: singer }), rightsBearing: row.kind === "VOCAL" && rightsBearing, withClaims: true });
            onDone();
          }, `스템 ${id}을 등록했습니다`)}>스템 저장</button>
        ) : <p className="muted">{ctx.sealed ? "IR 생성 뒤 새 스템은 다음 IR에 들어간다 — 이 화면에서는 아직 지원하지 않는다." : "권리 편집 권한이 필요하다."}</p>}
        <ErrorPanel error={w.err} />
      </Section>
    );
  }
  const perf = ctx.facts.claims.find((c) => c.edge === "PERFORMED_BY" && c.sourceId === stem.stemId && c.supersededAt === null);
  const master = ctx.facts.claims.filter((c) => c.edge === "CONTROLLED_BY" && c.supersededAt === null);
  const authors = ctx.facts.claims.filter((c) => c.edge === "WRITTEN_BY" && c.supersededAt === null);
  const au = audio.find((a) => a.stemId === stem.stemId);
  const isOrig = row.kind !== "VOCAL" || stem.performerPartyId === row.original;
  return (
    <Section title={row.kind !== "VOCAL" ? `${row.section} ${KIND_LABEL[row.kind]} 원곡 스템` : isOrig ? `${row.section} ${ctx.name(row.original!)} 파트 원곡` : `${row.section} ${ctx.name(row.original!)} 파트를 ${ctx.name(stem.performerPartyId!)}이 부름`}
      actions={editable ? <>
        <button type="button" className="btn tiny" onClick={() => setEdit(!edit)}>수정</button>
        <button type="button" className="btn tiny danger" onClick={() => void w.run(async () => { await deleteCatalog("stem", stem.stemId); onDone(); }, `스템 ${stem.stemId} 삭제 — 함께 만든 주장·확인 요청도 거뒀습니다`)}>삭제</button>
      </> : undefined}>
      <div className="small muted">{isOrig ? "원곡 스템" : "멤버 추가 녹음"} · <code>{stem.stemId}</code></div>
      <h3 className="small">기본</h3>
      <dl className="kv"><dt>슬롯</dt><dd>{where}</dd><dt>파트</dt><dd>{partText}</dd><dt>부른 멤버</dt><dd>{stem.performerPartyId ? ctx.name(stem.performerPartyId) : "—"}</dd><dt>권리 부담</dt><dd>{stem.rightsBearing ? "예" : "아니오"}</dd></dl>
      {edit && (
        <div className="inline-form">
          <label className="check"><input type="checkbox" checked={rightsBearing} onChange={(e) => setRb(e.target.checked)} /> 권리 부담</label>
          <button type="button" className="btn tiny primary" onClick={() => void w.run(async () => { await putStem(stem.stemId, { rightsBearing }); setEdit(false); }, "스템을 고쳤습니다")}>저장</button>
        </div>
      )}
      <h3 className="small">이 스템의 권리</h3>
      <ul className="plain small">
        <li>실연 — {perf ? <>{ctx.name(stem.performerPartyId ?? "")}({perf.targetId}) · <span className={`badge ${perf.status === "VERIFIED" ? "ok" : "warn"}`}>{perf.status === "VERIFIED" ? "본인 확인됨" : "본인 확인 대기"}</span></> : "실연 주장 없음"}</li>
        <li>녹음 — {master.map((c) => `${ctx.name(c.targetId)} ${c.shareBps / 100}%`).join(", ") || "없음"}(원곡 권리를 따른다)</li>
        <li>작품 — {authors.map((c) => `${ctx.name(c.targetId)} ${c.shareBps / 100}%`).join(", ") || "없음"}</li>
      </ul>
      <h3 className="small">조합에서</h3>
      <p className="small">{row.kind === "VOCAL" ? (isOrig ? "바꾸지 않은 배치(원곡)에서 이 파트를 채운다." : `2차 이용 = ${row.section} 슬롯의 파트 ${row.partNo}를 원곡(${ctx.name(row.original!)}) 대신 이 스템으로 바꾸는 배치. ${ctx.name(stem.performerPartyId!)}의 부른 시간은 ${Math.round((row.endMs - row.startMs) / 1000)}초 늘고 ${ctx.name(row.original!)}은 그만큼 준다(SL2)`)
        : row.kind === "GROUP" ? "그룹 파트는 바꿀 수 없고 사용 시간에 넣지 않는다(SL7)." : "반주 파트는 권리 부담이 없어 사용 시간에 넣지 않는다(SL6)."}</p>
      <h3 className="small">오디오</h3>
      <p className="small">{au ? <span className={`badge ${au.status === "READY" ? "ok" : "warn"}`}>{au.status}</span> : "올리기 전"} · <Link to="/audio">스템 오디오 화면</Link></p>
      <ErrorPanel error={w.err} />
      {w.notice && <p role="status" className="muted">{w.notice}</p>}
    </Section>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../../../api/client.ts";
import { useGet } from "../../../api/hooks.ts";
import { ACTIONS, AUDIENCE, IMPORT_STEPS, MEDIA, TERRITORIES, managerName, stepNo, valueText, type Gaps as GapValues, type ImportValue, type ImportView, type IrGapRow } from "../../../api/imports.ts";
import type { DocumentRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { B, Card, Kv, Mono, Sub, TableCard } from "../../ops/common.tsx";
import { useSongDocs, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

/** 단계 표시(시안 steps()): 완료 = 완료 토큰, 지금 = 흰 바탕 2px 주색, 남음 = 점선. */
export function ImportSteps({ current }: { current: number }) {
  return (
    <ol className="p-steps imp" aria-label="불러오기 단계">
      {IMPORT_STEPS.map((l, i) => <li key={l} className={i + 1 < current ? "done" : i + 1 === current ? "now" : ""} aria-current={i + 1 === current ? "step" : undefined}>{i + 1 < current ? "✓ " : ""}{i + 1} {l}</li>)}
    </ol>
  );
}

/** 확인 칸(시안 check()): 확인함 = 주색 네모 ✓, 안 함 = 빈 네모. */
function Check({ on, label, disabled, onClick }: { on: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="checkbox" aria-checked={on} aria-label={label} className={`p-check${on ? " on" : ""}`} disabled={disabled} onClick={onClick}>{on ? "✓" : ""}</button>;
}

const STATE: Record<IrGapRow["state"], [string, "ok" | "warn" | "muted"]> = { FILLED: ["채움", "ok"], MISSING: ["빠짐", "warn"], IN_PROGRESS: ["진행 중", "muted"] };
const short = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`;
const mmddhm = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
export const docFile = (d: { documentId: string; version: number }) => `/api/portal/documents/${encodeURIComponent(d.documentId)}/versions/${d.version}/file`;

/** 이 곡의 열린 불러오기(주소에 import가 있으면 그것). */
export function useImport(scopeId: string) {
  const [sp] = useSearchParams();
  const list = useGet<ImportView[]>(["contract-imports", scopeId], `/scopes/${encodeURIComponent(scopeId)}/imports`);
  const want = sp.get("import");
  const v = (list.data ?? []).find((x) => (want ? x.importId === want : x.step !== "DONE")) ?? null;
  return { ...list, view: v };
}

/**
 * 작품 워크스페이스 › 문서·계약 › 계약서 불러오기(시안 Song-Import): 단계 5개, 불러온 계약서, 후보 값 표(확인 칸), IR 정보 대조, 빠진 것 입력, 버튼 2개.
 * 원본 계약서는 플랫폼 밖으로 보내지 않는다(CT1) — 후보 값은 원천 문서에 표시된 조항 인용 문장을 읽기 틀로 읽은 것이다.
 */
export function ContractImportTab({ ctx }: { ctx: WsCtx }) {
  const imp = useImport(ctx.scopeId);
  const w = useWrite();
  const nav = useNavigate();
  const v = imp.view;
  const base = `/works/${encodeURIComponent(ctx.work.workId)}/contracts`;
  if (imp.isLoading) return <p className="p-sub">불러오는 중…</p>;
  if (v === null) return <StartImport ctx={ctx} onStarted={(id) => nav(`${base}/import?import=${id}`)} />;
  const call = (path: string, body: object, msg: string) => w.run(() => api("POST", `/imports/${v.importId}${path}`, body), msg);
  const confirmed = v.values.filter((x) => x.confirmed).length;
  const filled = v.values.filter((x) => x.value !== null).length;
  const parties = v.document.parties;
  const manager = parties.length > 0 && parties.every((p) => p.manager !== null && p.manager === parties[0]!.manager) ? managerName(parties[0]!.manager) : null;
  const locked = v.step === "CONFIRM_SENT" || v.step === "DONE";
  const toConfirm = `${base}/confirm?import=${v.importId}`;
  return (
    <>
      <ImportSteps current={stepNo(v.step)} />
      <ErrorPanel error={imp.error ?? w.err} />
      <Card title="불러온 계약서" hint="① 완료">
        <Kv pairs={[
          ["문서", <>{v.document.title} v{v.document.version} ({v.document.mime === "application/pdf" ? "PDF" : v.document.mime}){v.frame?.pages ? ` · ${v.frame.pages}쪽` : ""} · <a href={docFile(v.document)} target="_blank" rel="noreferrer">원문 보기</a></>],
          ["읽기 틀", v.frame ? <><B tone="ok">양식 일치</B> {v.frame.title} v{v.frame.version} — 값 {filled}개를 후보로 채움</> : <B tone="muted">읽기 틀 없음 — 사람이 조항을 표시한다</B>],
          ["원천 문서", <><Mono>{v.document.documentId}</Mono> · sha256 <Mono>{short(v.document.sha256)}</Mono> · {mmddhm(v.document.uploadedAt)} 저장(원본 보존)</>],
          ["당사자", `${parties.map((p) => p.name).join(" · ")}${v.document.kind === "PUBLISHING" ? `(작가${manager ? `, ${manager} 관리 당사자` : ""})` : ""}`],
        ]} />
      </Card>
      <TableCard title={["② 후보 값", `${confirmed} / ${v.values.length} 확인함`]} cols={["항목", "후보 값", "근거(쪽·조항)", "기존 입력과", "확인"]} count={v.values.length} paged={false} minW={860}
        empty="읽기 틀이 없어 후보 값이 없다." foot="후보 값은 사람이 하나씩 확인한다. 기존 입력(원곡 권리)과 다르면 '다름'으로 표시되고 어느 쪽을 쓸지 고른다.">
        {v.values.map((x) => <CandidateRow key={x.key} x={x} locked={locked || w.busy} onConfirm={(body) => void call(`/values/${x.key}`, body, `${x.label} 확인`)} />)}
      </TableCard>
      <Card title="③ IR 정보 대조 — 이 곡 전체" hint="빠짐이 남아 있으면 권리 확인서로 넘어가지 않는다">
        <TableCard cols={["묶음", "필요한 것", "어디서 채우나", "상태"]} count={v.ir.length} paged={false} minW={760}>
          {v.ir.map((r, i) => <tr key={i}><td>{r.group}</td><td>{r.need}</td><td>{r.source}</td><td>{r.count ? <B tone={r.state === "FILLED" ? "ok" : "muted"}>{r.count}</B> : <B tone={STATE[r.state][1]}>{STATE[r.state][0]}</B>}</td></tr>)}
        </TableCard>
      </Card>
      {v.document.kind === "PUBLISHING" && <Gaps v={v} locked={locked} busy={w.busy} onSave={async (g, next) => {
        if (locked) { nav(toConfirm); return; }
        const ok = await call("/gaps", g, "빠진 것을 저장했습니다");
        if (ok && next) nav(toConfirm);
      }} />}
      {v.document.kind !== "PUBLISHING" && (
        <div className="p-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="p-btn wide primary" disabled={v.step !== "READY" && !locked} onClick={() => nav(toConfirm)}>권리 확인서 만들기 →</button>
        </div>
      )}
      {w.notice && <p className="p-sub" role="status">{w.notice}</p>}
    </>
  );
}

function CandidateRow({ x, locked, onConfirm }: { x: ImportValue; locked: boolean; onConfirm: (body: object) => void }) {
  const cmp: ReactNode = x.value === null ? <B tone="muted">사람이 입력</B>
    : x.compared === "SAME" ? <B tone="ok">일치</B> : x.compared === "NEW" ? <B tone="blue">새 값</B> : <B tone="warn">다름</B>;
  const diff = x.compared === "DIFFERENT" && !x.confirmed;
  return (
    <tr>
      <td>{x.label}</td>
      <td>{x.value !== null && "date" in x.value ? <Mono>{valueText(x)}</Mono> : valueText(x)}</td>
      <td><Sub main={`${x.page}쪽 ${x.clause}`} small={x.quote ? `“${x.quote}”` : "인용 문장 없음"} /></td>
      <td>{cmp}{diff && <div className="p-row" style={{ gap: 6, marginTop: 4 }}>
        <button type="button" className="p-linkbtn" disabled={locked} onClick={() => onConfirm({ confirm: true, use: "IMPORT" })}>계약서 값</button>
        <button type="button" className="p-linkbtn" disabled={locked} onClick={() => onConfirm({ confirm: true, use: "CURRENT" })}>기존 값</button></div>}</td>
      <td><Check on={x.confirmed} label={`${x.label} 확인`} disabled={locked || x.value === null || diff} onClick={() => onConfirm({ confirm: !x.confirmed })} /></td>
    </tr>
  );
}

/** ④ 빠진 것 입력(시안 field()·chips(), 2026-10-23 정정): 이용 행위 · 지역 · 매체·공개 대상 · 기간 끝. 어휘는 동의 기록과 같다. */
function Chips({ opts, on, locked, onToggle }: { opts: [string, string][]; on: string[]; locked: boolean; onToggle: (k: string) => void }) {
  return (
    <div className="p-row" style={{ gap: 6 }}>
      {opts.map(([k, l]) => <button key={k} type="button" className={`p-chip2${on.includes(k) ? " on" : ""}`} aria-pressed={on.includes(k)} disabled={locked} onClick={() => onToggle(k)}>{l}</button>)}
    </div>
  );
}

function Gaps({ v, locked, busy, onSave }: { v: ImportView; locked: boolean; busy: boolean; onSave: (g: GapValues, next: boolean) => void }) {
  const blank: GapValues = { actions: [], territories: [], media: [], audience: [], validTo: "" };
  const [g, setG] = useState<GapValues>(v.gaps ?? blank);
  useEffect(() => { if (v.gaps) setG(v.gaps); }, [JSON.stringify(v.gaps)]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: keyof Omit<GapValues, "validTo">) => (code: string) => setG((x) => ({ ...x, [k]: x[k].includes(code) ? x[k].filter((y) => y !== code) : [...x[k], code] }));
  const valuesDone = v.values.every((x) => x.confirmed);
  const filled = g.actions.length > 0 && g.territories.length > 0 && g.media.length > 0 && g.audience.length > 0 && g.validTo !== "";
  // 매체·공개 대상은 한 칸(시안): 칩을 누르면 그 어휘가 속한 쪽에 들어간다.
  const mediaAudience: [string, string][] = [...MEDIA, ...AUDIENCE];
  return (
    <>
      <Card title="④ 빠진 것 입력" hint="원본 계약에 없는 값">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          <div className="p-gap-field" role="group" aria-labelledby="gap-actions">
            <span id="gap-actions" className="l">이용 행위</span>
            <Chips opts={ACTIONS} on={g.actions} locked={locked} onToggle={toggle("actions")} />
            <span className="h">멤버 이용 동의·팩 이용 범위와 같아야 한다</span>
          </div>
          <div className="p-gap-field" role="group" aria-labelledby="gap-territories">
            <span id="gap-territories" className="l">지역</span>
            <Chips opts={TERRITORIES} on={g.territories} locked={locked} onToggle={toggle("territories")} />
          </div>
          <div className="p-gap-field" role="group" aria-labelledby="gap-media">
            <span id="gap-media" className="l">매체 · 공개 대상</span>
            <Chips opts={mediaAudience} on={[...g.media, ...g.audience]} locked={locked} onToggle={(k) => (MEDIA.some(([m]) => m === k) ? toggle("media")(k) : toggle("audience")(k))} />
          </div>
          <label className="p-gap-field"><span className="l">기간 끝</span>
            <input className="p-input p-mono" value={g.validTo} placeholder="YYYY-MM-DD" disabled={locked} onChange={(e) => setG((x) => ({ ...x, validTo: e.target.value }))} />
            <span className="h">원본 계약 기간을 넘지 않게</span>
          </label>
        </div>
      </Card>
      <div className="p-row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="p-btn wide" disabled={locked || busy || !filled} onClick={() => onSave(g, false)}>임시 저장</button>
        <button type="button" className="p-btn wide primary" disabled={busy || (!locked && (!valuesDone || !filled))}
          title={valuesDone ? undefined : "후보 값을 모두 확인해야 한다"} onClick={() => onSave(g, true)}>권리 확인서 만들기 →</button>
      </div>
    </>
  );
}

/** ① 불러오기 시작(시안 추가 필요: 문서 고르기 단계는 시안에 없다 — 시안의 "불러온 계약서" 칸을 고르는 모양으로 쓴다). */
function StartImport({ ctx, onStarted }: { ctx: WsCtx; onStarted: (id: string) => void }) {
  // 이 곡의 원본 계약서만(0048). 문서·계약 탭 ①의 '불러오기'는 ?doc=으로 미리 고른다.
  const docs = useSongDocs(ctx.scopeId);
  const w = useWrite();
  const mine = docs.data.filter((d) => d.kind === "PUBLISHING" || d.kind === "MASTER_CONTRACT");
  const [sp0] = useSearchParams();
  const [doc, setDoc] = useState(sp0.get("doc") ?? "");
  const start = async () => {
    let id = "";
    const ok = await w.run(async () => { id = (await api<ImportView>("POST", `/scopes/${encodeURIComponent(ctx.scopeId)}/imports`, { documentId: doc })).importId; }, "불러왔습니다");
    if (ok) onStarted(id);
  };
  return (
    <>
      <ImportSteps current={1} />
      <ErrorPanel error={docs.error ?? w.err} />
      <Card title="불러온 계약서" hint="① 원천 문서에서 고른다">
        <Kv pairs={[["문서", <select key="d" aria-label="불러올 계약서" className="p-select" value={doc} onChange={(e) => setDoc(e.target.value)}>
          <option value="">계약서 선택</option>{mine.map((d) => <option key={d.documentId} value={d.documentId}>{d.title} v{d.version}</option>)}</select>]]} />
        <div className="p-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="p-btn wide primary" disabled={doc === "" || w.busy || !ctx.can("contract.draft")} onClick={() => void start()}>불러오기</button>
        </div>
      </Card>
    </>
  );
}

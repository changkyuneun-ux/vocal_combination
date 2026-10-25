import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { api, type ApiError } from "../../../api/client.ts";
import { toAnswers, usableTemplates, type Contract, type FormValue, type Template } from "../../../api/contracts.ts";
import { useGet } from "../../../api/hooks.ts";
import { orgPartyIds, uploadOriginal, type ConsentRow, type DocumentRow, type PartyRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { paginate } from "../../../api/paged.ts";
import { currentClaims } from "../model.ts";
import { B, Mono, Note, TableCard } from "../../ops/common.tsx";
import { Field, SidePanel } from "./Stems.tsx";
import { useParties, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

const KIND_LABEL: Record<string, string> = { MASTER_CONTRACT: "녹음 계약서", PUBLISHING: "퍼블리싱 계약서", PLATFORM_CONTRACT: "플랫폼 계약", PERFORMER_CONSENT: "실연 동의서", MANDATE: "수령 위임" };
const BASIS: Record<string, string> = { MASTER_CONTRACT: "녹음 · 마스터 보유", PUBLISHING: "작품 · 작가 지분" };
const td = { padding: "9px 14px" } as const;
const mmdd = (iso?: string | null) => (iso ? iso.slice(5, 10) : "");

/**
 * 문서·계약 탭(시안 Song-Contracts v2, 2026-10-24 곡 절차): 곡 진행 ①·③·④를 세 구역으로 나눈다.
 * ① 원본 계약서(이 곡에 묶인 권리 근거 — 보기·불러오기) · ③ 권리 확정(권리 확인서 레이블용·작가용, 멤버 확인) · ④ 이용 허락(녹음·작품 이용허락, 실연 이용 동의, 수령 위임).
 * 제목 줄 버튼: "+ 원본 계약서 올리기"(이 곡에 묶어 올린다) · "+ 계약 만들기"(오른쪽 칸, 다시 누르면 닫힘).
 */
export function ContractsTab({ ctx }: { ctx: WsCtx }) {
  const list = useGet<Contract[]>(["work-contracts", ctx.scopeId], `/contracts?scope=${encodeURIComponent(ctx.scopeId)}`);
  const docs = useGet<DocumentRow[]>(["documents", "scope", ctx.scopeId], `/documents?scope=${encodeURIComponent(ctx.scopeId)}&origin=UPLOADED`);
  const consents = useGet<ConsentRow[]>(["work-consents", ctx.scopeId], `/consents?scope=${encodeURIComponent(ctx.scopeId)}`);
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const parties = useParties();
  const w = useWrite();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"new" | "upload" | null>(null);
  const [pg1, setPg1] = useState(1);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("ws-title-actions")), []);
  const own = orgPartyIds(mine.data);
  const contracts = [...(list.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.contractId < b.contractId ? -1 : 1));
  // 시안 순서: 녹음 계약서 → 작품 계약서, 같은 종류는 올린 순.
  const KIND_ORDER = ["MASTER_CONTRACT", "PUBLISHING"];
  const originals = (docs.data ?? []).filter((d) => d.status !== "REJECTED")
    .sort((a, b) => (KIND_ORDER.indexOf(a.kind) + 1 || 9) - (KIND_ORDER.indexOf(b.kind) + 1 || 9) || (a.uploadedAt ?? "").localeCompare(b.uploadedAt ?? ""));
  const authorIds = new Set(parties.items.filter((p) => p.partyType === "AUTHOR").map((p) => p.partyId));
  const eSignLink = (c: Contract) => c.status === "SENT" && c.signatures.some((s) => !s.signedAt && authorIds.has(s.partyId));
  const ourTurn = (c: Contract) => c.status === "SENT" && c.signatures.some((s) => !s.signedAt && own.has(s.partyId));
  const other = (c: Contract) => c.signatures.find((s) => !own.has(s.partyId))?.displayName;
  const of = (tpl: string) => contracts.filter((c) => c.templateId === tpl && c.status !== "CANCELLED");
  const cur = currentClaims(ctx.facts.claims);
  const shares = cur.filter((c) => c.edge === "WRITTEN_BY").map((c) => c.shareBps / 100);
  const memberVerified = ctx.members.filter((m) => cur.some((c) => c.edge === "OWNED_BY" && c.targetId === m.partyId && c.status === "VERIFIED")).length;
  const consented = new Set((consents.data ?? []).filter((c) => c.rightType === "PERFORMER" && c.status === "SIGNED").map((c) => c.partyId));
  const partyText = (d: DocumentRow) => (d.parties.length > 1 ? (d.parties.every((p) => authorIds.has(p)) ? `작가 ${d.parties.length}명` : `${d.parties.length}명`) : d.parties.map((p) => ctx.name(p)).join(", "));
  /** 계약 묶음의 상태 배지: 하나면 그 계약 상태, 여럿이면 반영 수 / 전체. */
  const status = (cs: Contract[]): ReactNode => {
    if (cs.length === 0) return <B tone="muted">보내지 않음</B>;
    if (cs.length > 1) { const n = cs.filter((c) => c.status === "COMPLETED").length; return <B tone={n === cs.length ? "ok" : "warn"}>{n} / {cs.length}</B>; }
    const c = cs[0]!;
    return c.status === "COMPLETED" ? <B tone="ok">반영{c.completedAt ? ` · ${mmdd(c.completedAt)}` : ""}</B>
      : c.status === "SIGNED" ? <B tone="warn">서명 완료 · 반영 전</B>
      : <B tone="warn">서명 대기{eSignLink(c) ? ` · ${mmdd(c.createdAt)} 보냄` : ""}</B>;
  };
  /** 한 계약에 할 일(다시 보내기 · 소속사 서명 · 반영 · 서명본). */
  const action = (c: Contract): ReactNode => eSignLink(c)
    ? <button type="button" className="p-linkbtn" disabled={!ctx.can("contract.draft")} onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/resend`), "전자서명 링크를 다시 보냈습니다")}>다시 보내기</button>
    : ourTurn(c) && ctx.can("contract.sign_org") ? <button type="button" className="p-linkbtn" onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/sign`), "우리 쪽 서명을 했습니다")}>소속사 서명</button>
    : c.status === "SIGNED" && ctx.can("contract.draft") ? <button type="button" className="p-linkbtn" onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/complete`), "기록에 반영했습니다(서명본은 원천 문서)")}>반영</button>
    : <Link to="/contracts">{c.status === "COMPLETED" ? "서명본" : "보기"}</Link>;
  /** 여러 건이면 펼치기, 펼치면 계약마다 한 줄. */
  const groupAction = (key: string, cs: Contract[]): ReactNode => cs.length === 1 ? action(cs[0]!) : cs.length === 0 ? null
    : <button type="button" className="p-linkbtn" aria-expanded={open.has(key)} onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>{open.has(key) ? "접기" : "펼치기"}</button>;
  const children = (key: string, cs: Contract[]) => (cs.length > 1 && open.has(key) ? cs.map((c) => (
    <tr key={c.contractId} className="cont"><td style={{ ...td, paddingLeft: 32, fontWeight: 400 }}>{c.title}{other(c) ? ` · ${other(c)}` : ""}</td><td />
      <td>{c.signatures.map((s) => `${s.displayName} ${s.signedAt ? "✓" : "대기"}`).join(" · ")}</td><td>{status([c])}</td><td style={{ whiteSpace: "nowrap" }}>{action(c)}</td></tr>
  )) : []);
  const labelConfirm = of("tpl_claim_confirm_label"), authorConfirm = of("tpl_claim_confirm_author");
  const masterLic = of("tpl_master_license"), workLic = of("tpl_work_license"), mandates = of("tpl_performer_mandate");
  const importLink = <Link to={`/works/${encodeURIComponent(ctx.work.workId)}/contracts/import`}>계약서 불러오기</Link>;
  const head = (
    <>
      <button type="button" className={panel === "upload" ? "p-btn primary" : "p-btn"} aria-pressed={panel === "upload"} disabled={!ctx.can("rights.edit")} onClick={() => setPanel(panel === "upload" ? null : "upload")}>+ 원본 계약서 올리기</button>
      <button type="button" className={panel === "upload" ? "p-btn" : "p-btn primary"} aria-pressed={panel === "new"} disabled={!ctx.can("contract.draft")} title={ctx.can("contract.draft") ? undefined : "계약 작성 권한이 필요하다"} onClick={() => setPanel(panel === "new" ? null : "new")}>+ 계약 만들기</button>
    </>
  );
  return (
    <>
      {slot && createPortal(head, slot)}
      <Note>문서·계약은 곡 진행 ①·③·④를 다룬다. ② 권리 등록은 원곡 권리 탭, ⑤ 분배·출시는 분배 규칙·팩 · 승인·출시 탭.</Note>
      <ErrorPanel error={list.error ?? docs.error ?? w.err} />
      {w.notice && <p className="p-sub" role="status" style={{ margin: 0 }}>{w.notice}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 720px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          <TableCard title={["① 원본 계약서", "권리의 근거 · 빅히트가 이미 맺은 계약서"]} label="① 원본 계약서" cols={["문서", "근거가 된 권리", "당사자", "효력", "올린 때", ""]}
            count={originals.length} empty="이 곡에 묶인 원본 계약서가 없습니다. '+ 원본 계약서 올리기'로 올린다." page={pg1} total={originals.length} onPage={setPg1}
            foot="이 곡에 묶인 원본 계약서만 보인다. '불러오기'로 계약서의 값을 원곡 권리에 채운다(읽기 틀).">
            {paginate(originals, pg1).rows.map((d) => (
              <tr key={`${d.documentId}@${d.version}`}><td>{d.title} v{d.version} (PDF)</td><td>{BASIS[d.kind] ?? KIND_LABEL[d.kind] ?? d.kind}</td><td>{partyText(d)}</td>
                <td><Mono>{d.effectiveFrom?.slice(0, 10) ?? "—"}</Mono></td><td><Mono>{mmdd(d.uploadedAt)}</Mono></td>
                <td style={{ whiteSpace: "nowrap" }}><Link to="/documents">보기</Link> · <Link to={`/works/${encodeURIComponent(ctx.work.workId)}/contracts/import?doc=${encodeURIComponent(d.documentId)}`}>불러오기</Link></td></tr>
            ))}
          </TableCard>
          <TableCard title={["③ 권리 확정", "누가 무엇을 갖는가"]} label="③ 권리 확정" cols={["확인서", "확정하는 권리", "서명", "상태", ""]} count={3} paged={false}
            foot="권리 확정 = 누가 몇 %를 갖는지 확정한다. 레이블 몫은 바로, 작가는 확인서 전자서명, 멤버는 실연자 앱 확인.">
            <tr><td>권리 확인서 · 레이블용</td><td>마스터 보유 100%</td><td>{labelConfirm[0]?.signatures.map((s) => s.displayName).join(" · ") ?? "레이블"}</td><td>{status(labelConfirm)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{labelConfirm.length ? action(labelConfirm[0]!) : importLink}</td></tr>
            <tr><td>권리 확인서 · 작가용</td><td>작가 지분 {shares.join(" · ") || "—"}</td><td>작가 {cur.filter((c) => c.edge === "WRITTEN_BY").length}명 · 전자서명 링크</td><td>{status(authorConfirm)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{authorConfirm.length ? action(authorConfirm[0]!) : importLink}</td></tr>
            <tr><td>멤버 확인(실연자 앱)</td><td>보이스 소유 · 원곡 파트 담당</td><td>멤버 {ctx.members.length}명 본인</td>
              <td><B tone={memberVerified === ctx.members.length && ctx.members.length > 0 ? "ok" : "warn"}>{memberVerified} / {ctx.members.length}</B></td>
              <td style={{ whiteSpace: "nowrap" }}><Link to={`/works/${encodeURIComponent(ctx.work.workId)}/confirm`}>확인·동의 탭 →</Link></td></tr>
          </TableCard>
          <TableCard title={["④ 이용 허락", "팬앱에서 써도 되는가"]} label="④ 이용 허락" cols={["계약", "허락하는 것", "서명", "상태", ""]} count={4} paged={false}
            foot="이용 허락 = 팬앱에서 써도 된다는 허락. 권리를 갖는 것과 별개다. 서명본은 원천 문서로 쌓인다.">
            <tr><td>녹음 이용허락 표준계약 v1</td><td>녹음을 팬앱에서 쓴다(미리듣기·조합 생성·개인 보관)</td><td>{masterLic[0]?.signatures.map((s) => s.displayName).join(" · ") ?? "레이블"}</td><td>{status(masterLic)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{groupAction("master", masterLic)}</td></tr>
            {children("master", masterLic)}
            <tr><td>작품 이용허락 표준계약 v1 · 작가 {Math.max(workLic.length, cur.filter((c) => c.edge === "WRITTEN_BY").length)}명</td><td>작품을 팬앱에서 쓴다</td>
              <td>작가 {Math.max(workLic.length, cur.filter((c) => c.edge === "WRITTEN_BY").length)}명 · 전자서명 링크</td><td>{status(workLic)}</td><td style={{ whiteSpace: "nowrap" }}>{groupAction("work", workLic)}</td></tr>
            {children("work", workLic)}
            <tr><td>실연 이용 동의 · 멤버 {ctx.members.length}명</td><td>보이스를 팬앱에서 쓴다</td><td>멤버 본인(실연자 앱)</td>
              <td><B tone={consented.size >= ctx.members.length && ctx.members.length > 0 ? "ok" : "warn"}>{Math.min(consented.size, ctx.members.length)} / {ctx.members.length}</B></td>
              <td style={{ whiteSpace: "nowrap" }}><Link to={`/works/${encodeURIComponent(ctx.work.workId)}/confirm`}>확인·동의 탭 →</Link></td></tr>
            <tr><td>실연 수익 수령 위임 · 멤버 {ctx.members.length}명 → 소속사</td><td>실연 몫을 소속사가 받는다</td><td>멤버 → {mandates[0]?.signatures.find((s) => own.has(s.partyId))?.displayName ?? "소속사"}</td>
              <td>{mandates.length === 0 ? <B tone="muted">보내지 않음</B> : <B tone={mandates.filter((c) => c.status === "COMPLETED").length === ctx.members.length ? "ok" : "warn"}>{mandates.filter((c) => c.status === "COMPLETED").length} / {ctx.members.length}</B>}</td>
              <td style={{ whiteSpace: "nowrap" }}>{mandates.length === 1 ? action(mandates[0]!) : groupAction("mandate", mandates)}</td></tr>
            {children("mandate", mandates)}
          </TableCard>
        </div>
        {panel === "new" && <NewContract ctx={ctx} own={own} onDone={() => void list.refetch()} contracts={contracts} onClose={() => setPanel(null)} />}
        {panel === "upload" && <UploadOriginal ctx={ctx} onClose={() => setPanel(null)} />}
      </div>
    </>
  );
}

/**
 * + 원본 계약서 올리기(시안 Song-Contracts-Upload, 생성기 up_panel): 오른쪽 칸, 토글(버튼 다시 누르기·취소·×).
 * 종류(녹음 계약서 → 마스터 보유 근거 / 작품 계약서 → 작가 지분 근거) · 파일(PDF) · 효력 시작. 올리면 이 곡에 묶여 ① 원본 계약서 표에 바로 나타난다.
 */
function UploadOriginal({ ctx, onClose }: { ctx: WsCtx; onClose: () => void }) {
  const w = useWrite();
  const [kind, setKind] = useState<"MASTER_CONTRACT" | "PUBLISHING">("MASTER_CONTRACT");
  const [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const cur = currentClaims(ctx.facts.claims);
  const parties = kind === "MASTER_CONTRACT" ? cur.filter((c) => c.edge === "CONTROLLED_BY").map((c) => c.targetId) : cur.filter((c) => c.edge === "WRITTEN_BY").map((c) => c.targetId);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && !Number.isNaN(Date.parse(from));
  const save = () => void w.run(async () => {
    await uploadOriginal(file!, { kind, title: `${ctx.work.title} ${kind === "MASTER_CONTRACT" ? "녹음 계약서" : "작품 퍼블리싱 계약서"}`, parties, scope: ctx.scopeId, effectiveFrom: new Date(`${from}T00:00:00.000Z`).toISOString() });
    onClose();
  }, "원본 계약서를 올렸습니다 — 이 곡의 ① 원본 계약서가 됐다");
  return (
    <SidePanel label="원본 계약서 올리기" kicker="원본 계약서 올리기" title={`${ctx.work.title}에 묶을 계약서`} onClose={onClose}
      actions={<><button type="button" className="p-btn" onClick={onClose}>취소</button>
        <button type="button" className="p-btn primary" disabled={!file || !dateOk || w.busy} title={!file ? "파일을 고른다" : !dateOk ? "효력 시작을 YYYY-MM-DD로" : undefined} onClick={save}>올리기</button></>}>
      <Field label="종류" hint="종류에 따라 근거가 될 권리가 정해진다">
        <select className="p-select" aria-label="계약서 종류" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="MASTER_CONTRACT">녹음 계약서 — 마스터 보유 근거</option><option value="PUBLISHING">작품 계약서 — 작가 지분 근거</option></select></Field>
      <Field label="파일">
        <div style={{ border: "1.5px dashed var(--p-line-strong)", borderRadius: 10, padding: 14, background: "var(--p-soft)", fontSize: 13.5 }}>
          {file ? <>{file.name} · <label htmlFor="up-file" style={{ color: "var(--p-link)", fontWeight: 600, cursor: "pointer" }}>바꾸기</label></>
            : <>끌어 놓거나 <label htmlFor="up-file" style={{ color: "var(--p-link)", fontWeight: 600, cursor: "pointer" }}>파일 고르기</label> · PDF</>}
          <input id="up-file" type="file" accept="application/pdf" aria-label="계약서 파일" style={{ position: "absolute", left: -9999 }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div></Field>
      <Field label="효력 시작"><input className="p-input" aria-label="효력 시작" inputMode="numeric" placeholder="YYYY-MM-DD" style={{ fontVariantNumeric: "tabular-nums" }} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Note>올리면 이 곡의 ① 원본 계약서가 된다. 값을 원곡 권리에 채우려면 표의 '불러오기'를 누른다.</Note>
      {w.err && <ErrorPanel error={w.err} />}
    </SidePanel>
  );
}

/** 계약 만들기(시안 오른쪽 2px 주색 패널): 1/3 템플릿 · 2/3 내용 · 미리보기는 내용이 차면 자동. */
function NewContract({ ctx, own, contracts, onDone, onClose }: { ctx: WsCtx; own: Set<string>; contracts: Contract[]; onDone: () => void; onClose: () => void }) {
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const parties = useParties();
  // 권리 확인서(CLAIM_CONFIRM)는 계약서 불러오기에서 만든다.
  const usable = usableTemplates(templates.data ?? []).filter((t) => t.recordKind !== "CLAIM_CONFIRM");
  const [tid, setTid] = useState("");
  const t = usable.find((x) => x.templateId === tid);
  const [form, setForm] = useState<Record<string, FormValue>>({});
  const [who, setWho] = useState("pending");
  const [preview, setPreview] = useState<{ signers: string[]; records: Record<string, unknown>[]; html: string } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const mandated = new Set(contracts.filter((c) => c.templateId === "tpl_performer_mandate" && c.status !== "CANCELLED").flatMap((c) => c.signatures.map((s) => s.partyId)));
  const multi = t?.variables.some((v) => v.name === "performer" && v.type === "party") ?? false;
  const pending = ctx.members.filter((m) => !mandated.has(m.partyId));
  const performers = who === "pending" ? pending.map((m) => m.partyId) : who === "all" ? ctx.members.map((m) => m.partyId) : [who];
  const answers = (p?: string) => toAnswers(t?.variables ?? [], multi ? { ...form, performer: p ?? performers[0] ?? "" } : form);
  const ready = !!t && t.variables.every((v) => v.optional || (multi && v.name === "performer" ? performers.length > 0 : form[v.name] !== undefined && form[v.name] !== ""));
  useEffect(() => {
    if (!ready) { setPreview(null); return; }
    const h = setTimeout(() => void api<{ signers: string[]; records: Record<string, unknown>[]; html: string }>("POST", "/contracts/preview", { templateId: tid, factsScopeId: ctx.scopeId, answers: answers() })
      .then((p) => { setPreview(p); setErr(null); }, (e) => { setErr(e as ApiError); setPreview(null); }), 250);
    return () => clearTimeout(h);
  }, [ready, tid, JSON.stringify(form), who]);
  const base = `ctr_${tid.replace(/^tpl_/, "")}_${ctx.scopeId.replace(/^fsc_/, "")}`;
  const send = async () => {
    try {
      if (multi) for (const p of performers) await api("POST", "/contracts", { templateId: tid, factsScopeId: ctx.scopeId, answers: answers(p), contractId: `${base}_${p.replace(/^pty_/, "")}` });
      else await api("POST", "/contracts", { templateId: tid, factsScopeId: ctx.scopeId, answers: answers(), contractId: base });
      setNotice(`서명 요청 ${multi ? performers.length : 1}건을 보냈습니다`); setErr(null); setTid(""); setForm({}); onDone();
    } catch (e) { setErr(e as ApiError); }
  };
  // 유형별 거르기: 수령하는 소속사 = 빅히트 관리 소속사만.
  const choices = (name: string) => (name === "agency" ? parties.items.filter((p) => own.has(p.partyId) && p.partyType === "AGENCY") : parties.items);
  const label = { display: "flex", flexDirection: "column", gap: 4, fontWeight: 600 } as const;
  return (
    <aside id="newc" className="p-panel form" aria-label="계약 만들기" style={{ flex: "1 1 380px", maxWidth: 440, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--p-line)", display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 auto" }}>
          <div className="p-sub" style={{ fontSize: 12 }}>계약 만들기 · {!t ? "1/3 템플릿" : !preview ? "2/3 내용" : "3/3 미리보기"}</div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{t?.title ?? "템플릿 고르기"}</h2>
        </div>
        <button type="button" className="p-btn" aria-label="닫기" style={{ width: 32, height: 32, padding: 0, fontSize: 18, lineHeight: 1, borderRadius: 8 }} onClick={onClose}>×</button>
      </div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
        <label style={label}>템플릿<select className="p-select" aria-label="계약 종류" style={{ fontWeight: 400, padding: "8px 10px" }} value={tid} onChange={(e) => { setTid(e.target.value); setForm({}); setPreview(null); }}>
          <option value="">계약 종류 선택</option>{usable.map((x) => <option key={x.templateId} value={x.templateId}>{x.title} v{x.version}</option>)}
        </select></label>
        {t?.variables.filter((v) => v.type !== "bps" && v.type !== "date").map((v) => (multi && v.name === "performer") ? (
          <label key={v.name} style={label}>{v.label}<select className="p-select" aria-label={v.label} style={{ fontWeight: 400, padding: "8px 10px" }} value={who} onChange={(e) => setWho(e.target.value)}>
            {pending.length > 0 && <option value="pending">멤버 {pending.length}명{pending.length < ctx.members.length ? `(${ctx.members.filter((m) => mandated.has(m.partyId)).map((m) => m.name).join("·")} 제외)` : ""} — 한 사람씩 계약 {pending.length}건</option>}
            <option value="all">멤버 전원 {ctx.members.length}명 — 한 사람씩 계약 {ctx.members.length}건</option>
            {ctx.members.map((m) => <option key={m.partyId} value={m.partyId}>{m.name}</option>)}
          </select></label>
        ) : v.type === "party" ? (
          <label key={v.name} style={label}>{v.label}<select className="p-select" aria-label={v.label} style={{ fontWeight: 400, padding: "8px 10px" }} value={(form[v.name] as string) ?? ""} onChange={(e) => setForm({ ...form, [v.name]: e.target.value })}>
            <option value="">명부에서 고르기</option>{choices(v.name).map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}
          </select></label>
        ) : v.type === "multi" ? (
          <fieldset key={v.name} style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ fontWeight: 600 }}>{v.label}</legend>
            {(v.options ?? []).map(([code, l]) => { const cur = (form[v.name] as string[] | undefined) ?? []; return <label key={code} style={{ marginRight: 10 }}><input type="checkbox" checked={cur.includes(code)} onChange={(e) => setForm({ ...form, [v.name]: e.target.checked ? [...cur, code] : cur.filter((x) => x !== code) })} /> {l}</label>; })}
          </fieldset>
        ) : (
          <label key={v.name} style={label}>{v.label}<input className="p-input" aria-label={v.label} style={{ fontWeight: 400, padding: 8 }} value={(form[v.name] as string) ?? ""} onChange={(e) => setForm({ ...form, [v.name]: e.target.value })} /></label>
        ))}
        {t && t.variables.some((v) => v.type === "bps" || v.type === "date") && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {t.variables.filter((v) => v.type === "bps" || v.type === "date").map((v) => (
              <label key={v.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>{v.type === "bps" ? `${v.label}(%)` : v.label}
                <input className="p-input" aria-label={v.label} type={v.type === "date" ? "date" : "number"} style={{ padding: 8 }} value={(form[v.name] as string) ?? ""} onChange={(e) => setForm({ ...form, [v.name]: e.target.value })} /></label>
            ))}
          </div>
        )}
        {preview && <div className="p-kvbox" style={{ padding: "10px 12px", fontSize: 13 }} aria-label="미리보기">미리보기: 서명 순서 {preview.signers.join(" → ")} · 반영하면 {preview.records.length ? preview.records.map((r) => `${r.type}`).join(", ") + " 확정" : "문서만"}, 서명본은 원천 문서</div>}
        {err && <ErrorPanel error={err} />}
        {notice && <p className="p-sub" role="status" style={{ margin: 0 }}>{notice}</p>}
        <div className="p-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="p-btn mid" disabled={!t} onClick={() => { setTid(""); setForm({}); setPreview(null); }}>이전</button>
          <button type="button" className="p-btn mid primary" disabled={!preview || !ctx.can("contract.draft")} onClick={() => void send()}>{multi && performers.length > 1 ? `서명 요청 ${performers.length}건 보내기` : "서명 요청 보내기"}</button>
        </div>
      </div>
    </aside>
  );
}

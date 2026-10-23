import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type ApiError } from "../../../api/client.ts";
import { toAnswers, usableTemplates, type Contract, type FormValue, type Template } from "../../../api/contracts.ts";
import { useGet } from "../../../api/hooks.ts";
import { orgPartyIds, type DocumentRow, type PartyRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { PageNav, PagedTableFoot } from "../../../components/PageNav.tsx";
import { paginate } from "../../../api/paged.ts";
import { currentClaims, groupContracts } from "../model.ts";
import { useParties, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

const KIND_LABEL: Record<string, string> = { MASTER_CONTRACT: "녹음 계약서", PUBLISHING: "퍼블리싱 계약서", PLATFORM_CONTRACT: "플랫폼 계약", PERFORMER_CONSENT: "실연 동의서", MANDATE: "수령 위임" };
const th = (h: string) => <th key={h} style={{ padding: "8px 14px" }}>{h}</th>;
const td = { padding: "9px 14px" } as const;

/**
 * 문서·계약 탭(시안 Song-Contracts.dc.html): 표준 계약 표(같은 템플릿의 서명 대기는 한 줄로 묶고 펼치기) · 원천 문서 · 오른쪽 계약 만들기(2px 주색 패널).
 * 수령 위임은 실연자 여럿을 고르면 한 사람씩 계약을 만든다.
 */
export function ContractsTab({ ctx }: { ctx: WsCtx }) {
  const list = useGet<Contract[]>(["work-contracts", ctx.scopeId], `/contracts?scope=${encodeURIComponent(ctx.scopeId)}`);
  const docs = useGet<DocumentRow[]>(["documents"], "/documents");
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const parties = useParties();
  const w = useWrite();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pg1, setPg1] = useState(1), [pg2, setPg2] = useState(1);
  const own = orgPartyIds(mine.data);
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const tplTitle = (c: Contract) => `${(templates.data ?? []).find((t) => t.templateId === c.templateId && t.version === c.templateVersion)?.title ?? c.templateId} v${c.templateVersion}`;
  // 시안 순서: 먼저 만든 계약부터(플랫폼 → 녹음 → 작품 → 수령 위임).
  const contracts = [...(list.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.contractId < b.contractId ? -1 : 1));
  const scopeParties = new Set(currentClaims(ctx.facts.claims).map((c) => c.targetId));
  const ctrDocs = new Set(contracts.flatMap((c) => (c.document ? [c.document.documentId] : [])));
  const documents = (docs.data ?? []).filter((d) => !ctrDocs.has(d.documentId) && d.parties.some((p) => scopeParties.has(p)));
  const other = (c: Contract) => c.signatures.find((s) => !own.has(s.partyId))?.displayName;
  const ourTurn = (c: Contract) => c.status === "SENT" && c.signatures.some((s) => !s.signedAt && own.has(s.partyId));
  // 작가(사람 당사자, 계정 없음)에게 빅히트가 보낸 전자서명 링크로 서명을 기다리는 계약(결정 WD2, 시안 "전자서명 링크 보냄 · 다시 보내기").
  const authorIds = new Set(parties.items.filter((p) => p.partyType === "AUTHOR").map((p) => p.partyId));
  const eSignLink = (c: Contract) => c.status === "SENT" && c.signatures.some((s) => !s.signedAt && authorIds.has(s.partyId));
  // 같은 템플릿·같은 상태의 서명 대기 계약 여럿은 한 줄로(시안 "실연 수익 수령 위임 · 지민 외 5명").
  const groups = groupContracts(contracts, own);
  const status = (c: Contract): [string, string] => c.status === "COMPLETED" ? [`반영 · ${c.records.length ? "기록 확정" : "원천 문서"}`, "p-ok"]
    : c.status === "SIGNED" ? ["서명 완료 · 반영 전", "p-warn"] : c.status === "CANCELLED" ? ["취소", "p-todo"] : [`서명 대기${eSignLink(c) ? ` · 전자서명 링크 보냄 ${c.createdAt.slice(5, 10)}` : ""}`, "p-warn"];
  const signLine = (c: Contract) => [...c.signatures].sort((a, b) => Number(own.has(a.partyId)) - Number(own.has(b.partyId))).map((s) => `${s.displayName} ${s.signedAt ? "✓" : "대기"}`).join(" · ");
  const row = (c: Contract, child = false) => {
    const [t, cls] = status(c);
    return (
      <tr key={c.contractId} className={child ? "cont" : ""}>
        <td style={{ ...td, fontWeight: 600, paddingLeft: child ? 28 : 14 }}>{c.title}{other(c) ? ` · ${other(c)}` : ""}</td>
        <td style={td}>{tplTitle(c)}</td>
        <td style={td}>{signLine(c)}</td>
        <td style={{ ...td, whiteSpace: "nowrap" }} className={cls}>{t}</td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          {eSignLink(c) ? <button type="button" className="p-linkbtn" disabled={!ctx.can("contract.draft")}
            onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/resend`), "전자서명 링크를 다시 보냈습니다")}>다시 보내기</button> : <>
            {ourTurn(c) && ctx.can("contract.sign_org") && <button type="button" className="p-linkbtn" onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/sign`), "우리 쪽 서명을 했습니다")}>소속사 서명</button>}
            {c.status === "SIGNED" && ctx.can("contract.draft") && <button type="button" className="p-linkbtn" onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/complete`), "기록에 반영했습니다(서명본은 원천 문서)")}>반영</button>}
            {(c.status === "COMPLETED" || c.status === "CANCELLED" || (!ourTurn(c) && c.status === "SENT")) && <Link to="/contracts">보기</Link>}
          </>}
        </td>
      </tr>
    );
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
      <div style={{ flex: "999 1 720px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        <section className="p-card">
          <div className="p-card-head"><h2>표준 계약 {contracts.length}</h2><span className="p-badge sm muted">작성 → 서명 → 반영 → 원천 문서</span><span style={{ marginLeft: "auto" }} />
            <Link className="p-btn mid" to={`/works/${encodeURIComponent(ctx.work.workId)}/contracts/import`} aria-disabled={!ctx.can("contract.draft") || undefined}>계약서 불러오기</Link>
            <button type="button" className="p-btn mid primary" disabled={!ctx.can("contract.draft")} title={ctx.can("contract.draft") ? undefined : "계약 작성 권한이 필요하다"} onClick={() => document.getElementById("newc")?.scrollIntoView()}>+ 계약 만들기</button></div>
          <ErrorPanel error={list.error ?? w.err} />
          <div className="p-scroll"><table className="p-table" style={{ minWidth: 680 }} aria-label="이 곡의 표준 계약">
            <thead><tr>{["계약", "템플릿", "서명 당사자", "상태", ""].map(th)}</tr></thead>
            <tbody>{paginate(groups, pg1).rows.flatMap((g) => {
              if (g.length === 1) return [row(g[0]!)];
              const key = g[0]!.contractId;
              const mineToSign = g.filter(ourTurn);
              return [
                <tr key={`g${key}`} className="sel">
                  <td style={{ ...td, fontWeight: 600 }}>{g[0]!.title} · {other(g[0]!)} 외 {g.length - 1}명</td>
                  <td style={td}>{tplTitle(g[0]!)}</td>
                  <td style={td}>멤버 {g.every((c) => c.signatures.filter((s) => !own.has(s.partyId)).every((s) => s.signedAt)) ? "✓" : "대기"} · 소속사 {mineToSign.length === 0 ? "✓" : "대기"}</td>
                  <td style={td} className={status(g[0]!)[1]}>{g[0]!.status === "SIGNED" ? `반영 대기 ${g.length}` : `서명 대기 ${g.length}`}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button type="button" className="p-linkbtn" aria-expanded={open.has(key)} onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>{open.has(key) ? "접기" : "펼치기"}</button>
                    {mineToSign.length > 0 && ctx.can("contract.sign_org") && <> · <button type="button" className="p-linkbtn" onClick={() => void w.run(async () => { for (const c of mineToSign) await api("POST", `/contracts/${c.contractId}/sign`); }, `소속사 서명 ${mineToSign.length}건`)}>소속사 서명</button></>}
                    {g[0]!.status === "SIGNED" && ctx.can("contract.draft") && <> · <button type="button" className="p-linkbtn" onClick={() => void w.run(async () => { for (const c of g) await api("POST", `/contracts/${c.contractId}/complete`); }, `반영 ${g.length}건`)}>반영</button></>}
                  </td>
                </tr>,
                ...(open.has(key) ? g.map((c) => row(c, true)) : []),
              ];
            })}
              {contracts.length === 0 && <tr><td style={td} colSpan={5} className="p-todo">이 곡의 계약이 없습니다.</td></tr>}
            </tbody>
          </table></div>
          <PagedTableFoot note={w.notice ? <span role="status">{w.notice}</span> : undefined}><PageNav page={pg1} total={groups.length} onPage={setPg1} /></PagedTableFoot>
        </section>
        <section className="p-card">
          <div className="p-card-head"><h2>원천 문서 {documents.length}</h2></div>
          <table className="p-table"><tbody>{paginate(documents, pg2).rows.map((d, i) => (
            <tr key={`${d.documentId}@${d.version}`} style={i === 0 ? { borderTop: 0 } : undefined}>
              <td style={td}>{d.title} v{d.version} (PDF)</td>
              <td style={td}>당사자 {d.parties.length > 1 ? `${d.parties.length}명` : d.parties.map((p) => ctx.name(p)).join(", ")}{d.effectiveFrom ? <> · <span className="nw">효력 {d.effectiveFrom.slice(0, 10)}</span></> : ""}</td>
              <td style={td}>근거: {KIND_LABEL[d.kind] ?? d.kind}</td>
            </tr>
          ))}</tbody></table>
          <PagedTableFoot note="반영된 표준 계약의 서명본은 원천 문서로 자동 등록된다."><PageNav page={pg2} total={documents.length} onPage={setPg2} /></PagedTableFoot>
        </section>
      </div>
      <NewContract ctx={ctx} own={own} onDone={() => void list.refetch()} contracts={contracts} />
    </div>
  );
}

/** 계약 만들기(시안 오른쪽 2px 주색 패널): 1/3 템플릿 · 2/3 내용 · 미리보기는 내용이 차면 자동. */
function NewContract({ ctx, own, contracts, onDone }: { ctx: WsCtx; own: Set<string>; contracts: Contract[]; onDone: () => void }) {
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
  const choices = (name: string) => (name === "agency" ? parties.items.filter((p) => own.has(p.partyId)) : parties.items);
  const ownTag = (p: string) => (own.has(p) ? "(우리 당사자)" : "");
  const label = { display: "flex", flexDirection: "column", gap: 4, fontWeight: 600 } as const;
  return (
    <aside id="newc" className="p-panel form" aria-label="계약 만들기" style={{ flex: "1 1 380px", maxWidth: 440, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--p-line)" }}>
        <div className="p-sub" style={{ fontSize: 12 }}>계약 만들기 · {!t ? "1/3 템플릿" : !preview ? "2/3 내용" : "3/3 미리보기"}</div>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t?.title ?? "템플릿 고르기"}</h2>
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
            <option value="">명부에서 고르기</option>{choices(v.name).map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}{ownTag(p.partyId)}</option>)}
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

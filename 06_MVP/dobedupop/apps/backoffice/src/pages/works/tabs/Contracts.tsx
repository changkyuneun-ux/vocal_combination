import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../../api/client.ts";
import { CONTRACT_STATUS, type Contract } from "../../../api/contracts.ts";
import { useGet } from "../../../api/hooks.ts";
import type { DocumentRow, PartyRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Section } from "../../../components/Section.tsx";
import { ContractWizard } from "../../contracts/ContractWizard.tsx";
import { currentClaims } from "../model.ts";
import { useParties, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

/**
 * 문서·계약 탭(시안 Song-Contracts, P4): 이 곡 범위의 표준 계약(작성 → 서명 → 반영 → 원천 문서), 우리 쪽 서명·반영, 원천 문서,
 * 오른쪽에 계약 만들기(표준 계약 화면과 같은 마법사 — 수령 위임은 멤버 여러 명을 고르면 한 사람씩).
 */
export function ContractsTab({ ctx }: { ctx: WsCtx }) {
  const list = useGet<Contract[]>(["work-contracts", ctx.scopeId], `/contracts?scope=${encodeURIComponent(ctx.scopeId)}`);
  const docs = useGet<DocumentRow[]>(["documents"], "/documents");
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const parties = useParties();
  const w = useWrite();
  const [open, setOpen] = useState(false);
  const own = new Set((mine.data ?? []).map((p) => p.partyId));
  const contracts = list.data ?? [];
  // 이 곡과 닿는 원천 문서: 계약 반영본, 주장 근거로 쓰인 문서의 당사자가 이 곡 권리자인 것.
  const scopeParties = new Set(currentClaims(ctx.facts.claims).map((c) => c.targetId));
  const contractDocs = new Set(contracts.flatMap((c) => (c.document ? [c.document.documentId] : [])));
  const documents = (docs.data ?? []).filter((d) => contractDocs.has(d.documentId) || d.parties.some((p) => scopeParties.has(p)));
  const choices = parties.items.filter((p) => ["MEMBER", "AGENCY", "LABEL", "AUTHOR", "PUBLISHER", "ARTIST"].includes(p.partyType) || own.has(p.partyId));
  const agency = (mine.data ?? []).find((p) => p.partyType === "AGENCY")?.partyId;
  return (
    <div className="ws-grid">
      <div>
        <Section title={`표준 계약 ${contracts.length}`} actions={ctx.can("contract.draft") && <button type="button" className="btn primary" aria-expanded={open} onClick={() => setOpen(!open)}>+ 계약 만들기</button>}>
          <p className="muted small">작성 → 서명 → 반영 → 원천 문서</p>
          <ErrorPanel error={list.error ?? w.err} />
          {w.notice && <p role="status" className="muted">{w.notice}</p>}
          {contracts.length === 0 ? <p className="muted">이 곡의 계약이 없습니다.</p> : (
            <table className="data" aria-label="이 곡의 표준 계약">
              <thead><tr>{["계약", "템플릿", "서명 당사자", "상태", ""].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>{contracts.map((c) => {
                const ourTurn = c.status === "SENT" && c.signatures.some((s) => !s.signedAt && own.has(s.partyId));
                return (
                  <tr key={c.contractId}>
                    <td>{c.title}<div className="small muted"><code>{c.contractId}</code></div></td>
                    <td>{c.templateId} v{c.templateVersion}</td>
                    <td><ul className="plain">{c.signatures.map((s) => <li key={s.partyId}>{s.displayName} {s.signedAt ? <span className="mark-ok">✓ <Instant iso={s.signedAt} /></span> : <span className="mark-warn">대기</span>}</li>)}</ul></td>
                    <td><span className={`badge ${CONTRACT_STATUS[c.status]?.[1] ?? "muted"}`}>{CONTRACT_STATUS[c.status]?.[0] ?? c.status}</span>{c.document && <div className="small muted">원천 문서 {c.document.documentId}</div>}</td>
                    <td><div className="row-actions">
                      {ourTurn && ctx.can("contract.sign_org") && <button type="button" className="btn tiny" onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/sign`), "우리 쪽 서명을 했습니다")}>소속사 서명</button>}
                      {c.status === "SIGNED" && ctx.can("contract.draft") && <button type="button" className="btn tiny primary" onClick={() => void w.run(() => api("POST", `/contracts/${c.contractId}/complete`), "기록에 반영했습니다(서명본은 원천 문서)")}>반영</button>}
                      {c.status !== "SENT" && c.status !== "SIGNED" && <span className="muted small">조회만</span>}
                    </div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </Section>
        <Section title={`원천 문서 ${documents.length}`}>
          <ErrorPanel error={docs.error} />
          {documents.length === 0 ? <p className="muted">원천 문서가 없습니다.</p> : (
            <table className="data"><tbody>{documents.map((d) => (
              <tr key={`${d.documentId}@${d.version}`}><td>{d.title} v{d.version}</td><td>당사자 {d.parties.map((p) => ctx.name(p)).join(", ")}{d.effectiveFrom ? ` · 효력 ${d.effectiveFrom.slice(0, 10)}` : ""}</td><td>{d.kind}</td></tr>
            ))}</tbody></table>
          )}
          <p className="muted small">반영된 표준 계약의 서명본은 원천 문서로 자동 등록된다. 문서 올리기는 <Link to="/documents">원천 문서</Link>에서.</p>
        </Section>
      </div>
      <aside aria-label="계약 만들기">
        {open ? (
          <Section title="계약 만들기">
            <ContractWizard fixedScope={ctx.scopeId} parties={choices} defaults={agency ? { agency } : {}} onDone={(m) => { w.setNotice(m); void list.refetch(); setOpen(false); }} />
          </Section>
        ) : (
          <div className="note-box"><strong>계약 만들기</strong><span>템플릿 → 내용(당사자는 명부에서) → 미리보기 → 서명 요청.</span><span>수령 위임은 멤버 여러 명을 고르면 한 사람씩 계약을 만든다. 멤버는 실연자 앱에서, 소속사는 여기서 서명한다.</span></div>
        )}
      </aside>
    </div>
  );
}

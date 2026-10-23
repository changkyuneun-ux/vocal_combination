import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../../api/client.ts";
import type { Contract } from "../../../api/contracts.ts";
import { useGet } from "../../../api/hooks.ts";
import { ROLE_DETAIL, managerName, type ConfirmationPreview } from "../../../api/imports.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { B, Card, Kv, Mono, TableCard } from "../../ops/common.tsx";
import { currentClaims } from "../model.ts";
import { useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";
import { docFile, ImportSteps, useImport } from "./ContractImport.tsx";

type CC = { kind: "LABEL" | "AUTHOR"; templateId: string; contract: (Contract & { completedAt?: string; answers?: Record<string, unknown> }) | null };
type Share = { partyId: string; shareBps: number; roleDetail: string | null };

/** 조항 본문: {{변수}}를 값으로, 작가 지분 표는 표로, 문서 id·해시는 Mono로(시안 Song-ClaimConfirm 미리보기). */
function ClauseBody({ text, labels, shares, names, manager }: { text: string; labels: Record<string, string>; shares: Share[]; names: (p: string) => string; manager: (p: string) => string | null }) {
  const parts = text.split(/(\{\{\w+\}\})/);
  const mono = (s: string): ReactNode[] => s.split(/(doc_[A-Za-z0-9_.-]+|[0-9a-f]{4}…[0-9a-f]{4})/).map((x, i) => (i % 2 === 1 ? <Mono key={i}>{x}</Mono> : x));
  return (
    <div className="p-clause-body">
      {parts.map((p, i) => {
        const m = /^\{\{(\w+)\}\}$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        if (m[1] === "authors") {
          return (
            <table key={i} className="p-share-tbl"><thead><tr><th>작가</th><th>역할</th><th>지분</th><th>수령</th></tr></thead>
              <tbody>{shares.map((s) => <tr key={s.partyId}><td>{names(s.partyId)}</td><td>{ROLE_DETAIL[s.roleDetail ?? ""] ?? s.roleDetail ?? "—"}</td><td className="p-mono">{(s.shareBps / 100).toFixed(2)}%</td><td>{manager(s.partyId) ? `작가 본인(${managerName(manager(s.partyId))} 관리)` : "본인"}</td></tr>)}</tbody>
            </table>
          );
        }
        return <span key={i}>{mono(labels[m[1]!] ?? "—")}</span>;
      })}
    </div>
  );
}

const sigState = (c: CC["contract"]): [string, "ok" | "warn" | "muted"] =>
  c === null ? ["서명 요청 전", "muted"] : c.status === "COMPLETED" ? [`서명됨 · ${(c.completedAt ?? "").slice(5, 10)}`, "ok"]
    : c.status === "SIGNED" ? ["서명 끝 · 반영 전", "warn"] : c.status === "CANCELLED" ? ["취소", "muted"] : ["서명 대기", "warn"];

/**
 * 작품 워크스페이스 › 문서·계약 › 권리 확인서(시안 Song-ClaimConfirm): 확인서 미리보기, 서명, 서명하면 만들어지는 기록, 이 곡의 확인서 2부.
 * 계정 없는 작가는 빅히트가 보낸 전자서명 링크로 서명한다(결정 WD2). 서명이 끝나면 기록 반영으로 주장이 서명본을 근거로 VERIFIED가 된다(CT5).
 */
export function ClaimConfirmTab({ ctx }: { ctx: WsCtx }) {
  const imp = useImport(ctx.scopeId);
  const v = imp.view;
  const kind = v?.document.kind === "MASTER_CONTRACT" ? "LABEL" : "AUTHOR";
  const pv = useGet<ConfirmationPreview>(["claim-confirmations", "preview", v?.importId, kind], `/imports/${v?.importId ?? ""}/confirmation?kind=${kind}`, { enabled: !!v });
  const list = useGet<CC[]>(["claim-confirmations", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/claim-confirmations`);
  const w = useWrite();
  const [page, setPage] = useState(1);
  const base = `/works/${encodeURIComponent(ctx.work.workId)}/contracts`;
  if (imp.isLoading) return <p className="p-sub">불러오는 중…</p>;
  if (!v) return <><ImportSteps current={5} /><p className="p-sub">불러온 계약서가 없습니다. <Link to={`${base}/import`}>계약서 불러오기</Link></p></>;
  const mine = (list.data ?? []).find((x) => x.kind === kind)?.contract ?? null;
  const contract = mine !== null && mine.contractId === v.contractId ? mine : null;
  const p = pv.data;
  const mgr = new Map((p?.signerParties ?? []).map((s) => [s.partyId, s.noAccount ? s.manager : null]));
  const names = (id: string) => p?.signerParties.find((s) => s.partyId === id)?.name ?? ctx.name(id);
  const shares = (p?.answers.authors as Share[] | undefined) ?? [];
  const claims = p?.records.filter((r) => r.type === "CLAIM") ?? [];
  const consents = p?.records.filter((r) => r.type === "CONSENT") ?? [];
  const edge = kind === "AUTHOR" ? "WRITTEN_BY" : "CONTROLLED_BY";
  const waiting = currentClaims(ctx.facts.claims).filter((c) => c.edge === edge && c.status === "ASSERTED").length;
  const title = (p?.template.title ?? "").replace(" · ", " — ");
  const send = () => w.run(() => api("POST", `/imports/${v.importId}/confirmation`, { kind }), "서명 요청을 보냈습니다");
  const complete = () => w.run(() => api("POST", `/contracts/${contract!.contractId}/complete`, {}), "기록에 반영했습니다(서명본은 원천 문서)");
  const label = (list.data ?? []).find((x) => x.kind === "LABEL")?.contract ?? null;
  const author = (list.data ?? []).find((x) => x.kind === "AUTHOR")?.contract ?? null;
  const holder = ctx.facts.recordings[0]?.masterOwnerPartyId;
  const authorsN = kind === "AUTHOR" && shares.length > 0 ? shares.length : currentClaims(ctx.facts.claims).filter((c) => c.edge === "WRITTEN_BY").length;
  const linked = kind === "AUTHOR" && shares.length > 0 && shares.every((s) => mgr.get(s.partyId));
  const ccRows: [string, string, string, CC["contract"], "LABEL" | "AUTHOR"][] = [
    ["레이블용", `마스터 보유 · ${holder ? ctx.name(holder) : "—"}`, holder ? ctx.name(holder) : "—", label, "LABEL"],
    ["작가용", `작가 지분 ${authorsN} · 작품 이용 범위`, `작가 ${authorsN}${linked ? "(전자서명 링크)" : ""}`, author, "AUTHOR"],
  ];
  return (
    <>
      <ImportSteps current={5} />
      <ErrorPanel error={pv.error ?? list.error ?? w.err} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 560px", minWidth: 0 }}>
          <article className="p-doc" aria-label="권리 확인서 미리보기">
            <div className="p-row" style={{ gap: 8 }}><h3>{title || "권리 확인서"}</h3><B tone="muted">템플릿 v{p?.template.version ?? 1}</B>
              {contract === null ? <B tone="blue">미리보기</B> : <B tone={sigState(contract)[1]}>{sigState(contract)[0]}</B>}</div>
            {(p?.template.clauses ?? []).map((c, i) => (
              <div key={c.clauseId} className="p-clause"><strong>제{i + 1}조 {c.heading}</strong>
                <ClauseBody text={c.text} labels={p!.labels} shares={shares} names={names} manager={(id) => mgr.get(id) ?? null} /></div>
            ))}
          </article>
        </div>
        <div style={{ flex: "1 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="서명" hint={kind === "AUTHOR" ? "작가 전원 · 한 부" : "레이블 · 한 부"}>
            <TableCard cols={["서명자", "방법", "상태"]} count={p?.signerParties.length ?? 0} paged={false} minW={320}>
              {(p?.signerParties ?? []).map((s) => {
                const sig = contract?.signatures.find((x) => x.partyId === s.partyId);
                return (
                  <tr key={s.partyId}><td>{s.name}</td><td>{s.noAccount ? "전자서명 링크(계정 없음) · 이메일" : "전자서명"}</td>
                    <td>{sig?.signedAt ? <B tone="ok">서명됨</B> : <B tone="warn">대기</B>}</td></tr>
                );
              })}
            </TableCard>
          </Card>
          <Card title="서명하면 만들어지는 기록">
            <Kv pairs={[
              ["권리 주장", <>{kind === "AUTHOR" ? `작가 지분 ${claims.length}건(WRITTEN_BY)` : `마스터 보유 ${claims.length}건(CONTROLLED_BY)`} <B tone="ok">VERIFIED</B></>],
              ...(consents.length > 0 ? [["이용 동의", <>작품 이용 동의 {consents.length}건(작가마다 1건) <B tone="ok">VERIFIED</B></>] as [string, ReactNode]] : []),
              ["원천 문서", "확인서 서명본 + 원본 계약 근거 연결"],
              ["확인 요청", waiting > 0 ? `상대 확인 14일 대기 없음 — 경고 ${waiting}건이 닫힌다` : "상대 확인 14일 대기 없음"],
            ]} />
          </Card>
        </div>
      </div>
      <TableCard title={["이 곡의 권리 확인서", "2부"]} cols={["확인서", "담는 권리", "서명", "상태", ""]} count={ccRows.length} minW={760}
        page={page} total={ccRows.length} onPage={setPage} foot="멤버의 보이스 소유·파트 담당은 확인서가 아니라 실연자 앱 확인으로 받는다.">
        {ccRows.map(([k, rights, signer, c, kk]) => {
          const [t, tone] = sigState(c);
          return (
            <tr key={k}><td>{k}</td><td>{rights}</td><td>{signer}</td><td><B tone={tone}>{t}</B></td>
              <td>{c?.status === "COMPLETED" && c.document ? <a href={docFile(c.document)} target="_blank" rel="noreferrer">서명본 보기</a>
                : kk === kind ? <a href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo(0, 0); }}>미리보기</a> : <Link to={`${base}/import`}>미리보기</Link>}</td></tr>
          );
        })}
      </TableCard>
      <div className="p-row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <Link className="p-btn wide" to={`${base}/import?import=${v.importId}`}>← 입력으로</Link>
        {contract === null ? <button type="button" className="p-btn wide primary" disabled={w.busy || !p || !ctx.can("contract.draft")} onClick={() => void send()}>서명 요청 보내기</button>
          : contract.status === "COMPLETED" ? null
            : <button type="button" className="p-btn wide primary" disabled={w.busy || contract.status !== "SIGNED"} title={contract.status === "SIGNED" ? undefined : "서명자 전원이 전자서명해야 반영한다"} onClick={() => void complete()}>기록 반영</button>}
      </div>
      {w.notice && <p className="p-sub" role="status">{w.notice}</p>}
    </>
  );
}

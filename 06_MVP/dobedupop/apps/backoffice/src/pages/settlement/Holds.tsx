import { Fragment, useState } from "react";
import { sessionMode } from "../../api/client.ts";
import { Link } from "react-router";
import { Section } from "../../components/Section.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { Pager } from "../../components/Pager.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet, useList } from "../../api/hooks.ts";
import { releaseHold } from "../../api/settlement.ts";
import type { HoldRow, HoldSuggestion } from "../../api/types.ts";
import { allocationCheck, holdDisplayStatus, remainingHold } from "./logic.ts";

const SETTLE_ACTOR = "usr_settle";
type Line = { party: string; amount: string };
const toLines = (a: Record<string, string>): Line[] => Object.entries(a).map(([party, amount]) => ({ party, amount }));

/** 제안 응답이 오면 편집 표를 한 번 채운다(이후 편집은 그대로 둔다). */
function Editor({ hold, remaining, suggestion, suggestionError }: { hold: HoldRow; remaining: bigint; suggestion?: HoldSuggestion; suggestionError: unknown }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const shown = lines ?? (suggestion ? toLines(suggestion.allocation) : []);
  const target = suggestion?.remainingKrw ?? remaining.toString();
  const allocation = Object.fromEntries(shown.filter((l) => l.party.trim() !== "").map((l) => [l.party.trim(), l.amount.trim()]));
  const dup = shown.filter((l) => l.party.trim() !== "").length !== Object.keys(allocation).length;
  const check = allocationCheck(allocation, target);
  const m = useAction(releaseHold, ["holds", "batch-ledger"]);
  const edit = (i: number, patch: Partial<Line>) => setLines(shown.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const id = hold.holdingId;
  return (
    <div className="stack">
      <p>보류 {id}: 원 보류액 <Money krw={hold.amountKrw} />, 남은 보류액 <Money krw={target} /></p>
      {suggestionError ? <ErrorPanel error={suggestionError} /> : null}
      {suggestionError ? <p className="muted">제안이 없으면 권리자를 직접 입력해 배분할 수 있습니다.</p> : null}
      <table className="data">
        <thead><tr><th scope="col">권리자(partyId)</th><th scope="col">금액(원)</th><th scope="col">작업</th></tr></thead>
        <tbody>
          {shown.map((l, i) => (
            <tr key={i}>
              <td><input aria-label={`보류[${id}] 권리자[${l.party || `새 ${i + 1}`}]`} value={l.party} onChange={(e) => edit(i, { party: e.target.value })} /></td>
              <td><input aria-label={`보류[${id}] 금액[${l.party || `새 ${i + 1}`}]`} inputMode="numeric" value={l.amount} onChange={(e) => edit(i, { amount: e.target.value })} /></td>
              <td><button type="button" className="btn tiny" aria-label={`보류[${id}] 배분삭제[${l.party || `새 ${i + 1}`}]`} onClick={() => setLines(shown.filter((_, j) => j !== i))}>삭제</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => setLines([...shown, { party: "", amount: "" }])}>배분 추가</button>
      </div>
      <p role="status" className={check.ok && !dup ? "muted" : "error-text"}>
        배분 합계 <Money krw={check.sum.toString()} /> / 남은 보류액 <Money krw={target} />
        {dup ? " — 같은 권리자가 중복되었습니다" : check.ok ? " — 일치" : ` — ${check.reason ?? ""}`}
      </p>
      <button type="button" className="btn primary" aria-label={`보류[${id}] 배분 해제`} disabled={!check.ok || dup || m.isPending}
        onClick={() => m.mutate({ holdingId: id, allocation })}>해제</button>
      {m.isSuccess && <p className="muted" role="status">해제했습니다: 분개 {String(m.data.entryId)}</p>}
      <ErrorPanel error={m.error} />
    </div>
  );
}

function Suggestion({ hold, remaining }: { hold: HoldRow; remaining: bigint }) {
  const fraud = hold.reason === "FRAUD_REVIEW";
  const s = useGet<HoldSuggestion>(["hold-suggestion", String(hold.holdingId)], `/holds/${hold.holdingId}/suggestion`, { enabled: fraud });
  if (fraud && s.isPending) return <p className="muted">제안을 계산하는 중…</p>;
  return <Editor hold={hold} remaining={remaining} suggestion={s.data} suggestionError={fraud ? s.error : null} />;
}

export function Holds() {
  const actor = useActor();
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const list = useList<HoldRow>("holds", "/holds", { status, reason });
  return (
    <>
      <Section title="보류 안내" actions={!sessionMode && <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>}>
        <p>제안 조회와 해제는 정산 담당(SPACE_SETTLE)이 합니다. 현재 사용자: <strong>{actor}</strong></p>
      </Section>
      <Section title="보류 목록" actions={
        <div className="inline-form">
          <label className="field"><span>상태 필터</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">전체</option><option value="HELD">HELD</option></select>
          </label>
          <label className="field"><span>사유 필터</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">전체</option><option value="FRAUD_REVIEW">FRAUD_REVIEW</option><option value="RIGHTS_DISPUTE">RIGHTS_DISPUTE</option>
            </select>
          </label>
        </div>
      }>
        <ErrorPanel error={list.error} />
        {list.pages.every((h) => h.lineSeq !== 1) ? <p className="muted">보류가 없습니다.</p> : (
          <table className="data">
            <thead><tr>{["보류", "run", "이벤트", "버킷", "사유", "금액", "상태", "해제", "작업"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {list.pages.filter((h) => h.lineSeq === 1).map((h) => (
                <Fragment key={h.holdingId}>
                  <tr>
                    <td>{h.holdingId}</td>
                    <td><Link to={`/settlement/runs/${encodeURIComponent(h.runId)}`}>{h.runId}</Link></td>
                    <td>{h.eventId}</td><td>{h.bucket}</td><td>{h.reason}</td><td><Money krw={h.amountKrw} /></td>
                    <td><StatusBadge status={holdDisplayStatus(h)} /></td>
                    <td>{h.release ? <>{h.release.releasedBy} <Instant iso={h.release.releasedAt} /></> : "—"}</td>
                    <td>
                      {h.release ? <span className="muted">해제됨</span> : (
                        <button type="button" className="btn tiny" aria-expanded={open === h.holdingId} aria-label={`보류[${h.holdingId}] 제안 보기`}
                          onClick={() => setOpen(open === h.holdingId ? null : h.holdingId)}>해제 제안 보기</button>
                      )}
                    </td>
                  </tr>
                  {open === h.holdingId && !h.release && <tr><td colSpan={9}><Suggestion hold={h} remaining={remainingHold(h, list.pages)} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        <Pager next={list.next} loadMore={list.loadMore} />
      </Section>
    </>
  );
}

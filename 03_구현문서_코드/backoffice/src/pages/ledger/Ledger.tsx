import { useState } from "react";
import { Link } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { Pager } from "../../components/Pager.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useGet, useList } from "../../api/hooks.ts";
import type { EntryRow, LedgerAccount, TrialBalance } from "../../api/types.ts";

const SETTLE_ACTOR = "usr_settle";
const KINDS = ["SETTLEMENT", "REVERSAL", "HOLD_RELEASE", "PAYOUT", "PAYOUT_SETTLED", "PAYOUT_FAILED", "ADJUSTMENT"];

function Trial() {
  const tb = useGet<TrialBalance>(["trial-balance"], "/ledger/trial-balance");
  const groups = new Map<string, { n: number; sum: bigint }>();
  for (const a of tb.data?.accounts ?? []) {
    const g = groups.get(a.kind) ?? { n: 0, sum: 0n };
    groups.set(a.kind, { n: g.n + 1, sum: g.sum + BigInt(a.balance) });
  }
  const rows = [...groups].map(([kind, g]) => ({ kind, n: g.n, sum: g.sum.toString() }));
  const zero = tb.data !== undefined && BigInt(tb.data.sum) === 0n;
  return (
    <>
      <ErrorPanel error={tb.error} />
      {tb.data && (
        <>
          <DataTable rows={rows} empty="전기가 없습니다."
            columns={[{ key: "kind", label: "계정 종류" }, { key: "n", label: "계정 수" }, { key: "sum", label: "잔액 합", render: (r) => <Money krw={r.sum} /> }]} />
          <p role="status" className={zero ? "muted" : "error-text"}>전체 합계 <Money krw={tb.data.sum} /> — {zero ? "합계 0 확인됨" : "합계가 0이 아닙니다(불일치)"}</p>
        </>
      )}
    </>
  );
}

export function Ledger() {
  const actor = useActor();
  const [kind, setKind] = useState("");
  const [account, setAccount] = useState("");
  const [party, setParty] = useState("");
  const accounts = useList<LedgerAccount>("ledger-accounts", "/ledger/accounts");
  const entries = useList<EntryRow>("ledger-entries", "/ledger/entries", { kind, account: account.trim(), party: party.trim() });
  return (
    <>
      <Section title="원장 안내" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>원장 조회는 정산 담당(SPACE_SETTLE)만 합니다. 현재 사용자: <strong>{actor}</strong></p>
      </Section>
      <Section title="시산표"><Trial /></Section>
      <Section title="계정 표">
        <ErrorPanel error={accounts.error} />
        <DataTable<LedgerAccount> rows={accounts.pages} empty="계정이 없습니다."
          columns={[
            { key: "accountId", label: "계정" }, { key: "kind", label: "종류" },
            { key: "partyId", label: "권리자", render: (r) => r.partyId ?? "—" }, { key: "reason", label: "사유", render: (r) => r.reason ?? "—" },
            { key: "bucket", label: "버킷", render: (r) => r.bucket ?? "—" },
            { key: "balance", label: "잔액", render: (r) => <Money krw={r.balance} /> },
          ]} />
        <Pager next={accounts.next} loadMore={accounts.loadMore} />
      </Section>
      <Section title="분개 목록" actions={
        <div className="inline-form">
          <label className="field"><span>종류 필터</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">전체</option>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          </label>
          <label className="field"><span>계정 필터</span><input value={account} onChange={(e) => setAccount(e.target.value)} /></label>
          <label className="field"><span>권리자 필터</span><input value={party} onChange={(e) => setParty(e.target.value)} /></label>
        </div>
      }>
        <ErrorPanel error={entries.error} />
        <DataTable<EntryRow> rows={entries.pages} empty="분개가 없습니다."
          columns={[
            { key: "entryId", label: "분개", render: (r) => <Link to={`/ledger/entries/${r.entryId}`}>{r.entryId}</Link> },
            { key: "kind", label: "종류" }, { key: "sourceRef", label: "출처" },
            { key: "total", label: "차변 합", render: (r) => <Money krw={r.total} /> },
            { key: "occurredAt", label: "발생(UTC)", render: (r) => <Instant iso={r.occurredAt} /> },
            { key: "createdBy", label: "생성자" },
          ]} />
        <Pager next={entries.next} loadMore={entries.loadMore} />
      </Section>
    </>
  );
}

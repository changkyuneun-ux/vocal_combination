import { useState } from "react";
import { Section } from "../../components/Section.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Money } from "../../components/Money.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useGet } from "../../api/hooks.ts";
import { useClock } from "../../api/clock.ts";
import { useAll } from "../../api/all.ts";
import { toIso } from "../../api/registry.ts";
import { toLocalInput } from "../../api/revenue.ts";
import type { LedgerAccount, StatementData } from "../../api/types.ts";
import { actualPayout, partyPayableId, reconcile } from "./logic.ts";

const SETTLE_ACTOR = "usr_settle";
const DEFAULT_FROM = "2026-01-01T00:00:00";

function Verdict({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const tone = ok === null ? "muted" : ok ? "ok" : "bad";
  const text = ok === null ? "대조 불가" : ok ? "일치" : "불일치";
  return <p role="status"><span className={`badge ${tone}`}>{text}</span> {children}</p>;
}

function Result({ s, accounts, now }: { s: StatementData; accounts: LedgerAccount[]; now: string | undefined }) {
  const acct = accounts.find((a) => a.accountId === partyPayableId(s.partyId));
  const r = reconcile(s, acct?.balance ?? null);
  const act = actualPayout(s);
  const rows: { label: string; value: string; note?: React.ReactNode; sub?: boolean }[] = [
    { label: "기초(opening)", value: s.opening },
    { label: "+ 정산(settled)", value: s.settled },
    { label: "+ 역분개(reversed)", value: s.reversed },
    { label: "+ 해제(holdReleased)", value: s.holdReleased },
    { label: "+ 조정(adjusted)", value: s.adjusted },
    { label: "− 지급 총액(payoutGross)", value: s.payoutGross, note: <>이 중 원천세 <Money krw={s.withholding} />, 실지급 <Money krw={s.payoutNet} /></> },
    { label: "+ 실패 복원(payoutFailedRestored)", value: s.payoutFailedRestored, note: <>복원된 원천세 <Money krw={s.withholdingRestored} />, 복원된 실지급 <Money krw={s.netRestored} /> (실제 원천세 <Money krw={act.withholding.toString()} />, 실제 실지급 <Money krw={act.net.toString()} />)</> },
    { label: "= 기말(closing)", value: s.closing },
  ];
  return (
    <>
      <table className="data">
        <caption className="muted">권리자 {s.partyId} · {s.from} ~ {s.to} (UTC, 끝은 미포함)</caption>
        <thead><tr><th scope="col">항목</th><th scope="col">금액</th><th scope="col">비고</th></tr></thead>
        <tbody>{rows.map((x) => <tr key={x.label}><td>{x.label}</td><td><Money krw={x.value} /></td><td>{x.note ?? ""}</td></tr>)}</tbody>
      </table>
      <Verdict ok={r.identityOk}>
        대조 1 — 항등식 계산값 <Money krw={r.identity.toString()} /> {r.identityOk ? "=" : "≠"} 기말 <Money krw={r.closing.toString()} />
        {!r.identityOk && <> (차이 <Money krw={r.identityDiff.toString()} />)</>}
      </Verdict>
      <Verdict ok={r.balanceOk}>
        {r.expectedClosing === null
          ? <>대조 2 — {partyPayableId(s.partyId)} 계정이 없습니다.</>
          : <>대조 2 — 기말 <Money krw={r.closing.toString()} /> {r.balanceOk ? "=" : "≠"} −({partyPayableId(s.partyId)} 잔액 <Money krw={acct?.balance ?? "0"} />) = <Money krw={r.expectedClosing.toString()} />
              {!r.balanceOk && r.balanceDiff !== null && <> (차이 <Money krw={r.balanceDiff.toString()} />)</>}</>}
      </Verdict>
      {now !== undefined && s.to < now && <p className="muted">기간 끝이 가상 시계({now})보다 앞서면 그 뒤의 전기 때문에 대조 2가 어긋날 수 있습니다.</p>}
    </>
  );
}

export function Statements() {
  const actor = useActor();
  const accounts = useAll<LedgerAccount>("ledger-accounts-all", "/ledger/accounts");
  const clock = useClock();
  const [party, setParty] = useState("");
  const [from, setFrom] = useState(DEFAULT_FROM);
  const [toEdit, setToEdit] = useState<string | null>(null);
  const first = clock.data?.now;
  const parties = (accounts.data ?? []).filter((a) => a.kind === "PARTY_PAYABLE" && a.partyId !== null).map((a) => a.partyId as string);
  const to = toEdit ?? (first ? toLocalInput(first) : "");
  const fromIso = toIso(from);
  const toIsoValue = toEdit === null ? first ?? "" : toIso(toEdit);
  const q = useGet<StatementData>(["statement", party, fromIso, toIsoValue],
    `/parties/${encodeURIComponent(party)}/statements?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIsoValue)}`,
    { enabled: party !== "" && fromIso !== "" && toIsoValue !== "" });
  return (
    <>
      <Section title="명세서 안내" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>명세·원장 조회는 정산 담당(SPACE_SETTLE)이 합니다. 현재 사용자: <strong>{actor}</strong></p>
      </Section>
      <Section title="권리자 명세">
        <div className="inline-form">
          <label className="field"><span>권리자</span>
            <select value={party} onChange={(e) => setParty(e.target.value)}>
              <option value="">선택…</option>{parties.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="field"><span>기간 시작(UTC)</span><input type="datetime-local" step={1} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>기간 끝(UTC)</span><input type="datetime-local" step={1} value={to} onChange={(e) => setToEdit(e.target.value)} /></label>
          <button type="button" className="btn" disabled={!clock.data} onClick={() => setToEdit(toLocalInput(new Date(Math.ceil(Date.parse(clock.data!.now) / 1000) * 1000).toISOString()))}>끝 = 지금</button>
        </div>
        <ErrorPanel error={accounts.error} />
        <ErrorPanel error={clock.error} />
        <ErrorPanel error={q.error} />
        {party === "" && <p className="muted">권리자를 선택하세요.</p>}
        {q.data && <Result s={q.data} accounts={accounts.data ?? []} now={clock.data?.now} />}
      </Section>
    </>
  );
}

import { useState } from "react";
import { Section } from "../../components/Section.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import { useAll } from "../../api/all.ts";
import { setPayoutProfile } from "../../api/payout.ts";
import type { ClockState, LedgerAccount, PayoutPolicyData, PayoutProfile, ProfileInput } from "../../api/types.ts";
import { isCooling } from "./logic.ts";

const REGISTER_ACTOR = "usr_settle2";
const RUN_ACTOR = "usr_settle";
const TAX_TYPES = ["DOMESTIC_INDIVIDUAL", "DOMESTIC_CORP", "FOREIGN", "EXEMPT"];

function Editor({ partyId, profile, onDone }: { partyId: string; profile: PayoutProfile | null; onDone: () => void }) {
  const [taxType, setTaxType] = useState(profile?.taxType ?? "DOMESTIC_INDIVIDUAL");
  const [account, setAccount] = useState(profile?.payoutAccountRef ? "" : `acct_${partyId}`);
  const [clear, setClear] = useState(false);
  const [kyc, setKyc] = useState(profile?.kycVerified ?? true);
  const m = useAction<ProfileInput, unknown>(setPayoutProfile, ["payout-profile"]);
  const trimmed = account.trim();
  const submit = () => {
    const body: ProfileInput = { partyId, taxType, kycVerified: kyc };
    if (clear) body.payoutAccountRef = null;
    else if (trimmed !== "") body.payoutAccountRef = trimmed;
    m.mutate(body, { onSuccess: onDone });
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label className="field"><span>세금 유형</span>
        <select aria-label={`권리자[${partyId}] 세금 유형`} value={taxType} onChange={(e) => setTaxType(e.target.value)}>
          {TAX_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label className="field"><span>계좌 토큰{profile?.payoutAccountRef ? " (비우면 변경 없음)" : ""}</span>
        <input aria-label={`권리자[${partyId}] 계좌 토큰 입력`} value={account} disabled={clear} onChange={(e) => setAccount(e.target.value)} placeholder={profile?.payoutAccountRef ?? `acct_${partyId}`} />
      </label>
      <label className="field"><span>계좌 토큰 지우기</span>
        <input type="checkbox" aria-label={`권리자[${partyId}] 토큰 지우기`} checked={clear} onChange={(e) => setClear(e.target.checked)} />
      </label>
      <label className="field"><span>KYC 확인</span>
        <input type="checkbox" aria-label={`권리자[${partyId}] KYC 확인`} checked={kyc} onChange={(e) => setKyc(e.target.checked)} />
      </label>
      <button type="submit" className="btn primary" aria-label={`권리자[${partyId}] 프로필 저장`} disabled={m.isPending}>저장</button>
      {m.isSuccess && <p className="muted" role="status">저장했습니다. 첫 지급 가능 시각은 서버가 등록 시점의 가상 시계로 정하며, 초기 보류 기간(지급 정책)이 지나야 지급됩니다.</p>}
      <ErrorPanel error={m.error} />
    </form>
  );
}

function Row({ partyId, now, actor }: { partyId: string; now: string | undefined; actor: string }) {
  const [open, setOpen] = useState(false);
  const q = useGet<PayoutProfile>(["payout-profile", partyId], `/parties/${encodeURIComponent(partyId)}/payout-profile`);
  const missing = q.error?.status === 404;
  const p = q.data ?? null;
  const cooling = p !== null && isCooling(p.coolingUntil, now);
  return (
    <>
      <tr>
        <td>{partyId}</td>
        <td>{q.isPending ? <span className="muted">읽는 중…</span> : missing ? <span className="muted">프로필 없음</span> : p ? p.taxType : <span className="muted">—</span>}</td>
        <td>{p?.payoutAccountRef ?? <span className="muted">—</span>}</td>
        <td>{p ? (p.kycVerified ? "예" : "아니오") : "—"}</td>
        <td>{p ? <Instant iso={p.firstPayableAt} /> : "—"}</td>
        <td>
          {p && cooling && <span className="badge warn">냉각 중 ~ {p.coolingUntil}</span>}
          {p && !cooling && p.coolingUntil && <span className="muted">냉각 끝남</span>}
          {p?.accountChangedBy && (
            <div>마지막 계좌 변경자: <strong>{p.accountChangedBy}</strong>
              <span className="badge warn"> {p.accountChangedBy}는 이 권리자의 지급을 실행할 수 없습니다(직무 분리)</span>
            </div>
          )}
        </td>
        <td>
          <button type="button" className="btn tiny" aria-expanded={open} aria-label={`권리자[${partyId}] 프로필 편집`} onClick={() => setOpen(!open)}>
            {p ? "편집" : "등록"}
          </button>
        </td>
      </tr>
      {q.error && !missing && <tr><td colSpan={7}><ErrorPanel error={q.error} /></td></tr>}
      {open && <tr><td colSpan={7}><Editor partyId={partyId} profile={p} onDone={() => setOpen(false)} /></td></tr>}
    </>
  );
}

export function Profiles() {
  const actor = useActor();
  const accounts = useAll<LedgerAccount>("ledger-accounts-all", "/ledger/accounts");
  const policy = useGet<PayoutPolicyData>(["payout-policy"], "/payout-policy");
  const clock = useGet<ClockState>(["clock"], "/dev/clock", { refetchInterval: 5000 });
  const parties = (accounts.data ?? []).filter((a) => a.kind === "PARTY_PAYABLE" && a.partyId !== null).map((a) => a.partyId as string);
  return (
    <>
      <Section title="지급 프로필 안내" actions={
        <>
          <button type="button" className="btn primary" disabled={actor === REGISTER_ACTOR} onClick={() => setActor(REGISTER_ACTOR)}>{REGISTER_ACTOR}로 전환</button>
          <button type="button" className="btn" disabled={actor === RUN_ACTOR} onClick={() => setActor(RUN_ACTOR)}>{RUN_ACTOR}로 전환</button>
        </>
      }>
        <p>프로필 등록·조회는 정산 담당(SPACE_SETTLE)이 합니다. 현재 사용자: <strong>{actor}</strong></p>
        <p className="muted">직무 분리: 계좌 토큰을 마지막으로 바꾼 사용자는 그 권리자의 지급 run을 실행할 수 없습니다(ACCOUNT_SOD). 프로필은 {REGISTER_ACTOR}로 등록하고 지급은 {RUN_ACTOR}로 실행하세요.</p>
      </Section>
      <Section title="지급 정책">
        <ErrorPanel error={policy.error} />
        {policy.data && (
          <p>최소 지급액 <Money krw={policy.data.minPayoutKrw} /> · 초기 보류 {policy.data.initialHoldDays}일 · 계좌 냉각 {policy.data.accountCoolingHours}시간 · 세율(bps) <code>{JSON.stringify(policy.data.taxBps)}</code></p>
        )}
      </Section>
      <Section title="권리자별 프로필">
        <ErrorPanel error={accounts.error} />
        <ErrorPanel error={clock.error} />
        {accounts.data && parties.length === 0 && <p className="muted">미지급금 계정이 있는 권리자가 없습니다(정산 확정·반영 뒤에 생깁니다).</p>}
        {parties.length > 0 && (
          <table className="data">
            <thead><tr>{["권리자", "세금 유형", "계좌 토큰", "KYC", "첫 지급 가능(UTC)", "냉각·변경자", "작업"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{parties.map((id) => <Row key={id} partyId={id} now={clock.data?.now} actor={actor} />)}</tbody>
          </table>
        )}
      </Section>
    </>
  );
}

import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { devApi, type ApiError } from "../../api/client.ts";
import { useAll } from "../../api/all.ts";
import { sendWebhook, setInstructionOutcome, setPartyOutcome } from "../../api/dev.ts";
import type { DevOutcome, InstructionRow, LedgerAccount, PayoutRunRow, PspOutcomes, PspRequest, WebhookResponses } from "../../api/types.ts";
import { openInstructions } from "../payout/logic.ts";

const SETTLE_ACTOR = "usr_settle";
const POLL_MS = 3000;
const OUTCOMES: DevOutcome[] = ["PAID", "FAILED", "UNKNOWN"];
const OUTCOMES_KEY = ["dev", "outcomes"];

function useOutcomes() {
  return useQuery<PspOutcomes, ApiError>({ queryKey: OUTCOMES_KEY, queryFn: () => devApi<PspOutcomes>("GET", "/psp/outcomes") });
}

/** PUT 응답(전체 지정 현황)을 캐시에 바로 반영한다. */
function useSetOutcome<I>(fn: (i: I) => Promise<PspOutcomes>) {
  const qc = useQueryClient();
  return useMutation<PspOutcomes, ApiError, I>({ mutationFn: fn, onSuccess: (r) => { qc.setQueryData(OUTCOMES_KEY, r); } });
}

function OutcomeSelect({ label, value, onPick, busy }: { label: string; value: string | undefined; onPick: (o: DevOutcome) => void; busy: boolean }) {
  return (
    <select aria-label={label} value={value ?? ""} disabled={busy} onChange={(e) => onPick(e.target.value as DevOutcome)}>
      {value === undefined && <option value="">기본(PAID)</option>}
      {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function WebhookCell({ instructionId }: { instructionId: string }) {
  const [repeat, setRepeat] = useState("1");
  const [st, setSt] = useState<"" | "PAID" | "FAILED">("");
  const m = useMutation<WebhookResponses, ApiError, { instructionId: string; repeat: number; status?: "PAID" | "FAILED" }>({ mutationFn: sendWebhook });
  return (
    <div className="stack">
      <div className="inline-form">
        <select aria-label={`지시[${instructionId}] webhook 반복`} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
          <option value="1">1회</option><option value="2">2회(중복)</option>
        </select>
        <select aria-label={`지시[${instructionId}] webhook 상태`} value={st} onChange={(e) => setSt(e.target.value as "" | "PAID" | "FAILED")}>
          <option value="">자동</option><option value="PAID">PAID</option><option value="FAILED">FAILED</option>
        </select>
        <button type="button" className="btn tiny" aria-label={`지시[${instructionId}] webhook 보내기`} disabled={m.isPending}
          onClick={() => m.mutate({ instructionId, repeat: Number(repeat), ...(st !== "" && { status: st }) })}>webhook 보내기</button>
      </div>
      {m.data && (
        <table className="data" aria-label={`지시[${instructionId}] webhook 응답`}>
          <thead><tr><th scope="col">#</th><th scope="col">상태 코드</th><th scope="col">본문</th></tr></thead>
          <tbody>{m.data.responses.map((r, i) => <tr key={i}><td>{i + 1}</td><td>{r.statusCode}</td><td><code>{JSON.stringify(r.body)}</code></td></tr>)}</tbody>
        </table>
      )}
      <ErrorPanel error={m.error} />
    </div>
  );
}

function InstructionOutcome({ instructionId, current }: { instructionId: string; current: DevOutcome | undefined }) {
  const m = useSetOutcome(setInstructionOutcome);
  return (
    <>
      <OutcomeSelect label={`지시[${instructionId}] PSP 결과`} value={current} busy={m.isPending}
        onPick={(outcome) => m.mutate({ instructionId, outcome })} />
      <ErrorPanel error={m.error} />
    </>
  );
}

function OpenInstructions({ outcomes, exclude }: { outcomes: PspOutcomes | undefined; exclude: string }) {
  const runs = useAll<PayoutRunRow>("payout-runs", "/payout-runs", { refetchInterval: POLL_MS });
  const latest = runs.data?.[0]?.payoutRunId;
  const ins = useAll<InstructionRow>("payout-instructions", `/payout-runs/${encodeURIComponent(latest ?? "")}/instructions`, { enabled: latest !== undefined, refetchInterval: POLL_MS });
  // 위쪽 "지정한 지시"에 이미 보이는 지시는 여기서 뺀다(같은 이름의 조작이 두 번 나오지 않도록).
  const open = openInstructions(ins.data ?? []).filter((i) => i.instructionId !== exclude);
  return (
    <>
      <ErrorPanel error={runs.error} />
      <ErrorPanel error={ins.error} />
      {runs.data && latest === undefined && <p className="muted">지급 run이 없습니다.</p>}
      {latest !== undefined && <p className="muted">최근 지급 run: {latest} — 열린(PENDING·SUBMITTED) 지시 {open.length}건. 결과 지정은 그 지시를 PSP에 처음 보내기 전에만 의미가 있습니다.</p>}
      <DataTable<InstructionRow> rows={open} empty="열린 지시가 없습니다."
        columns={[
          { key: "instructionId", label: "지시" }, { key: "partyId", label: "권리자" },
          { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
          { key: "outcome", label: "PSP 결과", render: (r) => <InstructionOutcome instructionId={r.instructionId} current={outcomes?.byInstruction[r.instructionId]} /> },
          { key: "webhook", label: "webhook", render: (r) => <WebhookCell instructionId={r.instructionId} /> },
        ]} />
    </>
  );
}

function FocusedInstruction({ instructionId, outcomes }: { instructionId: string; outcomes: PspOutcomes | undefined }) {
  return (
    <div className="stack">
      <p>지시 <strong>{instructionId}</strong></p>
      <div className="inline-form"><InstructionOutcome instructionId={instructionId} current={outcomes?.byInstruction[instructionId]} /></div>
      <WebhookCell instructionId={instructionId} />
    </div>
  );
}

function PartyOutcomeRow({ partyId, current }: { partyId: string; current: DevOutcome | undefined }) {
  const m = useSetOutcome(setPartyOutcome);
  return (
    <tr>
      <td>{partyId}</td>
      <td>
        <OutcomeSelect label={`권리자[${partyId}] PSP 결과`} value={current} busy={m.isPending} onPick={(outcome) => m.mutate({ partyId, outcome })} />
        <ErrorPanel error={m.error} />
      </td>
    </tr>
  );
}

function PartyOutcomes({ outcomes }: { outcomes: PspOutcomes | undefined }) {
  const accounts = useAll<LedgerAccount>("ledger-accounts-all", "/ledger/accounts");
  const [extra, setExtra] = useState("");
  const add = useSetOutcome(setPartyOutcome);
  const payable = (accounts.data ?? []).filter((a) => a.kind === "PARTY_PAYABLE" && a.partyId !== null).map((a) => a.partyId as string);
  const parties = [...new Set([...payable, ...Object.keys(outcomes?.byParty ?? {})])];
  return (
    <div className="stack">
      <p className="muted">지급 run을 만들기 전에 지정하세요(예: pty_label을 FAILED로). 지시별 지정이 권리자별 지정보다 우선합니다.</p>
      <ErrorPanel error={accounts.error} />
      {parties.length > 0 && (
        <table className="data">
          <thead><tr><th scope="col">권리자</th><th scope="col">PSP 결과</th></tr></thead>
          <tbody>{parties.map((p) => <PartyOutcomeRow key={p} partyId={p} current={outcomes?.byParty[p]} />)}</tbody>
        </table>
      )}
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); }}>
        <label className="field"><span>권리자 id 직접 입력</span><input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="pty_label" /></label>
        {OUTCOMES.map((o) => (
          <button key={o} type="button" className="btn" disabled={extra.trim() === "" || add.isPending}
            onClick={() => add.mutate({ partyId: extra.trim(), outcome: o }, { onSuccess: () => setExtra("") })}>입력한 권리자 → {o}</button>
        ))}
      </form>
      <ErrorPanel error={add.error} />
    </div>
  );
}

function Requests() {
  const q = useQuery<{ items: PspRequest[] }, ApiError>({ queryKey: ["dev", "psp-requests"], queryFn: () => devApi<{ items: PspRequest[] }>("GET", "/psp/requests"), refetchInterval: POLL_MS });
  return (
    <>
      <ErrorPanel error={q.error} />
      <DataTable<PspRequest> rows={q.data?.items ?? []} empty="PSP 요청 기록이 없습니다."
        columns={[
          { key: "at", label: "시각(UTC)", render: (r) => <Instant iso={r.at} /> }, { key: "op", label: "종류" },
          { key: "instructionId", label: "지시" }, { key: "result", label: "결과" }, { key: "key", label: "멱등 키" },
        ]} />
    </>
  );
}

export function Psp() {
  const actor = useActor();
  const [sp] = useSearchParams();
  const focus = sp.get("instruction") ?? "";
  const outcomes = useOutcomes();
  return (
    <>
      <Section title="PSP 시뮬레이터 안내" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>/dev 호출은 사용자 신원이 필요 없지만, 열린 지시 목록은 지급 조회(SPACE_SETTLE)라 정산 담당으로 읽습니다. 현재 사용자: <strong>{actor}</strong></p>
        <ErrorPanel error={outcomes.error} />
      </Section>
      {focus !== "" && <Section title="지정한 지시"><FocusedInstruction instructionId={focus} outcomes={outcomes.data} /></Section>}
      <Section title="열린 지시"><OpenInstructions outcomes={outcomes.data} exclude={focus} /></Section>
      <Section title="권리자별 PSP 결과"><PartyOutcomes outcomes={outcomes.data} /></Section>
      <Section title="PSP 요청 기록"><Requests /></Section>
    </>
  );
}

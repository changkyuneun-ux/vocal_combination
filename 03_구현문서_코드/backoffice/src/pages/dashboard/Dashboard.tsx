import { Link } from "react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useGet } from "../../api/hooks.ts";
import type { ApiError, Paged } from "../../api/client.ts";
import { violations, type InvariantReport } from "../../api/invariants.ts";
import type { AuditRow, BatchRow, HoldRow, IssueRow, LedgerAccount, PackRow, Party, PayoutRunRow, PolicyRow, ReversalRow, RevenueEventRow, EntryRow } from "../../api/types.ts";
import { countLabel, judge, type Fact, type Facts } from "./checklist.ts";

const SETTLE_ACTOR = "usr_settle";
const AUDIT_ACTOR = "usr_settle";
type P<T> = UseQueryResult<Paged<T>, ApiError>;

const usePage = <T,>(key: string, path: string): P<T> => useGet<Paged<T>>(["dash", key], `${path}${path.includes("?") ? "&" : "?"}limit=200`);

function fact<D, T>(q: UseQueryResult<D, ApiError>, f: (d: D) => T): Fact<T> {
  if (q.data !== undefined) return { ok: true, value: f(q.data) };
  if (q.error) return { ok: false, error: `${q.error.code} ${q.error.message}` };
  return { ok: false, error: "읽는 중…" };
}
const size = <T,>(q: P<T>, keep: (x: T) => boolean = () => true) => fact(q, (d) => d.items.filter(keep).length);
const label = <T,>(q: P<T>) => (q.data ? countLabel(q.data) : q.error ? "?" : "…");

const STATE_TEXT = { done: "완료", todo: "미완료", unknown: "알 수 없음" } as const;
const STATE_TONE = { done: "ok", todo: "muted", unknown: "warn" } as const;

export function Dashboard() {
  const actor = useActor();
  const parties = usePage<Party>("parties", "/parties");
  const policies = usePage<PolicyRow>("policies", "/policies");
  const packs = usePage<PackRow>("packs", "/packs");
  const issues = usePage<IssueRow>("issues", "/issues");
  const purchases = usePage<RevenueEventRow>("purchases", "/revenue-events?type=PURCHASE");
  const refunds = usePage<RevenueEventRow>("refunds", "/revenue-events?type=REFUND");
  const confirmed = usePage<BatchRow>("batches-confirmed", "/batches?status=CONFIRMED");
  const openBatches = usePage<BatchRow>("batches-open", "/batches?status=OPEN");
  const reversals = usePage<ReversalRow>("reversals", "/reversals");
  const holds = usePage<HoldRow>("holds", "/holds");
  const entries = usePage<EntryRow>("entries", "/ledger/entries");
  const accounts = usePage<LedgerAccount>("accounts", "/ledger/accounts");
  const runs = usePage<PayoutRunRow>("payout-runs", "/payout-runs");
  const inv = useGet<InvariantReport>(["dash", "invariants"], "/settlement/invariants");
  // 감사는 정산 담당 신원으로 읽는다(화면에 표시). 프로필 등록 여부도 같은 감사 기록에서 본다.
  const audit = useGet<Paged<AuditRow>>(["dash", "audit"], "/audit?limit=20", { api: { actorOverride: AUDIT_ACTOR } });
  const profileAudit = useGet<Paged<AuditRow>>(["dash", "profile-audit"], "/audit?entityType=party_payout_profile&limit=1", { api: { actorOverride: AUDIT_ACTOR } });

  const paid = (r: PayoutRunRow[]) => r.reduce((a, x) => a + (x.statusCounts.PAID ?? 0), 0);
  const facts: Facts = {
    parties: size(parties),
    activePolicy: fact(policies, (d) => d.items.some((p) => p.activeVersion !== null)),
    activePacks: size(packs, (p) => p.status === "ACTIVE"),
    issues: size(issues),
    purchases: size(purchases),
    refunds: size(refunds),
    confirmedBatches: size(confirmed),
    reversals: size(reversals),
    releasedHolds: size(holds, (h) => h.release !== null),
    profiles: size(profileAudit),
    paidInstructions: fact(runs, (d) => paid(d.items)),
    invariantViolations: fact(inv, (d) => violations(d).length),
  };
  const steps = judge(facts);
  const paidN = runs.data ? `${paid(runs.data.items)}${runs.data.next ? "+" : ""}` : runs.error ? "?" : "…";
  const payableN = accounts.data ? accounts.data.items.filter((a) => a.kind === "PARTY_PAYABLE").length : null;
  const cards: { name: string; value: string; err?: unknown }[] = [
    { name: "권리자", value: label(parties), err: parties.error },
    { name: "활성 팩", value: packs.data ? `${packs.data.items.filter((p) => p.status === "ACTIVE").length}${packs.data.next ? "+" : ""}` : packs.error ? "?" : "…", err: packs.error },
    { name: "발행", value: label(issues), err: issues.error },
    { name: "매출(구매)", value: label(purchases), err: purchases.error },
    { name: "매출(환불)", value: label(refunds), err: refunds.error },
    { name: "배치 OPEN", value: label(openBatches), err: openBatches.error },
    { name: "배치 CONFIRMED", value: label(confirmed), err: confirmed.error },
    { name: "분개", value: label(entries), err: entries.error },
    { name: "미지급금 계정", value: payableN === null ? (accounts.error ? "?" : "…") : String(payableN), err: accounts.error },
    { name: "PAID 지시", value: paidN, err: runs.error },
  ];
  const v = inv.data ? violations(inv.data) : null;
  return (
    <>
      <Section title="대시보드 안내" actions={
        <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
      }>
        <p>건수·점검은 현재 사용자(<strong>{actor}</strong>)로 읽습니다. 권한이 없는 항목은 오류를 그대로 보여 주고, 체크리스트에서는 "알 수 없음"으로 표시합니다. 200건을 넘으면 "200+"로 표시합니다.</p>
      </Section>
      <Section title="단계별 건수">
        <ul className="cards" aria-label="건수 카드 목록">
          {cards.map((c) => <li key={c.name} className="card"><span className="muted">{c.name}</span> <strong>{c.value}</strong></li>)}
        </ul>
        {cards.map((c) => c.err ? <div key={c.name}><span className="muted">{c.name}:</span><ErrorPanel error={c.err} /></div> : null)}
      </Section>
      <Section title="점검 결과">
        <ErrorPanel error={inv.error} />
        {inv.isPending && <p className="muted">읽는 중…</p>}
        {v && v.length === 0 && <p role="status"><span className="badge ok">점검 정상</span></p>}
        {v && v.length > 0 && (
          <ul>{v.map((x) => <li key={x.key}><span className="badge bad">위반</span> <strong>{x.label}</strong> <span className="muted">{x.detail}</span></li>)}</ul>
        )}
      </Section>
      <Section title="권장 검증 순서">
        <ol className="stack" aria-label="체크리스트 단계">
          {steps.map((s) => (
            <li key={s.no}>
              <span className={`badge ${STATE_TONE[s.state]}`}>{STATE_TEXT[s.state]}</span> {s.no}. {s.label}{s.no === 9 && <span className="muted"> (감사 기록, usr_settle로 조회)</span>}{" "}
              <Link to={s.to} aria-label={`단계[${s.no}] 열기`}>열기</Link>
              {s.state === "unknown" && s.error && <span className="muted"> — {s.error}</span>}
            </li>
          ))}
        </ol>
        <ErrorPanel error={profileAudit.error} />
      </Section>
      <Section title="최근 감사 20건">
        <p className="muted">정산 담당 신원으로 조회 ({AUDIT_ACTOR})</p>
        <ErrorPanel error={audit.error} />
        <DataTable<AuditRow> rows={audit.data?.items ?? []} empty={audit.isPending ? "읽는 중…" : "감사 기록이 없습니다."}
          columns={[
            { key: "occurredAt", label: "시각(UTC)", render: (r) => <Instant iso={r.occurredAt} /> },
            { key: "actor", label: "행위자" }, { key: "action", label: "행위" },
            { key: "entity", label: "대상", render: (r) => `${r.entityType} ${r.entityId}` },
          ]} />
      </Section>
    </>
  );
}

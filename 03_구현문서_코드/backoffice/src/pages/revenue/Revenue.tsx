import { Fragment, useState } from "react";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { Pager } from "../../components/Pager.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useGet, useList } from "../../api/hooks.ts";
import { editedOr, useClock } from "../../api/clock.ts";
import { INGEST_ACTOR, nowStamp, recordRevenue, toLocalInput } from "../../api/revenue.ts";
import { toIso } from "../../api/registry.ts";
import { nextEventId } from "./eventId.ts";
import type { EventSettlement, IssueRow, RevenueBody, RevenueEventRow } from "../../api/types.ts";

type Tab = "purchase" | "refund" | "correction";
const TABS: { id: Tab; label: string }[] = [{ id: "purchase", label: "구매" }, { id: "refund", label: "환불" }, { id: "correction", label: "정정" }];
const AMOUNT = /^[1-9]\d*$/;

/** 가상 시계의 현재 값(폼 기본값). 사용자가 고치지 않은 필드는 시계를 따라간다. */
function useClockDefault(): { now: string | undefined; error: unknown } {
  const clock = useClock();
  return { now: clock.data?.now, error: clock.error };
}

type Shared = { taken: string[]; onRecorded: (id: string) => void };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Result({ m }: { m: { isSuccess: boolean; data?: { eventId: string; created: boolean }; error: unknown } }) {
  return (
    <>
      {m.isSuccess && m.data && <p className="muted" role="status">{m.data.created ? "기록했습니다" : "이미 기록된 이벤트입니다(멱등)"}: {m.data.eventId}</p>}
      <ErrorPanel error={m.error} />
    </>
  );
}

function PurchaseForm({ now, issues, taken, onRecorded }: { now: string; issues: IssueRow[] } & Shared) {
  const stamp = nowStamp(now);
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const eventId = idEdit ?? nextEventId(stamp, "p", taken);
  const setEventId = (v: string) => setIdEdit(v);
  const [vcId, setVcId] = useState("");
  const [amount, setAmount] = useState("");
  const [atEdit, setAtEdit] = useState<string | null>(null);
  const at = editedOr(atEdit, toLocalInput(now));
  const [integrity, setIntegrity] = useState<"CLEAR" | "FLAGGED">("CLEAR");
  const m = useAction<RevenueBody, { eventId: string; created: boolean }>(recordRevenue, ["revenue"]);
  const vcs = [...new Set(issues.map((i) => i.vcId))];
  const ok = eventId.trim() !== "" && vcId !== "" && AMOUNT.test(amount) && at !== "";
  const submit = () => m.mutate({
    eventId: eventId.trim(), sourceSystem: "app", sourceEventId: eventId.trim(), eventType: "PURCHASE", vcId,
    amountKrw: amount, currency: "KRW", integrity, occurredAt: toIso(at),
  }, { onSuccess: (r) => { setIdEdit(null); onRecorded(r.eventId); } });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Field label="eventId"><input value={eventId} onChange={(e) => setEventId(e.target.value)} required /></Field>
      <Field label="조합(vcId)">
        <select value={vcId} onChange={(e) => setVcId(e.target.value)} required>
          <option value="">선택…</option>{vcs.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="구매 금액(원)"><input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000" required /></Field>
      <Field label="발생 시각(UTC)"><input type="datetime-local" step={1} value={at} onChange={(e) => setAtEdit(e.target.value)} required /></Field>
      <Field label="무결성">
        <select value={integrity} onChange={(e) => setIntegrity(e.target.value as "CLEAR" | "FLAGGED")}>
          <option value="CLEAR">CLEAR</option><option value="FLAGGED">FLAGGED</option>
        </select>
      </Field>
      <button type="submit" className="btn primary" disabled={!ok || m.isPending}>구매 기록</button>
      <Result m={m} />
    </form>
  );
}

/** 원 이벤트의 남은 순액 = 원 금액 − 이미 기록된 환불 합. */
function remaining(orig: RevenueEventRow, all: RevenueEventRow[]): bigint {
  return BigInt(orig.netAmountKrw) - all.filter((e) => e.relatedEventId === orig.eventId).reduce((a, e) => a + BigInt(e.netAmountKrw), 0n);
}
const liveOriginals = (all: RevenueEventRow[]) => all.filter((e) => e.eventType !== "REFUND" && e.supersededBy === null);

function RefundForm({ now, events, taken, onRecorded }: { now: string; events: RevenueEventRow[] } & Shared) {
  const stamp = nowStamp(now);
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const eventId = idEdit ?? nextEventId(stamp, "r", taken);
  const setEventId = (v: string) => setIdEdit(v);
  const [orig, setOrig] = useState("");
  const [amountEdit, setAmountEdit] = useState<{ orig: string; v: string } | null>(null);
  const [atEdit, setAtEdit] = useState<string | null>(null);
  const at = editedOr(atEdit, toLocalInput(now));
  const m = useAction<RevenueBody, { eventId: string; created: boolean }>(recordRevenue, ["revenue"]);
  const originals = liveOriginals(events);
  const o = originals.find((e) => e.eventId === orig);
  const def = o ? (remaining(o, events) > 0n ? remaining(o, events).toString() : "") : "";
  const amount = amountEdit && amountEdit.orig === orig ? amountEdit.v : def;
  const ok = eventId.trim() !== "" && o !== undefined && AMOUNT.test(amount) && at !== "";
  const submit = () => m.mutate({
    eventId: eventId.trim(), sourceSystem: "app", sourceEventId: eventId.trim(), eventType: "REFUND", relatedEventId: orig,
    amountKrw: amount, currency: "KRW", occurredAt: toIso(at),
  }, { onSuccess: (r) => { setIdEdit(null); onRecorded(r.eventId); } });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Field label="환불 eventId"><input value={eventId} onChange={(e) => setEventId(e.target.value)} required /></Field>
      <Field label="원 이벤트">
        <select value={orig} onChange={(e) => setOrig(e.target.value)} required>
          <option value="">선택…</option>
          {originals.map((e) => <option key={e.eventId} value={e.eventId}>{e.eventId} ({e.vcId ?? "—"}, {e.netAmountKrw}원)</option>)}
        </select>
      </Field>
      <Field label="환불 금액(원)"><input inputMode="numeric" value={amount} onChange={(e) => setAmountEdit({ orig, v: e.target.value })} required /></Field>
      <Field label="환불 발생 시각(UTC)"><input type="datetime-local" step={1} value={at} onChange={(e) => setAtEdit(e.target.value)} required /></Field>
      <button type="submit" className="btn primary" disabled={!ok || m.isPending}>환불 기록</button>
      <Result m={m} />
    </form>
  );
}

function CorrectionForm({ now, events, taken, onRecorded }: { now: string; events: RevenueEventRow[] } & Shared) {
  const stamp = nowStamp(now);
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const eventId = idEdit ?? nextEventId(stamp, "c", taken);
  const setEventId = (v: string) => setIdEdit(v);
  const [orig, setOrig] = useState("");
  const [revEdit, setRevEdit] = useState<{ orig: string; v: string } | null>(null);
  const [amountEdit, setAmountEdit] = useState<{ orig: string; v: string } | null>(null);
  const m = useAction<RevenueBody, { eventId: string; created: boolean }>(recordRevenue, ["revenue"]);
  const originals = liveOriginals(events);
  const o = originals.find((e) => e.eventId === orig);
  const latest = o ? Math.max(...events.filter((e) => e.sourceSystem === o.sourceSystem && e.sourceEventId === o.sourceEventId).map((e) => e.sourceRevision)) : 0;
  const revision = revEdit && revEdit.orig === orig ? revEdit.v : o ? String(latest + 1) : "";
  const amount = amountEdit && amountEdit.orig === orig ? amountEdit.v : o ? o.netAmountKrw : "";
  const ok = eventId.trim() !== "" && o !== undefined && /^[1-9]\d*$/.test(revision) && AMOUNT.test(amount);
  const submit = () => {
    if (!o) return;
    m.mutate({
      eventId: eventId.trim(), sourceSystem: o.sourceSystem, sourceEventId: o.sourceEventId, sourceRevision: Number(revision),
      eventType: o.eventType as "PURCHASE" | "RESALE", ...(o.vcId !== null && { vcId: o.vcId }), amountKrw: amount, currency: "KRW",
      integrity: o.integrityStatus === "FLAGGED" ? "FLAGGED" : "CLEAR", occurredAt: o.occurredAt,
    }, { onSuccess: (r) => { setIdEdit(null); onRecorded(r.eventId); } });
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Field label="정정 eventId"><input value={eventId} onChange={(e) => setEventId(e.target.value)} required /></Field>
      <Field label="정정할 원 이벤트">
        <select value={orig} onChange={(e) => setOrig(e.target.value)} required>
          <option value="">선택…</option>
          {originals.map((e) => <option key={e.eventId} value={e.eventId}>{e.eventId} (rev {e.sourceRevision}, {e.netAmountKrw}원)</option>)}
        </select>
      </Field>
      <Field label="새 sourceRevision"><input inputMode="numeric" value={revision} onChange={(e) => setRevEdit({ orig, v: e.target.value })} required /></Field>
      <Field label="정정 금액(원)"><input inputMode="numeric" value={amount} onChange={(e) => setAmountEdit({ orig, v: e.target.value })} required /></Field>
      <button type="submit" className="btn primary" disabled={!ok || m.isPending}>정정 기록</button>
      <Result m={m} />
    </form>
  );
}

function SettlementRows({ eventId, colSpan }: { eventId: string; colSpan: number }) {
  const s = useGet<EventSettlement>(["revenue-settlement", eventId], `/revenue-events/${encodeURIComponent(eventId)}/settlement`);
  return (
    <tr><td colSpan={colSpan}>
      <div className="stack">
        <ErrorPanel error={s.error} />
        {s.error && <p className="muted">정산 상태는 정산 운영/담당 사용자로 볼 수 있습니다</p>}
        {s.data && (
          <>
            <DataTable rows={s.data.runs} empty="정산 run이 없습니다."
              columns={[{ key: "runId", label: "run" }, { key: "batchId", label: "배치" }, { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> }]} />
            <DataTable rows={s.data.reversals} empty="역분개가 없습니다."
              columns={[{ key: "reversalId", label: "역분개" }, { key: "createdAt", label: "생성(UTC)", render: (r) => <Instant iso={r.createdAt} /> }]} />
            <DataTable rows={s.data.refunds} empty="환불이 없습니다."
              columns={[{ key: "eventId", label: "환불 이벤트" }, { key: "netAmountKrw", label: "금액", render: (r) => <Money krw={r.netAmountKrw} /> }]} />
          </>
        )}
      </div>
    </td></tr>
  );
}

function EventList() {
  const [type, setType] = useState("");
  const [vc, setVc] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useList<RevenueEventRow>("revenue", "/revenue-events", { type, vc: vc.trim() });
  const cols = 9;
  return (
    <div className="stack">
      <div className="inline-form">
        <Field label="유형 필터">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">전체</option>{["PURCHASE", "RESALE", "REFUND"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="조합으로 거르기"><input value={vc} onChange={(e) => setVc(e.target.value)} /></Field>
      </div>
      <ErrorPanel error={list.error} />
      {list.pages.length === 0 ? <p className="muted">매출 이벤트가 없습니다.</p> : (
        <table className="data">
          <thead><tr>
            {["이벤트", "유형", "vcId", "원 이벤트", "금액", "무결성", "revision", "발생(UTC)", "정산"].map((h) => <th key={h} scope="col">{h}</th>)}
          </tr></thead>
          <tbody>
            {list.pages.map((r) => (
              <Fragment key={r.eventId}>
                <tr>
                  <td>{r.eventId}{r.supersededBy && <span className="muted"> (→ {r.supersededBy})</span>}</td>
                  <td>{r.eventType}</td><td>{r.vcId ?? "—"}</td><td>{r.relatedEventId ?? "—"}</td>
                  <td><Money krw={r.netAmountKrw} /></td>
                  <td>{r.integrityStatus === "FLAGGED" ? <span className="badge warn">FLAGGED</span> : r.integrityStatus}</td>
                  <td>{r.sourceRevision}</td><td><Instant iso={r.occurredAt} /></td>
                  <td><button type="button" className="btn tiny" aria-expanded={open === r.eventId}
                    aria-label={`${r.eventId} 정산 ${open === r.eventId ? "접기" : "펼치기"}`} onClick={() => setOpen(open === r.eventId ? null : r.eventId)}>
                    {open === r.eventId ? "접기" : "펼치기"}</button></td>
                </tr>
                {open === r.eventId && <SettlementRows eventId={r.eventId} colSpan={cols} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <Pager next={list.next} loadMore={list.loadMore} />
    </div>
  );
}

export function Revenue() {
  const actor = useActor();
  const [tab, setTab] = useState<Tab>("purchase");
  const { now, error: clockError } = useClockDefault();
  const [submitted, setSubmitted] = useState<string[]>([]);
  const issues = useList<IssueRow>("issues", "/issues");
  const events = useList<RevenueEventRow>("revenue", "/revenue-events", undefined);
  const taken = [...events.pages.map((e) => e.eventId), ...submitted];
  const shared: Shared = { taken, onRecorded: (id) => setSubmitted((x) => [...x, id]) };
  return (
    <>
      <Section title="입력 담당 안내" actions={
        <button type="button" className="btn primary" disabled={actor === INGEST_ACTOR} onClick={() => setActor(INGEST_ACTOR)}>sys_ingest로 전환</button>
      }>
        <p>매출 입력은 수집 담당(sys_ingest)으로 합니다. 현재 사용자: <strong>{actor}</strong></p>
      </Section>
      <Section title="매출 이벤트 입력">
        <div role="tablist" aria-label="입력 유형" className="row-actions">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="rev-panel"
              className={`btn${tab === t.id ? " primary" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div role="tabpanel" id="rev-panel" aria-labelledby={`tab-${tab}`}>
          {now === undefined ? (clockError ? <ErrorPanel error={clockError} /> : <p className="muted">가상 시계를 읽는 중…</p>) : (
            <>
              {tab === "purchase" && <PurchaseForm now={now} issues={issues.pages} {...shared} />}
              {tab === "refund" && <RefundForm now={now} events={events.pages} {...shared} />}
              {tab === "correction" && <CorrectionForm now={now} events={events.pages} {...shared} />}
              {tab !== "purchase" && <ErrorPanel error={events.error} />}
            </>
          )}
        </div>
      </Section>
      <Section title="매출 이벤트 목록"><EventList /></Section>
    </>
  );
}

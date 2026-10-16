import { useState } from "react";
import { Link } from "react-router";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { Digest } from "../../components/Digest.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { Section } from "../../components/Section.tsx";

type Signal = { key: string; label: string; value: number | string; severity: "ok" | "warn" | "bad"; link?: string };
type Stage = { stage: string; label: string; decidedBy: string; signals: Signal[] };
type Line = { partyId: string; role: string; bucket: string; kind: string; amountKrw: string };
type Revenue = {
  eventId: string; type: string; amountKrw: string; integrity: string; occurredAt: string;
  run?: { runId: string; batchId: string; status: string; resultDigest: string | null };
  lines: Line[]; holdings: { reason: string; bucket: string; amountKrw: string }[]; refunds: { eventId: string; amountKrw: string; occurredAt: string }[];
};
type ComboTrace = {
  vcId: string; song: { workId: string; title: string; factsScopeId: string };
  issue: { snapshotId: string; packId: string; policy: string; issuedAt: string; asOf: string; seal: Record<"facts" | "policy" | "projection" | "members", string> };
  assignments: { slotId: string; stemId: string; recordingId: string; performer: string | null; durationMs: number; rightsBearing: boolean }[];
  members: { partyId: string; bps: number }[]; revenue: Revenue[];
  payouts: { partyId: string; instructionId: string; payoutRunId: string; status: string; netKrw: string }[];
};
type PartyTrace = {
  party: { partyId: string; partyType: string; displayName: string; tenantId: string };
  performedIn: { vcId: string; snapshotId: string; issuedAt: string }[];
  lines: { kind: string; role: string; count: number; amountKrw: string }[];
  payouts: { instructionId: string; payoutRunId: string; status: string; grossKrw: string; netKrw: string }[];
};
type Impact = {
  subject: { kind: string; id: string; factsScopeId: string; partyId?: string };
  combinations: { vcId: string; snapshotId: string; issuedAt: string }[];
  hold: { reason: string; count: number; amountKrw: string; events: string[] };
  reverseReview: { reason: string; count: number; amountKrw: string; byParty: { partyId: string; lines: number; amountKrw: string }[] };
};

/** ⑧ 단계별 신호: 단계마다 신호와 그 단계의 최종 결정 주체. 신호 색은 정상·주의·위험. */
function Signals() {
  const q = useGet<{ asOf: string; stages: Stage[] }>(["pipeline-signals"], "/pipeline/signals", { refetchInterval: 15000 });
  return (
    <Section title="단계별 신호">
      <ErrorPanel error={q.error} />
      {q.data && (
        <>
          <p className="muted">기준 시각 <Instant iso={q.data.asOf} /> · 15초마다 갱신</p>
          <table className="data" aria-label="파이프라인 단계별 신호">
            <thead><tr><th scope="col">단계</th><th scope="col">신호</th><th scope="col">최종 결정</th></tr></thead>
            <tbody>
              {q.data.stages.map((s) => (
                <tr key={s.stage} data-stage={s.stage}>
                  <th scope="row">{s.label}</th>
                  <td>{s.signals.map((g) => (
                    <span key={g.key} className={`badge ${g.severity}`} data-signal={g.key} style={{ marginRight: 6 }}>
                      {g.link ? <Link to={g.link}>{g.label} {String(g.value)}</Link> : <>{g.label} {String(g.value)}</>}
                    </span>
                  ))}</td>
                  <td className="muted">{s.decidedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}

function ComboView({ t }: { t: ComboTrace }) {
  return (
    <div className="stack">
      <p>곡 <strong>{t.song.title}</strong> (<code>{t.song.workId}</code>) → 조합 <code>{t.vcId}</code> · 팩 <code>{t.issue.packId}</code> · 정책 <code>{t.issue.policy}</code> · 발행 <Instant iso={t.issue.issuedAt} /></p>
      <p>발행 봉인: facts <Digest value={t.issue.seal.facts} label="facts" /> 정책 <Digest value={t.issue.seal.policy} label="policy" /> 조합 지분 <Digest value={t.issue.seal.projection} label="projection" /> 멤버 <Digest value={t.issue.seal.members} label="members" /></p>
      <DataTable rows={t.assignments} columns={[
        { key: "slotId", label: "슬롯" }, { key: "stemId", label: "스템" }, { key: "performer", label: "실연", render: (r) => r.performer ?? "—" },
        { key: "durationMs", label: "ms" }, { key: "rightsBearing", label: "정산 대상", render: (r) => (r.rightsBearing ? "예" : "아니오") },
      ]} />
      {t.revenue.map((e) => (
        <div key={e.eventId} className="stack" data-event={e.eventId}>
          <p>매출 <code>{e.eventId}</code> {e.type} <Money krw={e.amountKrw} /> · {e.integrity} · <Instant iso={e.occurredAt} />
            {e.run ? <> → run <code>{e.run.runId}</code> {e.run.status} {e.run.resultDigest && <Digest value={e.run.resultDigest} label={`result ${e.eventId}`} />}</> : <span className="badge muted"> 미정산</span>}
            {e.refunds.map((r) => <span key={r.eventId} className="badge warn"> 환불 {r.eventId} <Money krw={r.amountKrw} /></span>)}</p>
          {e.lines.length > 0 && <DataTable rows={e.lines} columns={[
            { key: "partyId", label: "파티" }, { key: "role", label: "역할" }, { key: "bucket", label: "버킷" }, { key: "kind", label: "종류" },
            { key: "amountKrw", label: "금액", render: (r) => <Money krw={r.amountKrw} /> },
          ]} />}
          {e.holdings.map((h, i) => <p key={i} className="badge warn">보류 {h.reason} {h.bucket} <Money krw={h.amountKrw} /></p>)}
        </div>
      ))}
      <DataTable rows={t.payouts} empty="지급 기록 없음" columns={[
        { key: "partyId", label: "파티" }, { key: "instructionId", label: "지급 지시", render: (r) => <Link to={`/payout/instructions/${encodeURIComponent(r.instructionId)}`}>{r.instructionId}</Link> },
        { key: "status", label: "상태" }, { key: "netKrw", label: "실지급", render: (r) => <Money krw={r.netKrw} /> },
      ]} />
    </div>
  );
}

/** ⑧ 한 건 추적: 조합·매출·파티 중 하나로 시작해 원곡부터 지급까지 잇는다. */
function Trace() {
  const [kind, setKind] = useState<"vc" | "event" | "party">("vc");
  const [id, setId] = useState("");
  const [data, setData] = useState<ComboTrace | PartyTrace | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const run = async () => {
    try { setData(await api<ComboTrace | PartyTrace>("GET", `/trace?${kind}=${encodeURIComponent(id.trim())}`)); setErr(null); }
    catch (e) { setErr(e as ApiError); setData(null); }
  };
  return (
    <Section title="한 건 추적">
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <select aria-label="추적 시작점" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="vc">조합 id</option><option value="event">매출 이벤트 id</option><option value="party">파티 id</option>
        </select>
        <input aria-label="추적할 id" value={id} onChange={(e) => setId(e.target.value)} placeholder="vc_… / ev_… / pty_…" />
        <button type="submit" className="btn primary" disabled={id.trim() === ""}>추적</button>
      </form>
      <ErrorPanel error={err} />
      {data && "issue" in data && <ComboView t={data} />}
      {data && "party" in data && (
        <div className="stack">
          <p>파티 <code>{data.party.partyId}</code> {data.party.displayName} · {data.party.partyType} · 테넌트 <code>{data.party.tenantId}</code></p>
          <DataTable rows={data.performedIn} empty="부른 조합 없음" columns={[{ key: "vcId", label: "부른 조합" }, { key: "issuedAt", label: "발행", render: (r) => <Instant iso={r.issuedAt} /> }]} />
          <DataTable rows={data.lines} empty="정산 라인 없음" columns={[{ key: "kind", label: "종류" }, { key: "role", label: "역할" }, { key: "count", label: "건수" }, { key: "amountKrw", label: "합계", render: (r) => <Money krw={r.amountKrw} /> }]} />
          <DataTable rows={data.payouts} empty="지급 없음" columns={[{ key: "instructionId", label: "지급 지시" }, { key: "status", label: "상태" }, { key: "netKrw", label: "실지급", render: (r) => <Money krw={r.netKrw} /> }]} />
        </div>
      )}
    </Section>
  );
}

/** ⑧ 영향 분석: 동의 철회·분쟁·주장 변경이 닿는 발행 조합, 보류할 미정산 매출, 역분개를 검토할 확정 라인. */
function ImpactView() {
  const [kind, setKind] = useState<"consent" | "dispute" | "claim">("consent");
  const [id, setId] = useState("");
  const [data, setData] = useState<Impact | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const run = async () => {
    try { setData(await api<Impact>("GET", `/impact?${kind}=${encodeURIComponent(id.trim())}`)); setErr(null); }
    catch (e) { setErr(e as ApiError); setData(null); }
  };
  return (
    <Section title="영향 분석">
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <select aria-label="영향 분석 대상" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="consent">동의(철회)</option><option value="dispute">분쟁</option><option value="claim">권리 주장</option>
        </select>
        <input aria-label="영향 분석 id" value={id} onChange={(e) => setId(e.target.value)} placeholder="cst_… / dsp_… / c_…" />
        <button type="submit" className="btn primary" disabled={id.trim() === ""}>분석</button>
      </form>
      <ErrorPanel error={err} />
      {data && (
        <div className="stack">
          <p>대상 {data.subject.kind} <code>{data.subject.id}</code> · 곡 범위 <code>{data.subject.factsScopeId}</code>{data.subject.partyId && <> · 파티 <code>{data.subject.partyId}</code></>}</p>
          <p>영향받는 발행 조합 {data.combinations.length}건: {data.combinations.map((c) => <code key={c.vcId} style={{ marginRight: 6 }}>{c.vcId}</code>)}</p>
          <p><span className="badge warn">보류</span> {data.hold.reason} — {data.hold.count}건 <Money krw={data.hold.amountKrw} /></p>
          <p><span className="badge bad">역분개 검토</span> {data.reverseReview.reason} — {data.reverseReview.count}건 <Money krw={data.reverseReview.amountKrw} /></p>
          <DataTable rows={data.reverseReview.byParty} empty="확정 라인 없음" columns={[{ key: "partyId", label: "파티" }, { key: "lines", label: "라인" }, { key: "amountKrw", label: "금액", render: (r) => <Money krw={r.amountKrw} /> }]} />
        </div>
      )}
    </Section>
  );
}

/** 운영 백오피스 홈: ⑧ 권리 파이프라인 관제(다음 작업 8). */
export function Pipeline() {
  return (<><Signals /><Trace /><ImpactView /></>);
}

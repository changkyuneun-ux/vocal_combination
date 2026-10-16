import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Money } from "../../components/Money.tsx";
import { Section } from "../../components/Section.tsx";

type Pool = {
  poolId: string; source: "SUBSCRIPTION" | "AD"; periodStart: string; periodEnd: string; amountKrw: string; status: "OPEN" | "ALLOCATED" | "NO_PLAYS";
  excluded?: Record<string, number>; allocations: { vcId: string; plays: number; amountKrw: string; eventId?: string }[];
};
const TONE = { OPEN: "warn", ALLOCATED: "ok", NO_PLAYS: "bad" } as const;

/** 감상 수익 풀(정산 담당): 기간의 구독·광고 수익을 조합별 유효 재생 비중으로 나눠 TRAFFIC 매출을 만든다. */
export function TrafficPools() {
  const q = useGet<Pool[]>(["traffic-pools"], "/traffic-pools");
  const [form, setForm] = useState({ poolId: "", source: "SUBSCRIPTION", periodStart: "", periodEnd: "", amountKrw: "" });
  const [err, setErr] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); } };
  return (
    <Section title="감상 수익 풀">
      <p className="muted">유효 재생은 30초 이상, 같은 사용자·조합의 하루 10회 초과 재생은 제외한다. 조합의 정책이 TRAFFIC을 받지 않으면 그 재생도 제외한다.
        배정은 한 번만 하며, 만든 TRAFFIC 매출은 같은 기간 정산 배치에 들어간다.</p>
      <div className="inline-form">
        <input aria-label="풀 id" placeholder="pool_…" value={form.poolId} onChange={(e) => setForm({ ...form, poolId: e.target.value })} />
        <select aria-label="수익 종류" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
          <option value="SUBSCRIPTION">구독</option><option value="AD">광고</option>
        </select>
        <input aria-label="기간 시작" placeholder="2026-03-01T00:00:00.000Z" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
        <input aria-label="기간 끝" placeholder="2026-04-01T00:00:00.000Z" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
        <input aria-label="금액(원)" placeholder="금액(원)" value={form.amountKrw} onChange={(e) => setForm({ ...form, amountKrw: e.target.value })} />
        <button type="button" className="btn" onClick={() => void act(() => api("POST", "/traffic-pools", form))}>등록</button>
      </div>
      <ErrorPanel error={q.error ?? err} />
      <DataTable rows={q.data ?? []} empty="등록된 풀이 없습니다." columns={[
        { key: "poolId", label: "풀" },
        { key: "source", label: "종류", render: (r) => (r.source === "AD" ? "광고" : "구독") },
        { key: "period", label: "기간", render: (r) => `${r.periodStart.slice(0, 10)} ~ ${r.periodEnd.slice(0, 10)}` },
        { key: "amount", label: "금액", render: (r) => <Money krw={r.amountKrw} /> },
        { key: "status", label: "상태", render: (r) => <span className={`badge ${TONE[r.status]}`}>{r.status}</span> },
        { key: "alloc", label: "배정(조합·재생·금액)", render: (r) => r.allocations.map((a) => <div key={a.vcId}><code>{a.vcId}</code> {a.plays}회 <Money krw={a.amountKrw} /></div>) },
        { key: "excluded", label: "제외 재생", render: (r) => (r.excluded ? Object.entries(r.excluded).map(([k, v]) => `${k} ${v}`).join(" · ") : "—") },
        { key: "act", label: "", render: (r) => (r.status === "OPEN" ? <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/traffic-pools/${encodeURIComponent(r.poolId)}/allocate`))}>배정</button> : null) },
      ]} />
    </Section>
  );
}

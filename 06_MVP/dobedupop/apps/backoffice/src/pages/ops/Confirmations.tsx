import { useState } from "react";
import { Link } from "react-router";
import { useClock } from "../../api/clock.ts";
import { useGet } from "../../api/hooks.ts";
import { usePaged } from "../../api/paged.ts";
import type { ConfirmationRow, WorkFacts } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useParties } from "../works/data.tsx";
import { slotPartRows } from "../works/model.ts";
import { B, CsvButton, Filters, Mono, OpsPage, Stats, Sub, TableCard, mmdd, useScopes } from "./common.tsx";

const STATUS: Record<string, [string, "ok" | "warn" | "bad" | "muted"]> = { OPEN: ["대기", "warn"], CONFIRMED: ["확인됨", "ok"], PLATFORM_VERIFIED: ["운영 대조 확인(지난 기록)", "ok"], DECLINED: ["거절", "bad"], SUPERSEDED: ["새 버전으로 대체", "muted"] };
const DAY = 86_400_000;

/** 확인 기록을 사람이 읽는 말로: 작가 지분 50% · David Stewart, 보이스 소유 · 정국, 실연 · Chorus 1 파트 2. */
export function useRecordText(scopeIds: string[]) {
  const ids = [...new Set(scopeIds)];
  const f0 = useGet<WorkFacts>(["work-facts", ids[0]], `/scopes/${encodeURIComponent(ids[0] ?? "")}/facts`, { enabled: !!ids[0] });
  const f1 = useGet<WorkFacts>(["work-facts", ids[1]], `/scopes/${encodeURIComponent(ids[1] ?? "")}/facts`, { enabled: !!ids[1] });
  const parties = useParties();
  const facts = [f0.data, f1.data].filter((x): x is WorkFacts => !!x);
  const name = (p: string) => parties.names.get(p) ?? p;
  return (recordId: string) => {
    for (const f of facts) {
      const c = f.claims.find((x) => x.claimId === recordId);
      if (c) {
        if (c.edge === "WRITTEN_BY") return `작가 지분 ${c.shareBps / 100}% · ${name(c.targetId)}`;
        if (c.edge === "OWNED_BY") return `보이스 소유 · ${name(c.targetId)}`;
        if (c.edge === "CONTROLLED_BY") return `녹음 권리 · ${name(c.targetId)}`;
        if (c.edge === "PERFORMED_BY") {
          const st = f.stems.find((s) => s.stemId === c.sourceId);
          const r = st && slotPartRows(f.slots).find((x) => x.slotId === st.slotId && x.partNo === st.partNo);
          return r ? `실연 · ${r.section} 파트 ${r.partNo}${st?.performerPartyId ? ` · ${name(st.performerPartyId)}` : ""}` : `실연 · ${c.sourceId}`;
        }
      }
      const m = f.mandates.find((x) => x.mandateId === recordId);
      if (m) return `수령 위임 · ${name(m.fromPartyId)} → ${name(m.toPartyId)}`;
    }
    return recordId;
  };
}

/** 운영 관리 › 확인·동의 › 확인 요청 전체(시안 Nav-Ops-Confirm): 모아 보고 곡 워크스페이스로 이동만 한다. */
export function OpsConfirmations() {
  const clock = useClock();
  const { by, options } = useScopes();
  const parties = useParties();
  const [scope, setScope] = useState(""), [kind, setKind] = useState(""), [status, setStatus] = useState("ALL");
  const p = usePaged<ConfirmationRow>("ops-confirmations", "/confirmations", { filters: { scope, counterparty: kind, status: status === "ALL" ? undefined : status } });
  const all = useGet<ConfirmationRow[]>(["work-confirmations"], "/confirmations");
  const text = useRecordText(p.rows.map((r) => r.factsScopeId));
  const now = clock.data?.now ?? new Date().toISOString();
  const rows = all.data ?? [];
  const open = rows.filter((r) => r.status === "OPEN");
  const soon = open.filter((r) => Date.parse(r.dueAt) - Date.parse(now) <= 3 * DAY);
  const month = now.slice(0, 7);
  const confirmed = rows.filter((r) => (r.status === "CONFIRMED" || r.status === "PLATFORM_VERIFIED") && (r.decidedAt ?? "").slice(0, 7) === month);
  const ptype = (id: string) => parties.items.find((x) => x.partyId === id)?.partyType;
  const who = (id: string) => (ptype(id) === "MEMBER" ? `${parties.names.get(id) ?? id}(실연자 앱)` : ptype(id) === "AUTHOR" ? "작가(전자서명 링크)" : parties.names.get(id) ?? id);
  return (
    <OpsPage title="확인 요청 전체" desc="빅히트 뮤직의 모든 곡에서 상대 당사자에게 보낸 확인 요청. 곡 하나의 확인은 작품 워크스페이스 › 확인·동의에서"
      actions={<CsvButton name="confirmations" head={["곡", "기록", "상대", "요청", "기한", "상태"]} rows={rows.map((r) => [by.get(r.factsScopeId)?.title ?? r.factsScopeId, r.recordId, r.counterpartyId, r.requestedAt, r.dueAt, r.status])} />}>
      <Stats items={[
        { label: "대기", value: open.length, note: `곡 ${new Set(open.map((r) => r.factsScopeId)).size}` },
        { label: "기한 3일 안", value: soon.length, note: "지나면 정합성 차단", warn: soon.length > 0 },
        { label: "확인됨(이번 달)", value: confirmed.length, note: `상대 ${new Set(confirmed.map((r) => r.counterpartyId)).size}` },
        { label: "거절·이의제기", value: rows.filter((r) => r.status === "DECLINED").length, note: "분쟁으로 이어짐" },
      ]} />
      <Filters placeholder="곡명, 기록, 상대 당사자" selects={[
        { name: "곡", value: scope, options, onChange: setScope },
        { name: "상대", value: kind, options: [["", "상대 전체"], ["MEMBER", "멤버(실연자 앱)"], ["AUTHOR", "작가(전자서명 링크)"]], onChange: setKind },
        { name: "상태", value: status, options: [["ALL", "전체"], ["OPEN", "대기"], ["CONFIRMED", "확인됨"], ["DECLINED", "거절"]], onChange: setStatus },
      ]} />
      <ErrorPanel error={p.error} />
      <TableCard label="확인 요청" cols={["곡", "기록", "확인할 상대", "요청", "기한", "상태", ""]} count={p.rows.length} empty="확인 요청이 없습니다."
        page={p.page} total={p.total} onPage={p.setPage} foot="멤버 확인은 실연자 앱에서 본인이, 계정 없는 작가는 빅히트가 보낸 전자서명 링크로 확인한다. 이 화면은 조회와 이동만 한다.">
        {p.rows.map((r) => {
          const w = by.get(r.factsScopeId);
          const soonDue = r.status === "OPEN" && Date.parse(r.dueAt) - Date.parse(now) <= 3 * DAY;
          const [t, tone] = STATUS[r.status] ?? [r.status, "muted"];
          return (
            <tr key={r.requestId}>
              <td><Sub main={w?.title ?? r.factsScopeId} /></td>
              <td>{text(r.recordId)}</td>
              <td>{who(r.counterpartyId)}</td>
              <td><Mono>{mmdd(r.requestedAt)}</Mono></td>
              <td><span className="p-mono" style={{ fontSize: 13, ...(soonDue ? { color: "var(--p-warn)", fontWeight: 600 } : { color: "var(--p-fg-2)" }) }}>{r.dueAt.slice(5, 10)}</span></td>
              <td><B tone={tone}>{t}</B></td>
              <td>{w && <Link to={`/works/${encodeURIComponent(w.workId)}/confirm`}>곡 워크스페이스 › 확인·동의 →</Link>}</td>
            </tr>
          );
        })}
      </TableCard>
    </OpsPage>
  );
}

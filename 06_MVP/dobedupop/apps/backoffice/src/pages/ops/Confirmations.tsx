import { useState } from "react";
import { Link } from "react-router";
import { useClock } from "../../api/clock.ts";
import { useGet } from "../../api/hooks.ts";
import { usePaged } from "../../api/paged.ts";
import type { ConfirmationRow, WorkFacts } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useParties } from "../works/data.tsx";
import { slotPartRows } from "../works/model.ts";
import { B, CsvButton, Filters, GroupDetail, GroupedTable, Mono, OpsPage, Stats, mmdd, useScopes, type WorkGroup } from "./common.tsx";

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
      const a = (f.partAssignments ?? []).find((x) => x.assignmentId === recordId);
      if (a) {
        const r = slotPartRows(f.slots).find((x) => x.slotId === a.slotId && x.partNo === a.partNo);
        return `원곡 파트 담당 · ${r ? `${r.section} 파트 ${r.partNo}` : `${a.slotId} 파트 ${a.partNo}`} · ${name(a.previousPartyId)} → ${name(a.partyId)}`;
      }
    }
    return recordId;
  };
}

/** 운영 관리 › 확인·동의 › 확인 요청 전체(시안 Nav-Ops-Confirm, 작품 묶음): 작품마다 요약 한 줄, 누르면 그 작품 요청만 펼친다. */
export function OpsConfirmations() {
  const clock = useClock();
  const { by } = useScopes();
  const parties = useParties();
  const [kind, setKind] = useState(""), [status, setStatus] = useState("ALL");
  const all = useGet<ConfirmationRow[]>(["work-confirmations"], "/confirmations");
  const now = clock.data?.now ?? new Date().toISOString();
  const rows = all.data ?? [];
  const open = rows.filter((r) => r.status === "OPEN");
  const soon = open.filter((r) => Date.parse(r.dueAt) - Date.parse(now) <= 3 * DAY);
  const month = now.slice(0, 7);
  const confirmed = rows.filter((r) => (r.status === "CONFIRMED" || r.status === "PLATFORM_VERIFIED") && (r.decidedAt ?? "").slice(0, 7) === month);
  const filters = { counterparty: kind || undefined, status: status === "ALL" ? undefined : status };
  return (
    <OpsPage title="확인 요청 전체" desc="빅히트 뮤직의 모든 곡에서 상대 당사자에게 보낸 확인 요청. 작품을 누르면 그 작품의 요청만 펼친다"
      actions={<CsvButton name="confirmations" head={["곡", "기록", "상대", "요청", "기한", "상태"]} rows={rows.map((r) => [by.get(r.factsScopeId)?.title ?? r.factsScopeId, r.recordId, r.counterpartyId, r.requestedAt, r.dueAt, r.status])} />}>
      <Stats items={[
        { label: "대기", value: open.length, note: `작품 ${new Set(open.map((r) => r.factsScopeId)).size}` },
        { label: "기한 3일 안", value: soon.length, note: "지나면 정합성 차단", warn: soon.length > 0 },
        { label: "확인됨(이번 달)", value: confirmed.length, note: ((ids) => `${ids.every((x) => parties.items.find((p) => p.partyId === x)?.partyType === "MEMBER") ? "멤버" : "상대"} ${ids.length}`)([...new Set(confirmed.map((r) => r.counterpartyId))]) },
        { label: "거절·이의제기", value: rows.filter((r) => r.status === "DECLINED").length, note: "분쟁으로 이어짐" },
      ]} />
      <Filters placeholder="곡명, 기록, 상대 당사자" selects={[
        { name: "상대", value: kind, options: [["", "상대 전체"], ["MEMBER", "멤버(실연자 앱)"], ["AUTHOR", "작가(전자서명 링크)"]], onChange: setKind },
        { name: "상태", value: status, options: [["ALL", "전체"], ["OPEN", "대기"], ["CONFIRMED", "확인됨"], ["DECLINED", "거절"]], onChange: setStatus },
      ]} />
      <ErrorPanel error={all.error} />
      <GroupedTable kind="confirmations" label="확인 요청" filters={filters} cols={["대기", "기한 3일 안", "확인됨", "상태"]}
        cells={(g) => [g.summary.open, <span key="s" style={g.summary.soon ? { color: "var(--p-warn)", fontWeight: 700 } : undefined}>{g.summary.soon}</span>, g.summary.confirmed, g.status && <B key="b" tone={g.status[1]}>{g.status[0]}</B>]}
        detail={(g) => <ConfirmDetail g={g} filters={filters} now={now} />}
        foot="멤버는 실연자 앱에서 본인이, 계정 없는 작가는 빅히트가 보낸 전자서명 링크로 확인한다. 작품을 누르면 그 작품 요청만 펼친다(한 번에 하나)." />
    </OpsPage>
  );
}

function ConfirmDetail({ g, filters, now }: { g: WorkGroup; filters: Record<string, string | undefined>; now: string }) {
  const parties = useParties();
  const p = usePaged<ConfirmationRow>(`ops-confirmations-${g.scopeId}`, "/confirmations", { filters: { ...filters, scope: g.scopeId ?? undefined } });
  const text = useRecordText(g.scopeId ? [g.scopeId] : []);
  const ptype = (id: string) => parties.items.find((x) => x.partyId === id)?.partyType;
  const who = (id: string) => (ptype(id) === "MEMBER" ? `${parties.names.get(id) ?? id}(실연자 앱)` : ptype(id) === "AUTHOR" ? "작가(전자서명 링크)" : parties.names.get(id) ?? id);
  return (
    <GroupDetail cols={["기록", "확인할 상대", "요청", "기한", "상태", ""]} count={p.rows.length} page={p.page} total={p.total} onPage={p.setPage}
      note={p.total > 0 ? `${g.title} ${p.total}건` : undefined} empty={p.isLoading ? "불러오는 중…" : "확인 요청이 없습니다."}>
      {p.rows.map((r) => {
        const soonDue = r.status === "OPEN" && Date.parse(r.dueAt) - Date.parse(now) <= 3 * DAY;
        const [t, tone] = STATUS[r.status] ?? [r.status, "muted"];
        return (
          <tr key={r.requestId}>
            <td>{text(r.recordId)}</td><td>{who(r.counterpartyId)}</td><td><Mono>{mmdd(r.requestedAt)}</Mono></td>
            <td><span className="p-mono" style={soonDue ? { color: "var(--p-warn)", fontWeight: 700 } : undefined}>{r.dueAt.slice(5, 10)}</span></td>
            <td><B tone={tone}>{t}</B></td>
            <td>{g.workId && <Link to={`/works/${encodeURIComponent(g.workId)}/confirm`}>확인·동의 탭 →</Link>}</td>
          </tr>
        );
      })}
    </GroupDetail>
  );
}

import { useState } from "react";
import { Link } from "react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useActor } from "../../app/actor.ts";
import { useClock } from "../../api/clock.ts";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { paginate, usePaged } from "../../api/paged.ts";
import { ROLE_LABEL, type AccountRow, type Me, type TenantDetail } from "../../api/admin.ts";
import type { IssueRow, Paged } from "../../api/types.ts";
import type { PartyRow } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { formatKrw } from "../../format.ts";
import { useParties, useWrite } from "../works/data.tsx";
import { Field, SidePanel } from "../works/tabs/Stems.tsx";
import { useRecordText } from "./Confirmations.tsx";
import { B, Card, Filters, GroupDetail, GroupedTable, Kv, Mono, Note, OpsPage, Stats, Sub, TableCard, useScopes, type WorkGroup } from "./common.tsx";

type Issue = { issueId: number; rule: string; severity: string; scopeId: string; subjectId: string; message: string; status: string; dueAt: string | null; checkedAt: string };
const RULES: [string, string[]][] = [
  ["지분 합계 100%", ["SHARE_SUM", "ENGINE"]], ["근거 문서", ["DOC_EVIDENCE_MISSING", "DOC_PARTY_MISMATCH", "DOC_DOCUMENT_REJECTED", "DOC_NEWER_VERSION", "DOC_PERIOD_EXPIRED", "DOC_PERIOD_EXPIRING"]],
  ["마스터 보유자 ↔ 녹음 권리 주장", ["MASTER_OWNER_CLAIM_MISMATCH"]], ["스템 실연자 ↔ 실연 주장", ["STEM_PERFORMER_CLAIM_MISMATCH"]],
  ["파트 원곡 스템 · 보이스 누락", ["PART_NO_ORIGINAL_STEM", "PART_ORIGINAL_NO_VOICE"]], ["확인 대기", ["DOC_CONFIRMATION_PENDING"]], ["멤버 이용 동의", ["DOC_CONSENT_MISSING", "DOC_CONSENT_EXPIRING"]],
];
const OTHER_RULES: Record<string, string> = { DOC_PAYOUT_PROFILE_MISSING: "지급 정보", DOC_PLATFORM_CONTRACT_MISSING: "플랫폼 계약", TRUST_NOT_ROUTED: "신탁 수령 위임", DOC_AI_CONSENT_MISSING: "AI 보이스 동의" };
const ruleName = (code: string) => RULES.find(([, cs]) => cs.some((c) => code.startsWith(c)))?.[0] ?? OTHER_RULES[code] ?? code;

/** 운영 관리 › 점검 › 정합성 점검 전체(시안 Ops-Validation, 작품 묶음): 작품마다 요약 한 줄, 펼치면 걸린 항목과 규칙별 결과. */
export function OpsValidation() {
  const qc = useQueryClient();
  const { by, works } = useScopes();
  const [sev, setSev] = useState("ALL");
  const all = useGet<Issue[]>(["readiness", "validation-all"], "/validation-issues?status=OPEN");
  const open = all.data ?? [];
  const blocks = open.filter((i) => i.severity === "BLOCK"), warns = open.filter((i) => i.severity === "WARN");
  const scopes = works.filter((w) => w.scopeId);
  const hitRules = (s: string | null) => RULES.filter(([, cs]) => open.some((i) => i.scopeId === s && cs.some((c) => i.rule.startsWith(c)))).length;
  const passedWorks = scopes.filter((w) => hitRules(w.scopeId!) === 0);
  const last = open.map((i) => i.checkedAt).sort().at(-1);
  // 다시 점검: 곡마다 점검을 다시 돌린다(GET /scopes/:id/validation이 재검사한다).
  const recheck = () => void Promise.all(scopes.map((w) => api("GET", `/scopes/${encodeURIComponent(w.scopeId!)}/validation`))).then(() => qc.invalidateQueries());
  const due = warns.map((i) => i.dueAt).filter(Boolean).sort()[0];
  const severity = sev === "ALL" ? undefined : sev === "WARN+" ? "BLOCK,WARN" : sev;
  return (
    <OpsPage title="정합성 점검 전체" desc="작품마다 정합성 점검 결과. 차단이 있으면 그 곡의 분배 규칙을 활성화하지 못한다. 작품을 누르면 걸린 항목을 펼친다"
      actions={<button type="button" className="p-btn" onClick={recheck}>다시 점검</button>}>
      <Stats items={[
        { label: "차단", value: blocks.length, note: "" },
        { label: "경고", value: warns.length, note: `${[...new Set(warns.map((i) => by.get(i.scopeId)?.title ?? i.scopeId))].map((t) => `${t} ${warns.filter((i) => (by.get(i.scopeId)?.title ?? i.scopeId) === t).length}`).join(" · ")}${due ? ` · 기한 ${due.slice(5, 10)}` : ""}`, warn: warns.length > 0 },
        { label: "통과 작품", value: `${passedWorks.length} / ${scopes.length}`, note: passedWorks.map((w) => w.title).join(" · ") },
        { label: "마지막 점검", value: last ? last.slice(11, 16) : "—", note: last?.slice(0, 10) ?? "" },
      ]} />
      <Filters placeholder="곡명, 규칙" selects={[
        { name: "수준", value: sev, options: [["ALL", "전체"], ["WARN+", "경고 이상"], ["BLOCK", "차단"]], onChange: setSev },
      ]} />
      <ErrorPanel error={all.error} />
      <GroupedTable kind="validation" label="정합성 점검" filters={{ severity }} cols={["차단", "경고", "통과 규칙", "상태"]}
        cells={(g) => [g.summary.block, <span key="w" style={g.summary.warn ? { color: "var(--p-warn)", fontWeight: 700 } : undefined}>{g.summary.warn}</span>,
          `${RULES.length - RULES.filter(([, cs]) => (g.rules ?? []).some((r) => cs.some((c) => r.startsWith(c)))).length} / ${RULES.length}`, g.status && <B key="b" tone={g.status[1]}>{g.status[0]}</B>]}
        detail={(g) => <ValidationDetail g={g} severity={severity} open={open} />}
        foot="수준 '전체'가 처음 값이다. 작품을 누르면 그 작품의 걸린 항목과 규칙별 결과를 펼친다." />
    </OpsPage>
  );
}

/** 펼친 작품: 걸린 항목(10행 쪽 나눔) + 규칙별 결과(그 작품 안으로 옮김, 2026-10-24). */
function ValidationDetail({ g, severity, open }: { g: WorkGroup; severity: string | undefined; open: Issue[] }) {
  const parties = useParties();
  const p = usePaged<Issue>(`ops-validation-${g.scopeId}`, "/validation-issues", { filters: { scope: g.scopeId ?? undefined, status: "OPEN", severity } });
  const text = useRecordText(g.scopeId ? [g.scopeId] : []);
  const subject = (id: string) => (id.startsWith("CLAIM:") || id.startsWith("MANDATE:") || id.startsWith("PART:") ? text(id.split(":")[1]!.split("@")[0]!) : parties.names.get(id) ?? id);
  const cell = (codes: string[]) => {
    const hit = open.filter((i) => i.scopeId === g.scopeId && codes.some((c) => i.rule.startsWith(c)));
    if (hit.length === 0) return <span className="p-ok" style={{ fontWeight: 600 }}>✓ 통과</span>;
    const b = hit.filter((i) => i.severity === "BLOCK").length;
    return <span style={{ color: b ? "var(--p-bad)" : "var(--p-warn)", fontWeight: 600 }}>{b ? `✕ 차단 ${b}` : `! 경고 ${hit.length}`}</span>;
  };
  const passed = RULES.filter(([, cs]) => !open.some((i) => i.scopeId === g.scopeId && cs.some((c) => i.rule.startsWith(c)))).map(([n]) => n);
  return (
    <>
      <GroupDetail cols={["규칙", "수준", "대상", "내용", ""]} count={p.rows.length} page={p.page} total={p.total} onPage={p.setPage}
        note={`통과: ${passed.join(" · ") || "없음"}`} empty={p.isLoading ? "불러오는 중…" : `걸린 항목이 없습니다. 규칙 ${RULES.length}개 모두 통과.`}>
        {p.rows.map((i) => (
          <tr key={i.issueId}>
            <td>{ruleName(i.rule)}</td><td><B tone={i.severity === "BLOCK" ? "bad" : "warn"}>{i.severity === "BLOCK" ? "차단" : "경고"}</B></td>
            <td>{subject(i.subjectId)}</td><td>{i.rule === "DOC_CONFIRMATION_PENDING" && subject(i.subjectId).startsWith("작가 지분") ? "작가 서명 대기" : i.message}{i.dueAt ? ` · 기한 ${i.dueAt.slice(5, 10)} 지나면 차단` : ""}</td>
            <td>{g.workId && <Link to={`/works/${encodeURIComponent(g.workId)}/${i.rule === "DOC_CONFIRMATION_PENDING" ? "confirm" : "policy"}`}>{i.rule === "DOC_CONFIRMATION_PENDING" ? "확인·동의" : "분배 규칙·팩"} 탭 →</Link>}</td>
          </tr>
        ))}
      </GroupDetail>
      <div style={{ borderTop: "1px solid var(--p-line)" }}>
        <GroupDetail cols={["규칙별 결과", "결과"]} count={RULES.length} paged={false}>
          {RULES.map(([n, cs]) => <tr key={n}><td>{n}</td><td>{cell(cs)}</td></tr>)}
        </GroupDetail>
      </div>
    </>
  );
}

type Statement = { partyId: string; from: string; to: string; settled: string; payoutNet: string; payoutGross: string; withholding: string };
const TYPE_ORDER = ["LABEL", "AGENCY", "AUTHOR"];
/** 운영 관리 › 정산 › 명세·지급(시안 Ops-Statements). */
export function OpsStatements() {
  const clock = useClock();
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const now = clock.data?.now ?? new Date().toISOString();
  const [period, setPeriod] = useState("all");
  const from = period === "all" ? "2026-01-01T00:00:00.000Z" : `${period}-01T00:00:00.000Z`;
  const to = period === "all" ? now : new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1)).toISOString();
  // 받는 당사자: 빅히트가 관리하는 당사자 전부 — 레이블·소속사와 작가(결정 WD4, 시안 Ops-Statements 작가 2행).
  const parties = [...(mine.data ?? [])].sort((a, b) => TYPE_ORDER.indexOf(a.partyType) - TYPE_ORDER.indexOf(b.partyType));
  const actor = useActor();
  const stq = useQueries({ queries: parties.map((x) => ({ queryKey: ["stmt", x.partyId, from, to, actor],
    queryFn: () => api<Statement>("GET", `/parties/${encodeURIComponent(x.partyId)}/statements?from=${from}&to=${to}`, undefined, { actorOverride: actor }) })) });
  const sts = stq.flatMap((q) => (q.data ? [q.data] : []));
  const stErr = (stq.find((q) => q.error)?.error ?? null) as ApiError | null;
  // 작가의 작품 몫(시안 "작품 몫 50%"): 보이는 곡의 작가 지분.
  const { works } = useScopes();
  const facts = useGet<{ claims: { edge: string; targetId: string; shareBps: number; supersededAt: string | null }[] }>(["work-facts", works[0]?.scopeId], `/scopes/${encodeURIComponent(works[0]?.scopeId ?? "")}/facts`, { enabled: !!works[0]?.scopeId });
  const workShare = (party: string) => (facts.data?.claims ?? []).filter((c) => c.edge === "WRITTEN_BY" && c.targetId === party && c.supersededAt === null).reduce((a, c) => a + c.shareBps, 0);
  const issues = useGet<Paged<IssueRow>>(["work-issues", "all"], "/issues?limit=200");
  const [page, setPage] = useState(1), [page2, setPage2] = useState(1), [paidF, setPaidF] = useState("");
  const isPaid = (id: string) => { const s = sts.find((y) => y.partyId === id); return s !== undefined && BigInt(s.payoutNet) > 0n; };
  const rows = paginate(paidF === "" ? parties : parties.filter((x) => isPaid(x.partyId) === (paidF === "PAID")), page);
  const vcs = paginate(issues.data?.items ?? [], page2);
  const sum = sts.reduce((a, s) => a + BigInt(s.payoutNet), 0n).toString();
  const role = (x: PartyRow) => (x.partyType === "LABEL" ? "녹음 몫" : x.partyType === "AGENCY" ? "실연 몫(멤버 수령 위임)" : x.partyType === "AUTHOR" ? `작품 몫 ${workShare(x.partyId) / 100}%` : "권리 몫");
  // 시안: "원천징수 작가 각 83,650원, 합계 167,300원"(작가마다 같으면 "각", 다르면 합계만).
  const authorWht = () => {
    const w = sts.filter((x) => parties.find((y) => y.partyId === x.partyId)?.partyType === "AUTHOR").map((x) => Number(x.withholding));
    const sum = w.reduce((a, x) => a + x, 0).toLocaleString();
    return w.length > 1 && w.every((x) => x === w[0]) ? `원천징수 작가 각 ${w[0]!.toLocaleString()}원, 합계 ${sum}원` : `원천징수 합계 ${sum}원`;
  };
  const kinds = [["LABEL", "레이블"], ["AGENCY", "소속사"], ["AUTHOR", "작가"]].map(([t, l]) => [l, parties.filter((x) => x.partyType === t).length] as const).filter(([, n]) => n > 0);
  const months = Array.from({ length: Number(now.slice(5, 7)) }, (_, i) => `${now.slice(0, 4)}-${String(i + 1).padStart(2, "0")}`).reverse();
  return (
    <OpsPage title="명세·지급" desc="빅히트 뮤직 당사자가 받는 정산 명세와 지급. 금액은 플랫폼이 확정한 정산 배치에서 온다"
      actions={<button type="button" className="p-btn wide" disabled title="명세 PDF 내려받기는 다음 단계">명세 내려받기(PDF)</button>}>
      <Stats items={[
        { label: "이번 지급", value: formatKrw(sum), note: period === "all" ? "누적" : period },
        { label: "받는 당사자", value: parties.length, note: kinds.map(([l, n]) => (l === "작가" ? `${l} ${n}` : l)).join(" · ") },
        { label: "정산 기간", value: period === "all" ? "전체" : `${period.slice(0, 4)}년 ${Number(period.slice(5))}월`, note: `${from.slice(0, 10)} ~ ${to.slice(0, 10)}` },
        { label: "보류", value: "—", note: "보류 내역은 운영 화면에서" },
      ]} />
      <Filters placeholder="당사자" selects={[
        { name: "기간", value: period, options: [["all", "기간 전체"], ...months.map((m): [string, string] => [m, `${m.slice(0, 4)}년 ${Number(m.slice(5))}월`])], onChange: (v) => { setPeriod(v); setPage(1); } },
        { name: "상태", value: paidF, options: [["", "전체"], ["PAID", "PAID"], ["WAIT", "대기"]], onChange: (v) => { setPaidF(v); setPage(1); } },
      ]} />
      <ErrorPanel error={stErr} />
      <TableCard label="명세" cols={["받는 당사자", "역할", "정산 기간", "지급(원)", "계좌", "상태", ""]} count={rows.rows.length} empty="받는 당사자가 없습니다."
        page={page} total={rows.total} onPage={setPage} foot={`작가는 빅히트가 관리하는 당사자다. 작가 지급액은 원천징수 뒤 금액(${authorWht()}). 계좌·세금 정보는 빅히트가 등록하고 플랫폼은 지급만 실행한다. 멤버별 기여분은 실연자 앱에서 본인이 본다.`}>
        {rows.rows.map((x) => {
          const s = sts.find((y) => y.partyId === x.partyId);
          const paid = isPaid(x.partyId);
          return (
            <tr key={x.partyId}>
              <td>{x.partyType === "AUTHOR" ? <Sub main={`${x.displayName}(작가)`} small={s && Number(s.withholding) > 0 ? `${Number(s.withholding) / Number(s.payoutGross) >= 0.2 ? "해외 · " : ""}원천징수` : undefined} /> : x.displayName}</td><td>{role(x)}</td><td>{period === "all" ? "전체" : period}</td><td><Mono>{s ? Number(s.payoutNet).toLocaleString() : "—"}</Mono></td>
              <td><span title="계좌는 끝 4자리만 운영 화면에서 보인다">—</span></td><td><B tone={paid ? "ok" : "muted"}>{paid ? "PAID" : "대기"}</B></td>
              <td><Link to="/statements">명세 보기</Link></td>
            </tr>
          );
        })}
      </TableCard>
      <Card title="조합별 매출(이번 정산)" hint="조합별 구매·매출은 포털 조회가 없다 — 합계는 위 명세">
        <TableCard cols={["조합", "구매", "매출(원)"]} count={vcs.rows.length} minW={600} empty="발행된 조합이 없습니다." page={page2} total={vcs.total} onPage={setPage2} label="조합별 매출">
          {vcs.rows.map((r) => <tr key={r.snapshotId}><td><Mono>{r.vcId}</Mono></td><td>—</td><td>—</td></tr>)}
        </TableCard>
      </Card>
    </OpsPage>
  );
}

const CHECK_LABEL: Record<string, string> = { BUSINESS_ID: "사업자 확인", REPRESENTATIVE: "대표자", PLATFORM_AGREEMENT: "플랫폼 이용 계약", RIGHTS_EVIDENCE: "권리 보유 증빙" };
const STATUS_KO: Record<string, string> = { APPLIED: "신청", VERIFIED: "확인됨", ACTIVE: "활성", SUSPENDED: "정지", TERMINATED: "해지" };

/** 우리 당사자 한 줄(GET /my/parties): 국가·구분·연락 이메일, 지급 정보 유무, 쓰인 곳(곡마다 권리)과 받은 수령 위임 수. */
export type OrgParty = PartyRow & { countryClass?: string | null; contactEmail?: string | null; hasPayoutProfile?: boolean; uses?: { title: string; edge: string; shareBps: number | null }[]; mandates?: number };
/** 시안 link(): 굵기 600, 밑줄 없음. */
const LINK = { fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" } as const;
const PARTY_TYPE_KO: Record<string, string> = { LABEL: "레이블", AGENCY: "소속사", AUTHOR: "작가", MEMBER: "멤버(아티스트)" };
const COUNTRY_KO: Record<string, string> = { FOREIGN_INDIVIDUAL: "해외 개인", DOMESTIC_INDIVIDUAL: "국내 개인", DOMESTIC_CORP: "국내 법인" };
const TAX_OF_COUNTRY: Record<string, string> = { FOREIGN_INDIVIDUAL: "FOREIGN", DOMESTIC_INDIVIDUAL: "DOMESTIC_INDIVIDUAL", DOMESTIC_CORP: "DOMESTIC_CORP" };
const pctOf = (bps: number | null) => `${Number(((bps ?? 0) / 100).toFixed(2))}%`;
/** 표의 쓰인 곳: 곡 이름들, 곡 권리가 없고 수령 위임만 있으면 "멤버 n 수령 위임". */
export const usedIn = (p: OrgParty): string => {
  const titles = [...new Set((p.uses ?? []).map((u) => u.title))];
  if (titles.length > 0) return titles.join(" · ");
  return p.mandates ? `멤버 ${p.mandates} 수령 위임` : "—";
};
/** 상세의 쓰인 곳: "Butter · 작가 지분 14.28%". */
const usedInDetail = (p: OrgParty): string => {
  const parts = (p.uses ?? []).map((u) => `${u.title} · ${u.edge === "WRITTEN_BY" ? `작가 지분 ${pctOf(u.shareBps)}` : u.edge === "CONTROLLED_BY" ? `마스터 보유 ${pctOf(u.shareBps)}` : "실연"}`);
  if (p.mandates) parts.push(`멤버 ${p.mandates} 수령 위임`);
  return parts.length ? [...new Set(parts)].join(", ") : "—";
};
/** 당사자 id: 표시 이름의 영문·숫자로(pty_jenna_andrews), 못 만들면 시각으로. */
function partyIdFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || Date.now().toString(36);
  let id = `pty_${base}`;
  for (let k = 2; taken.has(id); k++) id = `pty_${base}_${k}`;
  return id;
}
/** 지급 계좌는 끝 4자만 보관한다(시안 "은행 · 계좌번호(끝 4자만 보관)"): "국민 123-45-6789" → "국민 ****6789". */
export function accountRefOf(input: string): string {
  const digits = input.replace(/\D/g, "");
  const bank = input.replace(/[\d\s·\-*]+$/, "").replace(/[·\s]+$/, "").trim();
  return `${bank || "계좌"} ****${digits.slice(-4)}`;
}

/** 운영 관리 › 조직 › 내 조직(시안 Ops-Org-Parties · Ops-Org): 우리 당사자 등록·지급 정보, 조직 정보, 확인 항목. */
export function OpsOrg() {
  const me = useGet<Me>(["me"], "/me");
  const t = useGet<TenantDetail>(["tenant", me.data?.tenantId], `/tenants/${me.data?.tenantId ?? ""}`, { enabled: me.data !== undefined && me.data.scope !== "platform" });
  const mine = useGet<OrgParty[]>(["parties", "mine"], "/my/parties");
  const known = useParties(); // 새 당사자 id가 보이는 다른 당사자(멤버 등)와 겹치지 않게
  const [page, setPage] = useState(1);
  // 오른쪽 칸은 한 번에 하나: 등록(add) 또는 고른 당사자 상세. 같은 것을 다시 누르면 닫는다.
  const [panel, setPanel] = useState<{ kind: "add" } | { kind: "detail"; partyId: string } | null>(null);
  const d = t.data;
  // 시안 순서: 레이블 → 소속사 → 작가 → 멤버, 같은 유형은 등록 이름순.
  const ORDER = ["LABEL", "AGENCY", "AUTHOR", "MEMBER"];
  const all = [...(mine.data ?? [])].sort((a, b) => (ORDER.indexOf(a.partyType) - ORDER.indexOf(b.partyType)) || a.displayName.localeCompare(b.displayName, "ko"));
  const parties = paginate(all, page);
  const selected = panel?.kind === "detail" ? all.find((p) => p.partyId === panel.partyId) : undefined;
  const toggleAdd = () => setPanel((p) => (p?.kind === "add" ? null : { kind: "add" }));
  const toggleRow = (id: string) => setPanel((p) => (p?.kind === "detail" && p.partyId === id ? null : { kind: "detail", partyId: id }));
  return (
    <OpsPage title={d?.name ?? "내 조직"} desc={`권리 테넌트 · ${d?.tenantType === "LABEL" ? "레이블" : d?.tenantType ?? ""} · ${d?.tenantId ?? ""} — 우리 당사자를 등록하고 지급 정보를 관리한다`}
      actions={d && <B tone={d.status === "ACTIVE" ? "ok" : "warn"}>{STATUS_KO[d.status] ?? d.status}{d.statusChangedAt ? ` · ${d.statusChangedAt.slice(5, 10)}` : ""}</B>}>
      <ErrorPanel error={t.error ?? mine.error} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 640px", minWidth: 0 }}>
          <TableCard title={["우리 당사자", <>{all.length}명 · <a href="#" role="button" style={LINK} onClick={(e) => { e.preventDefault(); toggleAdd(); }}>+ 당사자 등록</a></>]}
            cols={["당사자", "유형", "쓰인 곳", "상태", ""]} count={parties.rows.length} minW={760} page={page} total={parties.total} onPage={setPage} empty="당사자가 없습니다." label="우리 당사자"
            foot="작가·레이블·소속사·멤버 모두 빅히트가 관리하는 당사자다. 행을 누르면 오른쪽에 상세(지급 정보)가 열린다.">
            {parties.rows.map((x) => (
              <tr key={x.partyId} onClick={() => toggleRow(x.partyId)} aria-selected={selected?.partyId === x.partyId} style={{ cursor: "pointer" }}>
                <td><strong>{x.displayName}</strong></td><td><B>{(PARTY_TYPE_KO[x.partyType] ?? x.partyType).replace("(아티스트)", "")}</B></td><td>{usedIn(x)}</td>
                <td>{x.hasPayoutProfile ? <B tone="ok">등록됨</B> : <B tone="warn">지급 정보 없음</B>}</td>
                <td><a href="#" style={LINK} onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleRow(x.partyId); }}>상세</a></td>
              </tr>
            ))}
          </TableCard>
        </div>
        {panel?.kind === "add" && <PartyAddPanel taken={new Set([...all, ...known.items].map((p) => p.partyId))} onClose={() => setPanel(null)} onDone={(id) => setPanel({ kind: "detail", partyId: id })} />}
        {selected && <PartyPayPanel key={selected.partyId} party={selected} onClose={() => setPanel(null)} />}
      </div>
      <Card title="조직 정보">
        <Kv pairs={[["이름", d?.name ?? "—"], ["구분", `권리 테넌트 · ${d?.tenantType === "LABEL" ? "레이블" : d?.tenantType ?? ""}`], ["사업자 번호", <Mono key="b">{d?.businessNo ?? "—"}</Mono>], ["국가", d?.country ?? "—"],
          ["상태", STATUS_KO[d?.status ?? ""] ?? d?.status ?? "—"], ["플랫폼 이용계약", d?.checks.some((c) => c.item === "PLATFORM_AGREEMENT") ? "확인됨" : "확인 전"]]} />
      </Card>
      <Card title="확인 항목(KYB)" hint="플랫폼이 확인한다. 빅히트는 조회만">
        <TableCard cols={["항목", "근거", "상태"]} count={4} paged={false} minW={600} label="확인 항목">
          {["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT", "RIGHTS_EVIDENCE"].map((k) => {
            const c = d?.checks.find((x) => x.item === k);
            return <tr key={k}><td>{CHECK_LABEL[k]}</td><td>{c?.note ?? c?.documentId ?? "—"}</td><td><B tone={c ? "ok" : "muted"}>{c ? "확인됨" : "확인 전"}</B></td></tr>;
          })}
        </TableCard>
      </Card>
    </OpsPage>
  );
}

/** 오른쪽 칸 · 우리 당사자 등록(시안 party_add): 빅히트가 관리하는 당사자로 등록한다(POST /parties, 테넌트는 로그인한 조직). */
function PartyAddPanel({ taken, onClose, onDone }: { taken: Set<string>; onClose: () => void; onDone: (partyId: string) => void }) {
  const w = useWrite();
  const [type, setType] = useState("AUTHOR"), [name, setName] = useState(""), [country, setCountry] = useState("FOREIGN_INDIVIDUAL"), [email, setEmail] = useState("");
  const add = () => {
    const partyId = partyIdFor(name.trim(), taken);
    void w.run(() => api("POST", "/parties", { partyId, partyType: type, displayName: name.trim(), countryClass: country, ...(email.trim() && { contactEmail: email.trim() }) }), `${name.trim()} 등록`)
      .then((ok) => { if (ok) onDone(partyId); });
  };
  return (
    <SidePanel label="우리 당사자 등록" kicker="우리 당사자 등록" title="새 당사자" onClose={onClose}
      actions={<><button type="button" className="p-btn" onClick={onClose}>취소</button><button type="button" className="p-btn primary" disabled={w.busy || name.trim() === ""} onClick={add}>등록</button></>}>
      <Field label="유형" hint="작가·멤버도 빅히트가 관리하는 당사자로 등록한다">
        <select className="p-select" aria-label="유형" value={type} onChange={(e) => setType(e.target.value)}>
          {["AUTHOR", "LABEL", "AGENCY", "MEMBER"].map((k) => <option key={k} value={k}>{PARTY_TYPE_KO[k]}</option>)}
        </select>
      </Field>
      <Field label="표시 이름"><input className="p-input" aria-label="표시 이름" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="국가 · 구분" hint="세금(원천징수) 계산에 쓰인다">
        <select className="p-select" aria-label="국가 · 구분" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="FOREIGN_INDIVIDUAL">해외 · 개인</option><option value="DOMESTIC_INDIVIDUAL">국내 · 개인</option><option value="DOMESTIC_CORP">국내 · 법인</option>
        </select>
      </Field>
      <Field label="연락 이메일(전자서명 링크)" hint="계정이 없는 당사자는 이 주소로 서명 링크를 받는다">
        <input className="p-input" type="email" aria-label="연락 이메일(전자서명 링크)" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <ErrorPanel error={w.err} />
    </SidePanel>
  );
}

/** 오른쪽 칸 · 당사자 상세 · 지급 정보(시안 pay_panel): 계좌(끝 4자만 보관)·세금을 저장한다(PUT /parties/:id/payout-profile, 결정 WD4). */
function PartyPayPanel({ party, onClose }: { party: OrgParty; onClose: () => void }) {
  const w = useWrite();
  const [account, setAccount] = useState("");
  const [tax, setTax] = useState(TAX_OF_COUNTRY[party.countryClass ?? ""] ?? (party.partyType === "AUTHOR" ? "FOREIGN" : "DOMESTIC_CORP"));
  const typeText = `${(PARTY_TYPE_KO[party.partyType] ?? party.partyType).replace("(아티스트)", "")}${party.countryClass ? ` · ${COUNTRY_KO[party.countryClass]}` : ""}`;
  const save = () => void w.run(() => api("PUT", `/parties/${encodeURIComponent(party.partyId)}/payout-profile`, { taxType: tax, payoutAccountRef: accountRefOf(account), kycVerified: true }), "지급 정보 저장")
    .then((ok) => { if (ok) setAccount(""); });
  return (
    <SidePanel label="당사자 상세 · 지급 정보" kicker="당사자 상세 · 지급 정보" title={party.displayName} onClose={onClose}
      actions={<><button type="button" className="p-btn" onClick={onClose}>취소</button><button type="button" className="p-btn primary" disabled={w.busy || account.replace(/\D/g, "").length < 4} onClick={save}>저장</button></>}>
      <Kv pairs={[["유형", typeText], ["쓰인 곳", usedInDetail(party)], ["서명 링크", party.contactEmail ?? "—"]]} />
      <Field label="지급 계좌"><input className="p-input" aria-label="지급 계좌" placeholder="은행 · 계좌번호(끝 4자만 보관)" value={account} onChange={(e) => setAccount(e.target.value)} /></Field>
      <Field label="세금">
        <select className="p-select" aria-label="세금" value={tax} onChange={(e) => setTax(e.target.value)}>
          <option value="FOREIGN">해외 · 원천징수</option><option value="DOMESTIC_INDIVIDUAL">국내 · 원천징수</option><option value="DOMESTIC_CORP">사업자</option>
        </select>
      </Field>
      <Note tone="warn">지급 정보는 빅히트가 등록하고, 플랫폼은 지급만 실행한다(WD4). 없으면 정합성 경고가 남는다.</Note>
      <ErrorPanel error={w.err} />
    </SidePanel>
  );
}

/** 운영 관리 › 조직 › 담당자 계정(시안 Ops-Accounts). */
export function OpsAccounts() {
  const p = usePaged<AccountRow & { homeMembership?: boolean }>("ops-users", "/users");
  return (
    <OpsPage title="담당자 계정" desc="빅히트 뮤직 소속으로 일하는 계정과 역할" actions={<button type="button" className="p-btn wide" disabled title="상용 단계">담당자 초대 — 상용 단계</button>}>
      <ErrorPanel error={p.error} />
      <TableCard label="담당자 계정" cols={["계정", "역할", "할 수 있는 일", "소속 시작", "상태"]} count={p.rows.length} minW={860} empty="계정이 없습니다." page={p.page} total={p.total} onPage={p.setPage}
        foot="MVP는 총괄 한 사람이 전부 처리한다(RD1). 직무 분리는 꺼져 있다(RD6). 역할은 기능 → 권한 → 역할 데이터로 되어 있어, 나중에 역할을 나눠 담당자를 초대할 수 있다(테넌트 자체 역할은 상용 단계, RD8).">
        {p.rows.map((u) => (
          <tr key={u.userId}>
            <td><Sub main={`${u.displayName} · ${u.userId}`} small={u.homeMembership === false ? "다른 소속도 가짐" : undefined} /></td>
            <td><Mono>{u.roles.join(", ")}</Mono></td><td>{u.roles.map((r) => ROLE_LABEL[r] ?? r).join(" · ")}</td><td><Mono>{u.lastLoginAt?.slice(5, 10) ?? "—"}</Mono></td>
            <td><B tone={u.disabled ? "muted" : "ok"}>{u.disabled ? "잠김" : "소속됨"}</B></td>
          </tr>
        ))}
      </TableCard>
      <Note>멤버(실연자)는 이 목록에 없다. 멤버는 실연자 앱에서 본인 계정으로 확인·동의한다.</Note>
    </OpsPage>
  );
}

/** 운영 관리 › 조직 › 위임 대행(시안 Ops-Delegation, MVP 빈 화면). */
export function OpsDelegation() {
  return (
    <OpsPage title="위임 대행" desc="다른 조직이 빅히트 뮤직을 대신해 업무를 하도록 맡긴 것">
      <TableCard label="위임 대행" cols={["대행 조직", "맡긴 업무", "열리는 권한", "기간", "상태"]} count={0} minW={860} empty="맡긴 업무가 없습니다. MVP에서는 쓰지 않는 메뉴입니다.">{null}</TableCard>
    </OpsPage>
  );
}

/** 운영 관리 › 조직 › 신탁·유통 연결(시안 Ops-Links, MVP 빈 화면). */
export function OpsLinks() {
  return (
    <OpsPage title="신탁·유통 연결" desc="참여 기관(신탁단체·유통 파트너)과 양쪽이 확인한 연결">
      <TableCard label="신탁·유통 연결" cols={["상대 기관", "구분", "대상", "기간", "상태"]} count={0} minW={860} empty="연결이 없습니다. MVP에서는 쓰지 않는 메뉴입니다.">{null}</TableCard>
    </OpsPage>
  );
}

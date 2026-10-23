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
import { useParties } from "../works/data.tsx";
import { useRecordText } from "./Confirmations.tsx";
import { B, Card, Filters, Kv, Mono, Note, OpsPage, Stats, Sub, TableCard, useScopes } from "./common.tsx";

type Issue = { issueId: number; rule: string; severity: string; scopeId: string; subjectId: string; message: string; status: string; dueAt: string | null; checkedAt: string };
const RULES: [string, string[]][] = [
  ["지분 합계 100%", ["SHARE_SUM", "ENGINE"]], ["근거 문서", ["DOC_EVIDENCE_MISSING", "DOC_PARTY_MISMATCH", "DOC_DOCUMENT_REJECTED", "DOC_NEWER_VERSION", "DOC_PERIOD_EXPIRED", "DOC_PERIOD_EXPIRING"]],
  ["마스터 보유자 ↔ 녹음 권리 주장", ["MASTER_OWNER_CLAIM_MISMATCH"]], ["스템 실연자 ↔ 실연 주장", ["STEM_PERFORMER_CLAIM_MISMATCH"]],
  ["파트 원곡 스템 · 보이스 누락", ["PART_NO_ORIGINAL_STEM", "PART_ORIGINAL_NO_VOICE"]], ["확인 대기", ["DOC_CONFIRMATION_PENDING"]], ["멤버 이용 동의", ["DOC_CONSENT_MISSING", "DOC_CONSENT_EXPIRING"]],
];
const OTHER_RULES: Record<string, string> = { DOC_PAYOUT_PROFILE_MISSING: "지급 정보", DOC_PLATFORM_CONTRACT_MISSING: "플랫폼 계약", TRUST_NOT_ROUTED: "신탁 수령 위임", DOC_AI_CONSENT_MISSING: "AI 보이스 동의" };
const ruleName = (code: string) => RULES.find(([, cs]) => cs.some((c) => code.startsWith(c)))?.[0] ?? OTHER_RULES[code] ?? code;

/** 운영 관리 › 점검 › 정합성 점검 전체(시안 Ops-Validation). */
export function OpsValidation() {
  const qc = useQueryClient();
  const { by, works, options } = useScopes();
  const [scope, setScope] = useState(""), [sev, setSev] = useState("ALL");
  const parties = useParties();
  const p = usePaged<Issue>("ops-validation", "/validation-issues", { filters: { scope, status: "OPEN", severity: sev === "ALL" ? undefined : sev === "WARN+" ? "BLOCK,WARN" : sev } });
  const all = useGet<Issue[]>(["readiness", "validation-all"], "/validation-issues?status=OPEN");
  const text = useRecordText(p.rows.map((i) => i.scopeId));
  const subject = (id: string) => (id.startsWith("CLAIM:") || id.startsWith("MANDATE:") ? text(id.split(":")[1]!.split("@")[0]!) : parties.names.get(id) ?? id);
  const open = all.data ?? [];
  const blocks = open.filter((i) => i.severity === "BLOCK"), warns = open.filter((i) => i.severity === "WARN");
  const scopes = works.filter((w) => w.scopeId);
  const cell = (s: string, codes: string[]) => {
    const hit = open.filter((i) => i.scopeId === s && codes.some((c) => i.rule.startsWith(c)));
    if (hit.length === 0) return "✓";
    const b = hit.filter((i) => i.severity === "BLOCK").length;
    return <span style={{ color: b ? "var(--p-bad)" : "var(--p-warn)", fontWeight: 600 }}>{b ? `✕ 차단 ${b}` : `! 경고 ${hit.length}`}</span>;
  };
  const passed = scopes.length * RULES.length - scopes.reduce((a, w) => a + RULES.filter(([, cs]) => open.some((i) => i.scopeId === w.scopeId && cs.some((c) => i.rule.startsWith(c)))).length, 0);
  const last = open.map((i) => i.checkedAt).sort().at(-1);
  // 다시 점검: 곡마다 점검을 다시 돌린다(GET /scopes/:id/validation이 재검사한다).
  const recheck = () => void Promise.all(scopes.map((w) => api("GET", `/scopes/${encodeURIComponent(w.scopeId!)}/validation`))).then(() => qc.invalidateQueries());
  const due = warns.map((i) => i.dueAt).filter(Boolean).sort()[0];
  return (
    <OpsPage title="정합성 점검 전체" desc="모든 곡의 정합성 점검 결과. 차단이 있으면 그 곡의 분배 규칙을 활성화하지 못한다. 곡 하나는 작품 워크스페이스 › 분배 규칙·팩 ① 정합성 점검"
      actions={<button type="button" className="p-btn wide" onClick={recheck}>다시 점검</button>}>
      <Stats items={[
        { label: "차단", value: blocks.length, note: "" },
        { label: "경고", value: warns.length, note: `${[...new Set(warns.map((i) => by.get(i.scopeId)?.title ?? i.scopeId))].join(" · ")}${due ? ` · 기한 ${due.slice(5, 10)}` : ""}`, warn: warns.length > 0 },
        { label: "통과 규칙", value: `${passed} / ${scopes.length * RULES.length}`, note: `곡 ${scopes.length} × 규칙 ${RULES.length}` },
        { label: "마지막 점검", value: last ? last.slice(11, 16) : "—", note: last?.slice(0, 10) ?? "" },
      ]} />
      <Filters placeholder="곡명, 규칙" selects={[
        { name: "곡", value: scope, options, onChange: setScope },
        { name: "수준", value: sev, options: [["ALL", "전체"], ["WARN+", "경고 이상"], ["BLOCK", "차단"]], onChange: setSev },
      ]} />
      <ErrorPanel error={p.error} />
      <TableCard title={["걸린 항목", `${p.total}건`]} cols={["곡", "규칙", "수준", "대상", "내용", ""]} count={p.rows.length} empty="걸린 항목이 없습니다."
        page={p.page} total={p.total} onPage={p.setPage} foot="경고 이상만 보인다. 수준을 '전체'로 바꾸면 통과한 규칙도 보인다.">
        {p.rows.map((i) => {
          const w = by.get(i.scopeId);
          return (
            <tr key={i.issueId}>
              <td>{w?.title ?? i.scopeId}</td><td>{ruleName(i.rule)}</td><td><B tone={i.severity === "BLOCK" ? "bad" : "warn"}>{i.severity === "BLOCK" ? "차단" : "경고"}</B></td>
              <td>{subject(i.subjectId)}</td><td>{i.rule === "DOC_CONFIRMATION_PENDING" && subject(i.subjectId).startsWith("작가 지분") ? "작가 서명 대기" : i.message}{i.dueAt ? ` · 기한 ${i.dueAt.slice(5, 10)} 지나면 차단` : ""}</td>
              <td>{w && <Link to={`/works/${encodeURIComponent(w.workId)}/${i.rule === "DOC_CONFIRMATION_PENDING" ? "confirm" : "policy"}`}>곡 워크스페이스 › {i.rule === "DOC_CONFIRMATION_PENDING" ? "확인·동의" : "분배 규칙·팩"} →</Link>}</td>
            </tr>
          );
        })}
      </TableCard>
      <Card title="규칙별 결과" hint={`곡 ${scopes.length} · 규칙 ${RULES.length}`}>
        <TableCard cols={["규칙", ...scopes.map((w) => w.title)]} count={RULES.length} paged={false} minW={700} label="규칙별 결과">
          {RULES.map(([n, cs]) => <tr key={n}><td>{n}</td>{scopes.map((w) => <td key={w.workId}>{cell(w.scopeId!, cs)}</td>)}</tr>)}
        </TableCard>
      </Card>
    </OpsPage>
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

/** 운영 관리 › 조직 › 내 조직(시안 Ops-Org). */
export function OpsOrg() {
  const me = useGet<Me>(["me"], "/me");
  const t = useGet<TenantDetail>(["tenant", me.data?.tenantId], `/tenants/${me.data?.tenantId ?? ""}`, { enabled: me.data !== undefined && me.data.scope !== "platform" });
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const [page, setPage] = useState(1);
  const d = t.data;
  const parties = paginate(mine.data ?? [], page);
  const role = (x: string) => (x === "LABEL" ? "녹음 권리 · 마스터 보유" : x === "AGENCY" ? "실연 수익 수령 위임" : x);
  return (
    <OpsPage title={d?.name ?? "내 조직"} desc={`권리 테넌트 · ${d?.tenantType === "LABEL" ? "레이블" : d?.tenantType ?? ""} · ${d?.tenantId ?? ""}`}
      actions={d && <B tone={d.status === "ACTIVE" ? "ok" : "warn"}>{STATUS_KO[d.status] ?? d.status}{d.statusChangedAt ? ` · ${d.statusChangedAt.slice(5, 10)}` : ""}</B>}>
      <ErrorPanel error={t.error} />
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
      <Card title="우리 당사자" hint="당사자 등록(E09)">
        <TableCard cols={["당사자", "역할", "쓰인 곳"]} count={parties.rows.length} minW={600} page={page} total={parties.total} onPage={setPage} empty="당사자가 없습니다." label="우리 당사자">
          {parties.rows.map((x) => <tr key={x.partyId}><td>{x.displayName}</td><td>{role(x.partyType)}</td><td><Mono>{x.partyId}</Mono></td></tr>)}
        </TableCard>
      </Card>
    </OpsPage>
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

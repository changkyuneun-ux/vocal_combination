import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type ApiError } from "../../api/client.ts";
import { useActor } from "../../app/actor.ts";
import type { Contract, Template } from "../../api/contracts.ts";
import { usableTemplates } from "../../api/contracts.ts";
import { useGet } from "../../api/hooks.ts";
import { paginate, usePaged } from "../../api/paged.ts";
import type { IssueRow, Paged } from "../../api/types.ts";
import { orgPartyIds, type ConsentRow, type DocumentRow, type PartyRow } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useMe, useParties } from "../works/data.tsx";
import { groupContracts } from "../works/model.ts";
import type { ReadingFrame } from "../../api/imports.ts";
import { B, Card, CsvButton, Filters, GroupDetail, GroupedTable, Mono, OpsPage, Stats, Sub, TableCard, mmdd, useScopes, type WorkGroup } from "./common.tsx";

/**
 * 우리 곡의 표준 계약 전부: 곡을 지정한 목록(곡 탭과 같은 캐시)을 곡마다 읽어 합친다.
 * 곡을 지정해 곡 범위의 계약을 다 본다 — 곡 지정 없는 /contracts는 우리가 만들었거나 서명할 계약만.
 */
function useSongContracts() {
  const actor = useActor();
  const { works } = useScopes();
  const all = useGet<Contract[]>(["work-contracts", "all"], "/contracts");
  const scopes = works.flatMap((w) => (w.scopeId ? [w.scopeId] : []));
  const per = useQueries({ queries: scopes.map((s) => ({ queryKey: ["work-contracts", s, actor], queryFn: () => api<Contract[]>("GET", `/contracts?scope=${encodeURIComponent(s)}`, undefined, { actorOverride: actor }) })) });
  const seen = new Map<string, Contract>();
  for (const c of [...per.flatMap((q) => q.data ?? []), ...(all.data ?? [])]) if (!seen.has(c.contractId)) seen.set(c.contractId, c);
  return { rows: [...seen.values()], error: all.error ?? (per.find((q) => q.error)?.error as ApiError | undefined) ?? null };
}

/** 운영 관리 › 확인·동의 › 멤버 이용 동의(시안 Ops-Consents): 조회만. */
export function OpsConsents() {
  const { by } = useScopes();
  const parties = useParties();
  const [status, setStatus] = useState("");
  const all = useGet<ConsentRow[]>(["work-consents", "all"], "/consents");
  const perf = (all.data ?? []).filter((c) => c.rightType === "PERFORMER");
  const signed = perf.filter((c) => c.status === "SIGNED"), revoked = perf.filter((c) => c.status === "REVOKED");
  const members = parties.items.filter((x) => x.partyType === "MEMBER");
  const waiting = members.filter((m) => !signed.some((c) => c.partyId === m.partyId)).length;
  const songs = [...new Set(signed.map((c) => c.factsScopeId))];
  // 소속: 멤버와 함께 수령 위임 계약에 서명한 소속사(시안 "빅히트 뮤직 매니지먼트 소속")
  const contracts = useGet<Contract[]>(["work-contracts", "all"], "/contracts");
  const agencies = new Set(parties.items.filter((x) => x.partyType === "AGENCY").map((x) => x.partyId));
  const affiliation = (partyId: string) => {
    const c = (contracts.data ?? []).find((x) => x.signatures.some((s) => s.partyId === partyId) && x.signatures.some((s) => agencies.has(s.partyId)));
    const a = c?.signatures.find((s) => agencies.has(s.partyId));
    return a ? `${(parties.names.get(a.partyId) ?? a.displayName).replace(/\(소속사\)$/, "")} 소속` : undefined;
  };
  return (
    <OpsPage title="멤버 이용 동의" desc="멤버가 실연자 앱에서 본인이 한 팬앱 이용 동의. 작품을 누르면 그 작품 멤버만 펼친다" actions={<CsvButton name="consents" head={["멤버", "보이스", "곡", "동의 시작", "상태"]} rows={perf.map((c) => [parties.names.get(c.partyId) ?? c.partyId, c.assetId, by.get(c.factsScopeId)?.title ?? c.factsScopeId, c.validFrom, c.status])} />}>
      <Stats items={[
        { label: "동의함", value: `${signed.length} / ${members.length}`, note: `멤버 ${members.length}` },
        { label: "동의 대기", value: waiting, note: waiting === 0 ? "다시 알림 보낼 대상 없음" : "멤버 실연자 앱에서 동의" },
        { label: "철회", value: revoked.length, note: "철회하면 그 멤버 스템 조합 노출 중지" },
        { label: "작품", value: songs.length, note: songs.map((s) => by.get(s)?.title ?? s).join(" · ") },
      ]} />
      <Filters placeholder="멤버, 보이스" selects={[
        { name: "상태", value: status, options: [["", "전체"], ["SIGNED", "동의함"], ["REVOKED", "철회"]], onChange: setStatus },
      ]} />
      <ErrorPanel error={all.error} />
      <GroupedTable kind="consents" label="멤버 이용 동의" filters={{ status: status || undefined }} cols={["멤버", "동의함", "대기·철회", "상태"]}
        cells={(g) => [g.summary.members, g.summary.signed, g.summary.pending, g.status && <B key="b" tone={g.status[1]}>{g.status[0]}</B>]}
        detail={(g) => <ConsentDetail g={g} status={status} affiliation={affiliation} />}
        foot="동의는 멤버 본인만 하거나 철회한다. 빅히트는 조회와 다시 알림만 한다." />
    </OpsPage>
  );
}

/** 운영 관리 › 계약·문서 › 표준 계약 전체(시안 Ops-Contracts): 조회와 이동만. */
export function OpsContracts() {
  const { by, options } = useScopes();
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const parties = useParties();
  const own = orgPartyIds(mine.data);
  const [kind, setKind] = useState(""), [status, setStatus] = useState("");
  const all = useSongContracts();
  const rows = all.rows;
  const title = (c: Contract) => `${(templates.data ?? []).find((t) => t.templateId === c.templateId && t.version === c.templateVersion)?.title ?? c.templateId} v${c.templateVersion}`;
  const other = (c: Contract) => c.signatures.find((s) => !own.has(s.partyId))?.displayName;
  // 작가(계정 없음)에게 빅히트가 보낸 전자서명 링크(결정 WD2): 시안 "작가(전자서명 링크) 대기 / 빅히트가 보냄 · 01-02".
  const authorIds = new Set(parties.items.filter((p) => p.partyType === "AUTHOR").map((p) => p.partyId));
  const eSignLink = (c: Contract) => c.status === "SENT" && c.signatures.some((s) => !s.signedAt && authorIds.has(s.partyId));
  const me = useMe();
  const orgShort = (me.me?.memberships ?? []).find((m) => m.tenantId === me.me?.tenantId)?.name ?? "";
  const st = (c: Contract): [string, "ok" | "warn" | "muted"] => (c.status === "COMPLETED" ? ["반영", "ok"] : c.status === "CANCELLED" ? ["취소", "muted"] : ["서명 대기", "warn"]);
  const pending = rows.filter((c) => c.status === "SENT" || c.status === "SIGNED");
  const tplOpts: [string, string][] = [["", "템플릿 전체"], ...usableTemplates(templates.data ?? []).map((t): [string, string] => [t.templateId, `${t.title} v${t.version}`])];
  return (
    <OpsPage title="표준 계약 전체" desc="빅히트 뮤직이 보낸 표준 계약. 권리 확정(권리 확인서)과 이용 허락(이용허락·동의·수령 위임)을 나눠 본다" actions={<CsvButton name="contracts" head={["곡", "계약", "템플릿", "상태"]} rows={rows.map((c) => [by.get(c.factsScopeId)?.title ?? c.factsScopeId, c.title, title(c), c.status])} />}>
      <Stats items={[
        { label: "전체", value: rows.length, note: `작품 ${new Set(rows.map((c) => c.factsScopeId)).size}` },
        { label: "서명 대기", value: pending.length, note: [...new Set(pending.map((c) => by.get(c.factsScopeId)?.title ?? c.factsScopeId))].map((t) => `${t} ${pending.filter((c) => (by.get(c.factsScopeId)?.title ?? c.factsScopeId) === t).length}`).join(" · "), warn: pending.length > 0 },
        { label: "반영", value: rows.filter((c) => c.status === "COMPLETED").length, note: "서명본은 원천 문서로" },
        { label: "거절·만료", value: rows.filter((c) => c.status === "CANCELLED").length, note: "" },
      ]} />
      <Filters placeholder="계약, 당사자" selects={[
        { name: "구분", value: kind, options: [["", "구분 전체"], ["confirm", "권리 확정"], ["license", "이용 허락"]], onChange: setKind },
        { name: "상태", value: status, options: [["", "전체"], ["SENT", "서명 대기"], ["COMPLETED", "반영"]], onChange: setStatus },
      ]} />
      <ErrorPanel error={all.error} />
      <GroupedTable kind="contracts" label="표준 계약" filters={{ kind: kind || undefined, status: status || undefined }} cols={["계약", "서명 대기", "반영", "상태"]}
        cells={(g) => [g.summary.rows, <span key="p" style={g.summary.pending ? { color: "var(--p-warn)", fontWeight: 700 } : undefined}>{g.summary.pending}</span>, g.summary.done, g.status && <B key="b" tone={g.status[1]}>{g.status[0]}</B>]}
        detail={(g) => <ContractDetail g={g} kind={kind} status={status} own={own} title={title} />}
        foot="권리 확정 = 누가 몇 %를 갖는지 서명으로 확정. 이용 허락 = 팬앱에서 써도 된다는 허락. 계약 만들기는 곡의 문서·계약 탭에서." />
    </OpsPage>
  );
}

const DOC_BASIS: Record<string, string> = { MASTER_CONTRACT: "녹음 권리 · 테넌트 권리 보유 증빙", PUBLISHING: "작가 지분", PLATFORM_CONTRACT: "플랫폼 이용", PERFORMER_CONSENT: "실연 이용 동의", MANDATE: "위임 확정", LICENSE: "이용 동의 확정" };

/** 운영 관리 › 계약·문서 › 원천 문서(시안 Ops-Docs). */
export function OpsDocuments() {
  const [origin, setOrigin] = useState("");
  const all = useGet<(DocumentRow & { origin: string })[]>(["documents"], "/documents");
  const rows = all.data ?? [];
  const upload = rows.filter((d) => d.origin === "UPLOADED").length;
  const songs = new Set(rows.flatMap((d) => (d.factsScopeId ? [d.factsScopeId] : []))).size, org = rows.filter((d) => !d.factsScopeId).length;
  return (
    <OpsPage title="원천 문서" desc="작품마다 원본 계약서(권리 근거)와 표준 계약 서명본. 작품을 누르면 그 작품 문서만 펼친다"
      actions={<CsvButton name="documents" head={["문서", "버전", "종류", "당사자", "효력"]} rows={rows.map((d) => [d.title, d.version, d.origin, d.parties.join(" "), d.effectiveFrom ?? ""])} />}>
      <Stats items={[
        { label: "전체", value: rows.length, note: `작품 ${songs} · 조직 ${org}` },
        { label: "원본 계약서", value: upload, note: "권리 근거" },
        { label: "서명본", value: rows.filter((d) => d.origin === "TEMPLATE_SIGNED").length, note: "반영된 표준 계약" },
        { label: "근거로 쓰인 주장", value: "—", note: "문서별 주장 수 조회가 없다" },
      ]} />
      <Filters placeholder="문서명, 당사자" selects={[
        { name: "종류", value: origin, options: [["", "종류 전체"], ["UPLOADED", "원본 계약서"], ["TEMPLATE_SIGNED", "서명본"]], onChange: setOrigin },
      ]} />
      <ErrorPanel error={all.error} />
      <GroupedTable kind="documents" label="원천 문서" filters={{ origin: origin || undefined }} cols={["원본 계약서", "서명본", "근거 주장"]}
        cells={(g) => [g.summary.originals, g.scopeId === null && g.summary.signed === 0 ? "—" : g.summary.signed, g.scopeId === null && g.summary.records === 0 ? "—" : g.summary.records]}
        detail={(g) => <DocumentDetail g={g} origin={origin} />}
        foot="원본 계약서는 곡의 새 곡·문서·계약 화면에서 그 곡에 묶어 올린다. IR에 쓰인 문서는 지우거나 바꿀 수 없다." />
    </OpsPage>
  );
}

const TPL_USE: Record<string, [string, string, string]> = {
  // 시안 Ops-Templates의 줄 순서
  tpl_platform_contract: ["테넌트 온보딩", "권리 테넌트", "플랫폼 이용 확정"], tpl_master_license: ["원곡 권리 › 녹음", "레이블", "녹음 이용 동의"],
  tpl_work_license: ["원곡 권리 › 작품", "작가(계정 없으면 전자서명 링크)", "작품 이용 동의"], tpl_performer_mandate: ["원곡 권리 › 수령 위임", "멤버(실연자 앱) → 소속사", "수령 위임"],
  tpl_performer_consent: ["확인·동의", "멤버(실연자 앱) 본인", "실연 이용 동의"],
  tpl_claim_confirm_label: ["문서·계약 › 계약서 불러오기", "레이블", "마스터 보유 주장"],
  tpl_claim_confirm_author: ["문서·계약 › 계약서 불러오기", "작가 전원(전자서명 링크)", "작가 지분 주장"],
};
const DOC_KIND: Record<string, string> = { PUBLISHING: "작품 퍼블리싱 계약", MASTER_CONTRACT: "녹음 계약" };
const IR_ITEM: Record<string, string> = { WORK_TITLE: "곡명", AUTHOR: "작가", AUTHOR_SHARE: "작가 · 작가별 지분", EFFECTIVE_FROM: "효력 시작", RECORDING: "녹음", MASTER_OWNER: "마스터 보유자" };
/** 읽기 틀이 읽는 항목(시안: "곡명 · 작가 · 작가별 지분 · 효력 시작"). */
export function frameItems(f: Pick<ReadingFrame, "fields">): string {
  return [...new Set(f.fields.flatMap((x) => (IR_ITEM[x.irItem] ?? x.irItem).split(" · ")))].join(" · ");
}

/** 운영 관리 › 계약·문서 › 계약 템플릿(시안 Ops-Templates): 표준 계약 템플릿(권리 확인서 2종 포함)과 계약서 읽기 틀. 읽기 틀 등록 폼은 시안이 없어 꺼 둔다. */
export function OpsTemplates() {
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const contracts = useSongContracts();
  const consents = useGet<ConsentRow[]>(["work-consents", "all"], "/consents");
  const [page, setPage] = useState(1);
  const order = Object.keys(TPL_USE);
  const rank = (id: string) => (order.indexOf(id) < 0 ? order.length : order.indexOf(id));
  const list = [...usableTemplates(templates.data ?? [])].sort((a, b) => rank(a.templateId) - rank(b.templateId));
  const { rows, total } = paginate(list, page);
  const frames = useGet<ReadingFrame[]>(["reading-frames"], "/reading-frames");
  // 읽기 틀은 틀마다 지금 쓰는 버전(승인 최신, 없으면 최신 초안) 한 줄.
  // 순서: 최근 승인 먼저, 같으면 작품 퍼블리싱 → 녹음(시안 순서).
  const latest = [...new Map((frames.data ?? []).filter((f) => f.status !== "RETIRED").map((f) => [f.frameId, f])).values()]
    .sort((a, b) => (b.approvedAt ?? "").localeCompare(a.approvedAt ?? "") || (a.documentKind === "PUBLISHING" ? -1 : b.documentKind === "PUBLISHING" ? 1 : 0));
  const [fp, setFp] = useState(1);
  const fr = paginate(latest, fp);
  return (
    <OpsPage title="계약 템플릿" desc="표준 계약 템플릿(플랫폼 법무 관리, 빅히트는 골라 쓴다)과 계약서 읽기 틀(빅히트 등록 · 플랫폼 승인)"
      actions={<button type="button" className="p-btn wide primary" disabled title="읽기 틀 등록 화면은 시안이 아직 없다(등록·승인 API는 있다)">+ 읽기 틀 등록</button>}>
      <ErrorPanel error={templates.error} />
      <TableCard title={["표준 계약 템플릿", "플랫폼 법무 관리"]} cols={["템플릿", "버전", "쓰는 곳", "서명", "조항", "서명하면", "쓴 계약"]} count={rows.length} empty="템플릿이 없습니다."
        page={page} total={total} onPage={setPage} foot="권리 확인서는 원본 계약을 대체하지 않고 확인·정리한다. 원본은 조항에 근거로 적힌다. 새 버전이 나와도 이미 서명된 계약은 서명 당시 버전에 고정된다.">
        {rows.map((t) => {
          const u = TPL_USE[t.templateId];
          return (
            <tr key={t.templateId}>
              <td>{t.recordKind === "CLAIM_CONFIRM" ? <Sub main={t.title} small="새 템플릿(CT5)" /> : t.title}</td><td><Mono>v{t.version}</Mono></td><td>{u?.[0] ?? "—"}</td><td>{u?.[1] ?? t.signerVars.join(" · ")}</td><td>{t.clauses.length}</td>
              <td>{u?.[2] ?? t.recordKind}{t.recordKind === "CLAIM_CONFIRM" && <> <B tone="ok">VERIFIED</B></>}</td>
              <td>{t.templateId === "tpl_performer_consent" ? (consents.data ?? []).filter((c) => c.rightType === "PERFORMER").length : contracts.rows.filter((c) => c.templateId === t.templateId).length}</td>
            </tr>
          );
        })}
      </TableCard>
      <ErrorPanel error={frames.error} />
      <TableCard title={["계약서 읽기 틀", "빅히트 등록 · 플랫폼 승인(CT2)"]} cols={["읽기 틀(계약 양식)", "쓰는 계약", "읽는 항목", "등록", "승인", "쓴 횟수"]} count={fr.rows.length}
        empty="등록한 읽기 틀이 없습니다." page={fp} total={fr.total} onPage={setFp}
        foot="읽기 틀은 계약 양식에서 값이 있는 위치(쪽·조항)를 IR 항목에 대응시킨 것이다. 같은 양식의 계약을 불러오면 값이 후보로 채워진다. 계약서는 플랫폼 밖으로 보내지 않는다(CT1). 처음 보는 양식은 사람이 조항을 표시한다.">
        {fr.rows.map((f) => (
          <tr key={f.frameId}>
            <td><Sub main={f.title} small={`v${f.version}${f.pages ? ` · 쪽 ${f.pages}` : ""}`} /></td><td>{DOC_KIND[f.documentKind] ?? f.documentKind}</td><td>{frameItems(f)}</td>
            <td><Sub main={f.authoredBy} small={mmdd(f.authoredAt)} /></td>
            <td>{f.status === "APPROVED" ? <B tone="ok">플랫폼 승인 {f.approvedAt!.slice(5, 10)}</B> : <B tone="warn">승인 대기</B>}</td><td>{f.uses}</td>
          </tr>
        ))}
      </TableCard>
    </OpsPage>
  );
}

/** 운영 관리 › 정산 › 발행 조합(시안 Ops-Issues). */
export function OpsIssues() {
  const [pack, setPack] = useState("");
  const packs = useGet<Paged<{ packId: string; packCode: string }>>(["work-packs"], "/packs?limit=200");
  const { options } = useScopes();
  const p = usePaged<IssueRow>("ops-issues", "/issues", { filters: { pack } });
  const NO_REV = "조합별 구매·매출은 포털 조회가 없다 — 명세·지급에서 합계를 본다";
  return (
    <OpsPage title="발행 조합" desc="팬앱에서 발행된 보컬 조합. 발행 순간의 IR(facts·정책·조합 지분·멤버)이 봉인되어 정산 근거가 된다. 작품을 누르면 조합을 펼친다" actions={<CsvButton name="issues" head={["조합", "팩", "발행", "정책 버전"]} rows={p.rows.map((r) => [r.vcId, r.packId, r.createdAt, r.policyVersion])} />}>
      <Stats items={[
        { label: "발행 조합", value: p.total, note: `작품 ${options.length - 1}` },
        { label: "구매", value: <span title={NO_REV}>—</span>, note: "" },
        { label: "매출", value: <span title={NO_REV}>—</span>, note: "" },
        { label: "보류", value: `${p.rows.filter((r) => r.quarantined).length}건`, note: "이상거래", warn: p.rows.some((r) => r.quarantined) },
      ]} />
      <Filters placeholder="조합 id, 이름" selects={[
        { name: "팩", value: pack, options: [["", "팩 전체"], ...(packs.data?.items ?? []).map((x): [string, string] => [x.packId, x.packCode])], onChange: setPack },
      ]} />
      <ErrorPanel error={p.error} />
      <GroupedTable kind="issues" label="발행 조합" filters={{ pack: pack || undefined }} cols={["조합", "구매", "매출(원)", "보류"]}
        cells={(g) => [g.summary.issued, <span key="b" title={NO_REV}>—</span>, <span key="r" title={NO_REV}>—</span>, "—"]}
        detail={(g) => <IssueDetail g={g} pack={pack} noRev={NO_REV} />}
        foot="발행 승인 대기는 없다 — 게이트를 통과하면 바로 봉인된다(MD8)." />
    </OpsPage>
  );
}

export { Card };

/* ── 작품 묶음 표의 상세(펼친 작품 하나, 10행 쪽 나눔 — 2026-10-24) ── */

function ConsentDetail({ g, status, affiliation }: { g: WorkGroup; status: string; affiliation: (p: string) => string | undefined }) {
  const parties = useParties();
  const p = usePaged<ConsentRow>(`ops-consents-${g.scopeId}`, "/consents", { filters: { right: "PERFORMER", scope: g.scopeId ?? undefined, status: status || undefined } });
  const born = new Map(parties.items.map((x) => [x.partyId, (x as { createdAt?: string }).createdAt ?? ""]));
  const shown = [...p.rows].sort((a, b) => a.validFrom.localeCompare(b.validFrom) || (born.get(a.partyId) ?? "").localeCompare(born.get(b.partyId) ?? ""));
  return (
    <GroupDetail cols={["멤버", "보이스", "동의 범위", "동의 시각", "상태"]} count={p.rows.length} page={p.page} total={p.total} onPage={p.setPage} empty={p.isLoading ? "불러오는 중…" : "이용 동의가 없습니다."}>
      {shown.map((c) => (
        <tr key={c.consentId}>
          <td><Sub main={parties.names.get(c.partyId) ?? c.partyId} small={affiliation(c.partyId)} /></td><td><Mono>{c.assetId}</Mono></td><td>미리듣기·조합 생성·개인 보관 · 팬앱</td>
          <td><Mono>{mmdd(c.validFrom)}</Mono></td><td><B tone={c.status === "SIGNED" ? "ok" : "bad"}>{c.status === "SIGNED" ? "동의함" : "철회"}</B></td>
        </tr>
      ))}
    </GroupDetail>
  );
}

function ContractDetail({ g, kind, status, own, title }: { g: WorkGroup; kind: string; status: string; own: Set<string>; title: (c: Contract) => string }) {
  const p = usePaged<Contract>(`ops-contracts-${g.scopeId}`, "/contracts", { filters: { scope: g.scopeId ?? undefined, kind: kind || undefined, status: status || undefined } });
  const confirm = (c: Contract) => c.templateId.startsWith("tpl_claim_confirm_");
  // 같은 템플릿·상태의 서명 진행 중 계약은 한 줄(건수)로 — 곡 탭과 같은 규칙.
  // 시안 순서: 권리 확정 먼저, 그다음 만든 순.
  const rows = groupContracts([...p.rows].sort((a, b) => Number(confirm(b)) - Number(confirm(a)) || a.createdAt.localeCompare(b.createdAt)), own);
  const other = (c: Contract) => c.signatures.find((s) => !own.has(s.partyId))?.displayName;
  return (
    <GroupDetail cols={["구분", "계약", "서명 당사자", "건수", "상태"]} count={p.rows.length} page={p.page} total={p.total} onPage={p.setPage}
      note={g.workId ? `${g.title} ${p.total}건 · 플랫폼 이용계약은 조직 단위(내 조직)` : undefined} empty={p.isLoading ? "불러오는 중…" : "표준 계약이 없습니다."}>
      {rows.map((grp) => {
        const c = grp[0]!;
        return (
          <tr key={c.contractId}>
            <td><B tone={confirm(c) ? "blue" : "muted"}>{confirm(c) ? "권리 확정" : "이용 허락"}</B></td>
            <td title={title(c)}>{c.title}{other(c) ? ` · ${other(c)}` : ""}{grp.length > 1 ? ` 외 ${grp.length - 1}명` : ""}</td>
            <td>{c.signatures.map((s) => `${s.displayName}${s.signedAt ? " ✓" : ""}`).join(" · ")}</td><td>{grp.length}</td>
            <td><B tone={c.status === "COMPLETED" ? "ok" : c.status === "CANCELLED" ? "muted" : "warn"}>{c.status === "COMPLETED" ? "반영" : c.status === "CANCELLED" ? "취소" : "서명 대기"}</B></td>
          </tr>
        );
      })}
    </GroupDetail>
  );
}

function DocumentDetail({ g, origin }: { g: WorkGroup; origin: string }) {
  const parties = useParties();
  const p = usePaged<DocumentRow & { origin: string }>(`ops-documents-${g.scopeId}`, "/documents", { filters: { scope: g.scopeId ?? "none", origin: origin || undefined } });
  return (
    <GroupDetail cols={["종류", "문서", "당사자", "효력", "근거가 된 것", ""]} count={p.rows.length} page={p.page} total={p.total} onPage={p.setPage} empty={p.isLoading ? "불러오는 중…" : "문서가 없습니다."}>
      {p.rows.map((d) => (
        <tr key={`${d.documentId}@${d.version}`}>
          <td><B tone={d.origin === "UPLOADED" ? "blue" : "muted"}>{d.origin === "UPLOADED" ? "원본 계약서" : "서명본"}</B></td>
          <td>{d.title} v{d.version}{d.origin === "UPLOADED" ? " (PDF)" : " 서명본"}</td>
          <td>{d.parties.length > 2 ? `${parties.names.get(d.parties[0]!) ?? d.parties[0]} 외 ${d.parties.length - 1}` : d.parties.map((x) => parties.names.get(x) ?? x).join(" · ")}</td>
          <td><Mono>{d.effectiveFrom?.slice(0, 10) ?? "—"}</Mono></td><td>{DOC_BASIS[d.kind] ?? d.kind}</td><td><Link to="/documents">보기</Link></td>
        </tr>
      ))}
    </GroupDetail>
  );
}

function IssueDetail({ g, pack, noRev }: { g: WorkGroup; pack: string; noRev: string }) {
  const p = usePaged<IssueRow>(`ops-issues-${g.scopeId}`, "/issues", { filters: { scope: g.scopeId ?? undefined, pack: pack || undefined } });
  return (
    <GroupDetail cols={["조합", "바꾼 곳", "발행", "봉인", "구매", "매출(원)"]} count={p.rows.length} page={p.page} total={p.total} onPage={p.setPage} empty={p.isLoading ? "불러오는 중…" : "발행된 조합이 없습니다."}>
      {p.rows.map((r) => (
        <tr key={r.snapshotId}>
          <td><Link to={`/issues/${encodeURIComponent(r.snapshotId)}`} style={{ color: "inherit" }}><Sub main={r.vcId} small={r.packId} /></Link></td><td><span title="바꾼 파트 요약은 조합 지분 보기에서">—</span></td>
          <td><Mono>{mmdd(r.createdAt)}</Mono></td><td><B tone="ir">facts · 정책 v{r.policyVersion}</B></td><td title={noRev}>—</td><td title={noRev}>—</td>
        </tr>
      ))}
    </GroupDetail>
  );
}

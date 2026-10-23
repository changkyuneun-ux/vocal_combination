import { useState } from "react";
import { Link } from "react-router";
import type { Contract, Template } from "../../api/contracts.ts";
import { usableTemplates } from "../../api/contracts.ts";
import { useGet } from "../../api/hooks.ts";
import { paginate, usePaged } from "../../api/paged.ts";
import type { IssueRow, Paged } from "../../api/types.ts";
import type { ConsentRow, DocumentRow, PartyRow } from "../../api/works.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useParties } from "../works/data.tsx";
import { groupContracts } from "../works/model.ts";
import { B, Card, CsvButton, Filters, Mono, OpsPage, Stats, Sub, TableCard, mmdd, useScopes } from "./common.tsx";


/** 운영 관리 › 확인·동의 › 멤버 이용 동의(시안 Ops-Consents): 조회만. */
export function OpsConsents() {
  const { by, options } = useScopes();
  const parties = useParties();
  const [scope, setScope] = useState(""), [status, setStatus] = useState("");
  const p = usePaged<ConsentRow>("ops-consents", "/consents", { filters: { right: "PERFORMER", scope, status } });
  const all = useGet<ConsentRow[]>(["work-consents", "all"], "/consents");
  const perf = (all.data ?? []).filter((c) => c.rightType === "PERFORMER");
  const signed = perf.filter((c) => c.status === "SIGNED"), revoked = perf.filter((c) => c.status === "REVOKED");
  const members = parties.items.filter((x) => x.partyType === "MEMBER");
  const waiting = members.filter((m) => !signed.some((c) => c.partyId === m.partyId)).length;
  const songs = [...new Set(signed.map((c) => c.factsScopeId))];
  return (
    <OpsPage title="멤버 이용 동의" desc="멤버가 실연자 앱에서 본인이 한 팬앱 이용 동의. 동의가 없는 멤버의 스템은 조합 발행이 거부된다(ISSUE_NOT_LICENSED)" actions={<CsvButton name="consents" head={["멤버", "보이스", "곡", "동의 시작", "상태"]} rows={perf.map((c) => [parties.names.get(c.partyId) ?? c.partyId, c.assetId, by.get(c.factsScopeId)?.title ?? c.factsScopeId, c.validFrom, c.status])} />}>
      <Stats items={[
        { label: "동의함", value: `${signed.length} / ${members.length}`, note: `멤버 ${members.length}` },
        { label: "동의 대기", value: waiting, note: waiting === 0 ? "다시 알림 보낼 대상 없음" : "멤버 실연자 앱에서 동의" },
        { label: "철회", value: revoked.length, note: "철회하면 그 멤버 스템 조합 노출 중지" },
        { label: "적용 곡", value: songs.length, note: songs.map((s) => by.get(s)?.title ?? s).join(" · ") },
      ]} />
      <Filters placeholder="멤버, 보이스" selects={[
        { name: "곡", value: scope, options, onChange: setScope },
        { name: "상태", value: status, options: [["", "전체"], ["SIGNED", "동의함"], ["REVOKED", "철회"]], onChange: setStatus },
      ]} />
      <ErrorPanel error={p.error} />
      <TableCard label="멤버 이용 동의" cols={["멤버", "보이스", "동의 범위", "적용 곡", "동의 시각", "동의서", "상태"]} count={p.rows.length} empty="이용 동의가 없습니다."
        page={p.page} total={p.total} onPage={p.setPage} foot="동의는 멤버 본인만 하거나 철회한다. 빅히트는 조회와 다시 알림만 한다. 동의 범위는 팩 이용 범위와 같아야 한다(분배 규칙·팩).">
        {p.rows.map((c) => (
          <tr key={c.consentId}>
            <td>{parties.names.get(c.partyId) ?? c.partyId}</td><td><Mono>{c.assetId}</Mono></td><td>팬앱 조합·구매·감상</td>
            <td>{by.get(c.factsScopeId)?.title ?? c.factsScopeId}</td><td><Mono>{mmdd(c.validFrom)}</Mono></td><td>멤버 팬앱 이용 동의 v1</td>
            <td><B tone={c.status === "SIGNED" ? "ok" : "bad"}>{c.status === "SIGNED" ? "동의함" : "철회"}</B></td>
          </tr>
        ))}
      </TableCard>
    </OpsPage>
  );
}

/** 운영 관리 › 계약·문서 › 표준 계약 전체(시안 Ops-Contracts): 조회와 이동만. */
export function OpsContracts() {
  const { by, options } = useScopes();
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const mine = useGet<PartyRow[]>(["parties", "mine"], "/my/parties");
  const own = new Set((mine.data ?? []).map((x) => x.partyId));
  const [scope, setScope] = useState(""), [tpl, setTpl] = useState(""), [status, setStatus] = useState("");
  const all = useGet<Contract[]>(["work-contracts", "all"], "/contracts");
  const rows = all.data ?? [];
  // 같은 곡·템플릿·상태의 서명 진행 중 계약은 곡 탭(문서·계약)과 같은 규칙(groupContracts)으로 한 줄로 묶고, 묶은 줄을 10줄씩 나눈다.
  const filtered = [...rows].filter((c) => (scope === "" || c.factsScopeId === scope) && (tpl === "" || c.templateId === tpl) && (status === "" || c.status === status))
    .sort((a, b) => (a.factsScopeId < b.factsScopeId ? -1 : a.factsScopeId > b.factsScopeId ? 1 : a.createdAt < b.createdAt ? -1 : 1));
  const [page, setPage] = useState(1);
  const grouped = paginate(groupContracts(filtered, own), page);
  const title = (c: Contract) => `${(templates.data ?? []).find((t) => t.templateId === c.templateId && t.version === c.templateVersion)?.title ?? c.templateId} v${c.templateVersion}`;
  const other = (c: Contract) => c.signatures.find((s) => !own.has(s.partyId))?.displayName;
  const platformMade = (c: Contract) => !c.signatures.some((s) => own.has(s.partyId));
  const st = (c: Contract): [string, "ok" | "warn" | "muted"] => (c.status === "COMPLETED" ? ["반영", "ok"] : c.status === "CANCELLED" ? ["취소", "muted"] : ["서명 대기", "warn"]);
  const pending = rows.filter((c) => c.status === "SENT" || c.status === "SIGNED");
  const tplOpts: [string, string][] = [["", "템플릿 전체"], ...usableTemplates(templates.data ?? []).map((t): [string, string] => [t.templateId, `${t.title} v${t.version}`])];
  return (
    <OpsPage title="표준 계약 전체" desc="빅히트 뮤직의 모든 곡에서 쓴 표준 계약(작성 → 서명 → 반영). 계약 만들기는 작품 워크스페이스 › 문서·계약에서" actions={<CsvButton name="contracts" head={["곡", "계약", "템플릿", "상태"]} rows={rows.map((c) => [by.get(c.factsScopeId)?.title ?? c.factsScopeId, c.title, title(c), c.status])} />}>
      <Stats items={[
        { label: "전체", value: rows.length, note: `곡 ${new Set(rows.map((c) => c.factsScopeId)).size}` },
        { label: "서명 대기", value: pending.length, note: [...new Set(pending.map((c) => by.get(c.factsScopeId)?.title ?? c.factsScopeId))].map((t) => `${t} ${pending.filter((c) => (by.get(c.factsScopeId)?.title ?? c.factsScopeId) === t).length}`).join(" · "), warn: pending.length > 0 },
        { label: "반영", value: rows.filter((c) => c.status === "COMPLETED").length, note: "서명본은 원천 문서로 자동 등록" },
        { label: "거절·만료", value: rows.filter((c) => c.status === "CANCELLED").length, note: "" },
      ]} />
      <Filters placeholder="곡명, 계약, 당사자" selects={[
        { name: "곡", value: scope, options, onChange: setScope },
        { name: "템플릿", value: tpl, options: tplOpts, onChange: setTpl },
        { name: "상태", value: status, options: [["", "전체"], ["SENT", "서명 대기"], ["COMPLETED", "반영"]], onChange: setStatus },
      ]} />
      <ErrorPanel error={all.error} />
      <TableCard label="표준 계약" cols={["곡", "계약", "템플릿", "서명 당사자", "건수", "상태", ""]} count={grouped.rows.length} empty="표준 계약이 없습니다."
        page={page} total={grouped.total} onPage={setPage} foot={`표준 계약 ${rows.length}건. 이 화면은 조회와 이동만 한다.`}>
        {grouped.rows.map((g) => {
          const c = g[0]!;
          const w = by.get(c.factsScopeId);
          const [t, tone] = st(c);
          const many = g.length > 1;
          const sign = (x: Contract) => [...x.signatures].sort((a, b) => Number(own.has(a.partyId)) - Number(own.has(b.partyId))).map((s) => `${s.displayName} ${s.signedAt ? "✓" : "대기"}`).join(" · ");
          const membersDone = g.every((x) => x.signatures.filter((s) => !own.has(s.partyId)).every((s) => s.signedAt));
          const oursDone = g.every((x) => x.signatures.filter((s) => own.has(s.partyId)).every((s) => s.signedAt));
          return (
            <tr key={c.contractId}>
              <td>{w?.title ?? c.factsScopeId}</td>
              <td>{c.title}{other(c) ? ` · ${other(c)}` : ""}{many ? ` 외 ${g.length - 1}명` : ""}</td><td>{title(c)}</td>
              <td>{many ? `멤버 ${membersDone ? "✓" : "대기"} · 소속사 ${oursDone ? "✓" : "대기"}`
                : platformMade(c) ? <Sub main={sign(c)} small="플랫폼이 작성(위탁 작가) · 조회만" /> : sign(c)}</td>
              <td>{g.length}</td><td><B tone={tone}>{t}</B></td>
              <td>{w && <Link to={`/works/${encodeURIComponent(w.workId)}/contracts`}>곡 워크스페이스 › 문서·계약 →</Link>}</td>
            </tr>
          );
        })}
      </TableCard>
    </OpsPage>
  );
}

const DOC_BASIS: Record<string, string> = { MASTER_CONTRACT: "녹음 권리 · 테넌트 권리 보유 증빙", PUBLISHING: "작가 지분", PLATFORM_CONTRACT: "플랫폼 이용", PERFORMER_CONSENT: "실연 이용 동의", MANDATE: "위임 확정", LICENSE: "이용 동의 확정" };

/** 운영 관리 › 계약·문서 › 원천 문서(시안 Ops-Docs). */
export function OpsDocuments() {
  const { works, options } = useScopes();
  const parties = useParties();
  const [scope, setScope] = useState(""), [origin, setOrigin] = useState("");
  const p = usePaged<DocumentRow & { origin: string }>("ops-documents", "/documents", { filters: { scope, origin } });
  const all = useGet<(DocumentRow & { origin: string })[]>(["documents"], "/documents");
  const rows = all.data ?? [];
  const facts = useGet<{ claims: { targetId: string }[] }>(["work-facts", works[0]?.scopeId], `/scopes/${encodeURIComponent(works[0]?.scopeId ?? "")}/facts`, { enabled: !!works[0]?.scopeId });
  const songOf = (d: DocumentRow) => (facts.data && d.parties.some((x) => facts.data!.claims.some((c) => c.targetId === x)) ? works[0]!.title : "조직");
  const upload = rows.filter((d) => d.origin !== "CONTRACT").length;
  return (
    <OpsPage title="원천 문서" desc="권리 주장의 근거가 되는 문서. 직접 올린 문서와 반영된 표준 계약의 서명본(자동 등록)"
      actions={<><CsvButton name="documents" head={["문서", "버전", "종류", "당사자", "효력"]} rows={rows.map((d) => [d.title, d.version, d.origin, d.parties.join(" "), d.effectiveFrom ?? ""])} /><Link className="p-btn wide primary" to="/documents">+ 문서 올리기</Link></>}>
      <Stats items={[
        { label: "전체", value: rows.length, note: `곡 ${works.length}` },
        { label: "직접 올림", value: upload, note: "PDF" },
        { label: "서명본(자동)", value: rows.length - upload, note: "반영된 표준 계약" },
        { label: "근거로 쓰인 주장", value: "—", note: "문서별 주장 수 조회가 없다" },
      ]} />
      <Filters placeholder="문서명, 당사자" selects={[
        { name: "곳", value: scope, options: [["", "전체"], ...options.slice(1)], onChange: setScope },
        { name: "종류", value: origin, options: [["", "종류 전체"], ["UPLOAD", "직접 올림"], ["CONTRACT", "서명본"]], onChange: setOrigin },
      ]} />
      <ErrorPanel error={p.error} />
      <TableCard label="원천 문서" cols={["곳", "문서", "당사자", "효력", "근거가 된 것", "등록", ""]} count={p.rows.length} empty="원천 문서가 없습니다."
        page={p.page} total={p.total} onPage={p.setPage} foot="IR에 쓰인 문서는 지우거나 바꿀 수 없다. 바로잡기는 새 문서를 올리고 주장을 새 버전으로 바꾼다.">
        {p.rows.map((d) => (
          <tr key={`${d.documentId}@${d.version}`}>
            <td>{songOf(d)}</td><td><Sub main={`${d.title} v${d.version}${d.origin === "CONTRACT" ? " 서명본" : " (PDF)"}`} small={d.origin === "CONTRACT" ? "서명본" : "직접 올림"} /></td>
            <td>{d.parties.length > 2 ? `${parties.names.get(d.parties[0]!) ?? d.parties[0]} 외 ${d.parties.length - 1}` : d.parties.map((x) => parties.names.get(x) ?? x).join(" · ")}</td>
            <td><Mono>{d.effectiveFrom?.slice(0, 10) ?? "—"}</Mono></td><td>{DOC_BASIS[d.kind] ?? d.kind}</td><td>{d.origin === "CONTRACT" ? "자동(반영)" : "직접 올림"}</td>
            <td><Link to="/documents">보기</Link></td>
          </tr>
        ))}
      </TableCard>
    </OpsPage>
  );
}

const TPL_USE: Record<string, [string, string, string]> = {
  tpl_platform_contract: ["테넌트 온보딩", "권리 테넌트", "플랫폼 이용 확정"], tpl_master_license: ["원곡 권리 › 녹음", "레이블", "녹음 이용 동의"],
  tpl_work_license: ["원곡 권리 › 작품", "작가(위탁이면 플랫폼이 작성)", "작품 이용 동의"], tpl_performer_mandate: ["원곡 권리 › 수령 위임", "멤버(실연자 앱) → 소속사", "수령 위임"],
  tpl_performer_consent: ["확인·동의", "멤버(실연자 앱) 본인", "실연 이용 동의"],
};

/** 운영 관리 › 계약·문서 › 계약 템플릿(시안 Ops-Templates의 표준 계약 템플릿 표 — 읽기 틀은 3부-B). */
export function OpsTemplates() {
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const contracts = useGet<Contract[]>(["work-contracts", "all"], "/contracts");
  const [page, setPage] = useState(1);
  const list = usableTemplates(templates.data ?? []);
  const { rows, total } = paginate(list, page);
  return (
    <OpsPage title="계약 템플릿" desc="표준 계약 템플릿(플랫폼 법무 관리, 빅히트는 골라 쓴다)과 계약서 읽기 틀(빅히트 등록 · 플랫폼 승인)"
      actions={<button type="button" className="p-btn wide primary" disabled title="계약서 읽기 틀은 3부-B에서 만든다">+ 읽기 틀 등록</button>}>
      <ErrorPanel error={templates.error} />
      <TableCard title={["표준 계약 템플릿", "플랫폼 법무 관리"]} cols={["템플릿", "버전", "쓰는 곳", "서명", "조항", "서명하면", "쓴 계약"]} count={rows.length} empty="템플릿이 없습니다."
        page={page} total={total} onPage={setPage} foot="권리 확인서는 원본 계약을 대체하지 않고 확인·정리한다. 원본은 조항에 근거로 적힌다. 새 버전이 나와도 이미 서명된 계약은 서명 당시 버전에 고정된다.">
        {rows.map((t) => {
          const u = TPL_USE[t.templateId];
          return (
            <tr key={t.templateId}>
              <td>{t.title}</td><td><Mono>v{t.version}</Mono></td><td>{u?.[0] ?? "—"}</td><td>{u?.[1] ?? t.signerVars.join(" · ")}</td><td>{t.clauses.length}</td><td>{u?.[2] ?? t.recordKind}</td>
              <td>{(contracts.data ?? []).filter((c) => c.templateId === t.templateId).length}</td>
            </tr>
          );
        })}
      </TableCard>
    </OpsPage>
  );
}

/** 운영 관리 › 정산 › 발행 조합(시안 Ops-Issues). */
export function OpsIssues() {
  const [pack, setPack] = useState("");
  const packs = useGet<Paged<{ packId: string; packCode: string }>>(["work-packs"], "/packs?limit=200");
  const { options } = useScopes();
  const [scope, setScope] = useState("");
  const p = usePaged<IssueRow>("ops-issues", "/issues", { filters: { pack, scope } });
  const NO_REV = "조합별 구매·매출은 포털 조회가 없다 — 명세·지급에서 합계를 본다";
  return (
    <OpsPage title="발행 조합" desc="팬앱에서 발행된 보컬 조합. 발행 순간의 IR(facts·정책·조합 지분·멤버)이 봉인되어 정산 근거가 된다" actions={<CsvButton name="issues" head={["조합", "팩", "발행", "정책 버전"]} rows={p.rows.map((r) => [r.vcId, r.packId, r.createdAt, r.policyVersion])} />}>
      <Stats items={[
        { label: "발행 조합", value: p.total, note: options.slice(1).map((o) => o[1]).join(" · ") },
        { label: "구매", value: <span title={NO_REV}>—</span>, note: "" },
        { label: "매출", value: <span title={NO_REV}>—</span>, note: "" },
        { label: "보류", value: `${p.rows.filter((r) => r.quarantined).length}건`, note: "격리된 발행", warn: p.rows.some((r) => r.quarantined) },
      ]} />
      <Filters placeholder="조합 id, 이름" selects={[
        { name: "곡", value: scope, options, onChange: setScope },
        { name: "팩", value: pack, options: [["", "팩 전체"], ...(packs.data?.items ?? []).map((x): [string, string] => [x.packId, x.packCode])], onChange: setPack },
      ]} />
      <ErrorPanel error={p.error} />
      <TableCard label="발행 조합" cols={["조합", "바꾼 곳", "발행", "봉인", "구매", "매출(원)", ""]} count={p.rows.length} empty="발행된 조합이 없습니다."
        page={p.page} total={p.total} onPage={p.setPage} foot="발행 승인 대기는 없다 — 게이트를 통과하면 바로 봉인된다(MD8). 봉인된 조합은 고칠 수 없고, 권리가 바뀌면 다음 발행부터 새 버전이 쓰인다.">
        {p.rows.map((r) => (
          <tr key={r.snapshotId}>
            <td><Sub main={r.vcId} small={r.packId} /></td><td><span title="바꾼 파트 요약은 조합 지분 보기에서">—</span></td><td><Mono>{mmdd(r.createdAt)}</Mono></td>
            <td><B tone="ir">facts · 정책 v{r.policyVersion}</B></td><td title={NO_REV}>—</td><td title={NO_REV}>—</td>
            <td><Link to={`/issues/${encodeURIComponent(r.snapshotId)}`}>조합 지분 보기</Link></td>
          </tr>
        ))}
      </TableCard>
    </OpsPage>
  );
}

export { Card };

import { lazy, Suspense, type ReactNode } from "react";
import { OrgDetailPage, OrgListPage, PeoplePage, StaffPage } from "../pages/admin/Onboarding.tsx";
import { OrgAccountsPage, OrgHome } from "../pages/org/Home.tsx";
import { LinksPage } from "../pages/org/Links.tsx";
import { DelegationPage } from "../pages/org/Delegation.tsx";
import { TrustWorksPage } from "../pages/partner/TrustWorks.tsx";
import { Dashboard } from "../pages/dashboard/Dashboard.tsx";
import { Parties } from "../pages/registry/Parties.tsx";
import { Assets } from "../pages/registry/Assets.tsx";
import { Claims } from "../pages/registry/Claims.tsx";
import { Mandates } from "../pages/registry/Mandates.tsx";
import { Disputes } from "../pages/registry/Disputes.tsx";
import { Policies } from "../pages/policy/Policies.tsx";
import { PolicyDetail } from "../pages/policy/PolicyDetail.tsx";
import { Packs } from "../pages/issuance/Packs.tsx";
import { PackDetail } from "../pages/issuance/PackDetail.tsx";
import { Issues } from "../pages/issuance/Issues.tsx";
import { IssueDetail } from "../pages/issuance/IssueDetail.tsx";
import { Revenue } from "../pages/revenue/Revenue.tsx";
import { TrafficPools } from "../pages/revenue/Traffic.tsx";
import { HubPage } from "../pages/hub/Hub.tsx";
import { DocumentsPage } from "../pages/documents/Documents.tsx";
import { RightsSummaryPage } from "../pages/registry/Summary.tsx";
import { ConfirmationsPage } from "../pages/confirmations/Confirmations.tsx";
import { ValidationPage } from "../pages/validation/Validation.tsx";
import { ContractsPage } from "../pages/contracts/Contracts.tsx";
import { Profiles } from "../pages/payout/Profiles.tsx";
import { PayoutRuns } from "../pages/payout/PayoutRuns.tsx";
import { PayoutRunDetail } from "../pages/payout/PayoutRunDetail.tsx";
import { InstructionDetail } from "../pages/payout/InstructionDetail.tsx";
import { Statements } from "../pages/statements/Statements.tsx";
import { Batches } from "../pages/settlement/Batches.tsx";
import { BatchDetail } from "../pages/settlement/BatchDetail.tsx";
import { RunDetail } from "../pages/settlement/RunDetail.tsx";
import { Quarantine } from "../pages/settlement/Quarantine.tsx";
import { Holds } from "../pages/settlement/Holds.tsx";
import { Ledger } from "../pages/ledger/Ledger.tsx";
import { EntryDetail } from "../pages/ledger/EntryDetail.tsx";
import { Section } from "../components/Section.tsx";
import { Pipeline } from "../pages/monitor/Pipeline.tsx";
import { StemAudioPage } from "../pages/audio/Audio.tsx";
import { OpsControl, PortalTransparency } from "../pages/control/Inspection.tsx";
import { WorksCatalog } from "../pages/works/Catalog.tsx";
import { Workspace } from "../pages/works/Workspace.tsx";
import { NewWork } from "../pages/works/NewWork.tsx";
import { OpsConfirmations } from "../pages/ops/Confirmations.tsx";
import { OpsConsents, OpsContracts, OpsDocuments, OpsIssues, OpsTemplates } from "../pages/ops/Lists.tsx";
import { OpsAccounts, OpsDelegation, OpsLinks, OpsOrg, OpsStatements, OpsValidation } from "../pages/ops/Org.tsx";
import type { AppKind } from "./apps.ts";

export function Placeholder({ title }: { title: string }) {
  return <Section title={title}><p className="muted">준비 중</p></Section>;
}

export type RouteDef = { path: string; title: string; element: ReactNode };
/**
 * roles: 로그인 세션에서 이 역할 중 하나가 있어야 메뉴에 보인다. perm: 이 권한(1부 RBAC, /me의 permissions)이 있어야 보인다 — 포털 메뉴는 perm을 쓴다.
 * 화면은 코어가 다시 검사한다.
 */
export type MenuItem = { to: string; label: string; roles?: string[]; perm?: string };
export type MenuGroup = { title: string; items: MenuItem[] };


/** 두 앱이 함께 쓰는 권리 화면(등록·정책·팩·발행 조회·명세). 포털에서는 RLS로 자기 테넌트 데이터만 보인다. */
const rightsRoutes: RouteDef[] = [
  { path: "/registry/summary", title: "권리 요약", element: <RightsSummaryPage /> },
  { path: "/documents", title: "원천 문서", element: <DocumentsPage /> },
  { path: "/confirmations", title: "확인 요청", element: <ConfirmationsPage /> },
  { path: "/validation", title: "정합성 점검", element: <ValidationPage /> },
  { path: "/contracts", title: "표준 계약", element: <ContractsPage /> },
  { path: "/registry/parties", title: "당사자", element: <Parties /> },
  { path: "/registry/assets", title: "곡·녹음·슬롯·스템·보이스", element: <Assets /> },
  { path: "/registry/claims", title: "권리 주장", element: <Claims /> },
  { path: "/registry/mandates", title: "위임", element: <Mandates /> },
  { path: "/registry/disputes", title: "분쟁", element: <Disputes /> },
  { path: "/audio", title: "스템 오디오", element: <StemAudioPage /> },
  { path: "/policy", title: "정책", element: <Policies /> },
  { path: "/policy/:policyId", title: "정책 상세", element: <PolicyDetail /> },
  { path: "/packs", title: "팩", element: <Packs /> },
  { path: "/packs/:packId", title: "팩 상세", element: <PackDetail /> },
  { path: "/issues", title: "발행", element: <Issues /> },
  { path: "/issues/:snapshotId", title: "발행 상세", element: <IssueDetail /> },
  { path: "/statements", title: "명세서", element: <Statements /> },
];

/** 포털 작품 목록·곡 워크스페이스(2부-B, 결정 ED3). */
const worksRoutes: RouteDef[] = [
  { path: "/works", title: "작품 관리", element: <WorksCatalog /> },
  { path: "/works/new", title: "새 곡 워크스페이스", element: <NewWork /> },
  { path: "/works/:workId/:tab", title: "곡 워크스페이스", element: <Workspace /> },
];

/** 포털 운영 관리 화면 12(시안 Nav-Ops-Confirm·Ops-*). */
const opsRoutesPortal: RouteDef[] = [
  { path: "/ops/confirmations", title: "확인 요청 전체", element: <OpsConfirmations /> },
  { path: "/ops/consents", title: "멤버 이용 동의", element: <OpsConsents /> },
  { path: "/ops/contracts", title: "표준 계약 전체", element: <OpsContracts /> },
  { path: "/ops/documents", title: "원천 문서", element: <OpsDocuments /> },
  { path: "/ops/templates", title: "계약 템플릿", element: <OpsTemplates /> },
  { path: "/ops/validation", title: "정합성 점검 전체", element: <OpsValidation /> },
  { path: "/ops/statements", title: "명세·지급", element: <OpsStatements /> },
  { path: "/ops/issues", title: "발행 조합", element: <OpsIssues /> },
  { path: "/", title: "내 조직", element: <OpsOrg /> },
  { path: "/accounts", title: "담당자 계정", element: <OpsAccounts /> },
  { path: "/delegation", title: "위임 대행", element: <OpsDelegation /> },
  { path: "/links", title: "신탁·유통 연결", element: <OpsLinks /> },
];

/** 운영 백오피스 전용(매출·정산·원장·지급). 권리자 포털에는 없다. */
const opsRoutes: RouteDef[] = [
  { path: "/", title: "⑧ 권리 파이프라인 관제", element: <Pipeline /> },
  { path: "/admin/tenants", title: "권리 테넌트", element: <OrgListPage cls="RIGHTS" /> },
  { path: "/admin/participants", title: "참여 기관", element: <OrgListPage cls="PARTICIPANT" /> },
  { path: "/admin/orgs/:tenantId", title: "조직 상세", element: <OrgDetailPage /> },
  { path: "/admin/staff", title: "운영 인력", element: <StaffPage /> },
  { path: "/admin/people", title: "개인 계정", element: <PeoplePage /> },
  { path: "/admin/links", title: "연결", element: <LinksPage /> },
  { path: "/dashboard", title: "검증 체크리스트", element: <Dashboard /> },
  { path: "/revenue", title: "매출", element: <Revenue /> },
  { path: "/revenue/traffic", title: "감상 수익 풀", element: <TrafficPools /> },
  { path: "/hub", title: "연동 허브", element: <HubPage /> },
  { path: "/settlement/batches", title: "정산 배치", element: <Batches /> },
  { path: "/settlement/batches/:batchId", title: "정산 배치 상세", element: <BatchDetail /> },
  { path: "/settlement/runs/:runId", title: "정산 run 상세", element: <RunDetail /> },
  { path: "/settlement/quarantine", title: "격리", element: <Quarantine /> },
  { path: "/settlement/holds", title: "보류", element: <Holds /> },
  { path: "/ledger", title: "원장", element: <Ledger /> },
  { path: "/ledger/entries/:entryId", title: "분개 상세", element: <EntryDetail /> },
  { path: "/payout/profiles", title: "지급 프로필", element: <Profiles /> },
  { path: "/payout/runs", title: "지급 run", element: <PayoutRuns /> },
  { path: "/payout/runs/:payoutRunId", title: "지급 run 상세", element: <PayoutRunDetail /> },
  { path: "/payout/instructions/:instructionId", title: "지급 지시 상세", element: <InstructionDetail /> },
  { path: "/control", title: "조회 통제", element: <OpsControl /> },
];

/**
 * 개발 도구(가상 PSP·개발 데이터). 개발 서버에서만 넣는다. 운영 빌드에서는 import.meta.env.DEV가 false로 바뀌어
 * 이 화면들의 동적 import가 사라지므로 번들에 포함되지 않는다.
 */
const devRoutes: RouteDef[] = import.meta.env.DEV
  ? (() => {
      const Psp = lazy(() => import("../pages/dev/Psp.tsx").then((m) => ({ default: m.Psp })));
      const DevData = lazy(() => import("../pages/dev/Data.tsx").then((m) => ({ default: m.DevData })));
      const wrap = (n: ReactNode) => <Suspense fallback={<p className="muted">불러오는 중…</p>}>{n}</Suspense>;
      return [
        { path: "/dev/psp", title: "PSP 시뮬레이터", element: wrap(<Psp />) },
        { path: "/dev/data", title: "개발 데이터", element: wrap(<DevData />) },
      ];
    })()
  : [];

/** 조직 공통(권리자 포털·참여 기관): 첫 화면, 담당자 계정(조직 관리자), 연결. */
const orgRoutes: RouteDef[] = [
  { path: "/", title: "내 조직", element: <OrgHome /> },
  { path: "/accounts", title: "담당자 계정", element: <OrgAccountsPage /> },
  { path: "/links", title: "연결", element: <LinksPage /> },
];

export function routesFor(kind: AppKind): RouteDef[] {
  if (kind === "portal") {
    // 권리 테넌트 포털(3부-A, 디자인 가이드 4절): 작품 관리 + 운영 관리. 플랫폼 열람 기록은 두지 않는다. 기존 권리 화면은 이동 링크용으로 남긴다.
    return [...worksRoutes, ...opsRoutesPortal, ...rightsRoutes];
  }
  if (kind === "partner") {
    // 참여 기관 화면(결정 TD12): 권리 등록·정책·발행 화면이 없다.
    return [...orgRoutes, { path: "/trust/works", title: "신탁 작품", element: <TrustWorksPage /> }, { path: "/statements", title: "명세서", element: <Statements /> }];
  }
  return [...opsRoutes, ...rightsRoutes, ...devRoutes];
}

/** 목업의 메뉴 묶음(최종 UI 목업): 포털 ① 권리 등록 ② 정책·상품 ③ 발행·심사, 운영 ⑧ 관제 ⑤ 무결성 ⑥ 정산·재무 ⑦ 관리·감사. */
const catalog: MenuItem[] = [
  { to: "/registry/assets", label: "카탈로그(곡·녹음·슬롯·스템)" }, { to: "/registry/summary", label: "권리 요약" }, { to: "/documents", label: "원천 문서" },
  { to: "/registry/claims", label: "권리 주장" }, { to: "/registry/mandates", label: "위임" }, { to: "/contracts", label: "표준 계약" },
  { to: "/registry/parties", label: "당사자" },
];

/** 매출·정산 화면을 여는 역할(코어가 요구하는 역할과 같다). */
const MONEY = ["SPACE_OPS", "SPACE_SETTLE"];

export function menuFor(kind: AppKind): MenuGroup[] {
  if (kind === "partner") {
    return [
      { title: "홈", items: [{ to: "/", label: "내 조직" }] },
      { title: "① 연결", items: [{ to: "/links", label: "연결·상품 대응" }, { to: "/trust/works", label: "신탁 작품", roles: ["TRUST_OFFICER", "TENANT_ADMIN"] }] },
      { title: "② 정산", items: [{ to: "/statements", label: "명세서", roles: ["TRUST_OFFICER", "TENANT_ADMIN"] }] },
      { title: "설정", items: [{ to: "/accounts", label: "담당자 계정", roles: ["TENANT_ADMIN"] }] },
    ];
  }
  if (kind === "portal") {
    return [
      { title: "홈", items: [{ to: "/", label: "내 조직" }] },
      // 작품 목록이 시작점이다(시안 Catalog). 곡 하나의 권리·스템·계약·분배 규칙·출시는 워크스페이스 탭에서 한다.
      { title: "작품", items: [{ to: "/works", label: "작품 목록" }, { to: "/works/new", label: "새 곡", perm: "rights.edit" }] },
      // 기존 화면은 지우지 않고 테넌트 전체를 가로질러 보는 "모아 보기"로 둔다.
      { title: "모아 보기", items: [
        ...catalog, { to: "/confirmations", label: "확인 요청" }, { to: "/audio", label: "스템 오디오·검수" }, { to: "/registry/disputes", label: "분쟁" },
        { to: "/policy", label: "분배 규칙" }, { to: "/packs", label: "팩" }, { to: "/issues", label: "발행 조합" },
      ] },
      { title: "점검·정산", items: [{ to: "/validation", label: "정합성 점검" }, { to: "/statements", label: "명세·지급" }] },
      { title: "연결", items: [{ to: "/links", label: "신탁·유통 연결" }] },
      { title: "설정", items: [
        { to: "/accounts", label: "담당자 계정", roles: ["TENANT_ADMIN"] }, { to: "/delegation", label: "위임 대행", roles: ["TENANT_ADMIN"] },
        { to: "/inspections", label: "조회 투명성" },
      ] },
    ];
  }
  return [
    { title: "⑧ 관제", items: [{ to: "/", label: "파이프라인 홈" }, { to: "/dashboard", label: "검증 체크리스트", roles: ["SPACE_SETTLE"] }] },
    { title: "⑤ 무결성·신뢰안전", items: [
      { to: "/validation", label: "정합성 점검 큐" }, { to: "/confirmations", label: "확인 요청" }, { to: "/registry/disputes", label: "분쟁" }, { to: "/audio", label: "스템 검수·렌더" },
    ] },
    { title: "권리 등록부(조회)", items: catalog },
    { title: "정책·상품·발행", items: [{ to: "/policy", label: "분배 규칙" }, { to: "/packs", label: "팩" }, { to: "/issues", label: "발행" }] },
    { title: "⑥ 정산·재무", items: [
      { to: "/revenue", label: "매출·이상거래", roles: MONEY }, { to: "/hub", label: "연동 허브", roles: MONEY }, { to: "/revenue/traffic", label: "감상 수익 풀", roles: MONEY },
      { to: "/settlement/batches", label: "정산 배치", roles: MONEY }, { to: "/settlement/quarantine", label: "격리", roles: MONEY }, { to: "/settlement/holds", label: "보류", roles: MONEY },
      { to: "/ledger", label: "원장", roles: ["SPACE_SETTLE"] }, { to: "/payout/profiles", label: "지급 프로필", roles: ["SPACE_SETTLE"] }, { to: "/payout/runs", label: "지급", roles: ["SPACE_SETTLE"] },
      { to: "/statements", label: "명세서", roles: ["SPACE_SETTLE"] },
    ] },
    { title: "⑦ 관리·감사", items: [
      { to: "/admin/tenants", label: "권리 테넌트", roles: ["SPACE_OPS", "ONBOARDING"] }, { to: "/admin/participants", label: "참여 기관", roles: ["SPACE_OPS", "ONBOARDING"] },
      { to: "/admin/people", label: "개인 계정", roles: ["SPACE_OPS", "ONBOARDING"] }, { to: "/admin/links", label: "연결", roles: ["SPACE_OPS", "ONBOARDING"] },
      { to: "/admin/staff", label: "운영 인력", roles: ["SPACE_OPS"] }, { to: "/control", label: "조회 통제·break-glass" },
    ] },
    ...(import.meta.env.DEV ? [{ title: "개발 도구", items: [{ to: "/dev/psp", label: "PSP 시뮬레이터" }, { to: "/dev/data", label: "개발 데이터" }] }] : []),
  ];
}

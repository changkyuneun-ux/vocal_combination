import { lazy, Suspense, type ReactNode } from "react";
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
import { PortalHome } from "../pages/portal/Home.tsx";
import type { AppKind } from "./apps.ts";

export function Placeholder({ title }: { title: string }) {
  return <Section title={title}><p className="muted">준비 중</p></Section>;
}

export type RouteDef = { path: string; title: string; element: ReactNode };
export type MenuItem = { to: string; label: string };
export type MenuGroup = { title: string; items: MenuItem[] };


/** 두 앱이 함께 쓰는 권리 화면(등록·정책·팩·발행 조회·명세). 포털에서는 RLS로 자기 테넌트 데이터만 보인다. */
const rightsRoutes: RouteDef[] = [
  { path: "/registry/parties", title: "당사자", element: <Parties /> },
  { path: "/registry/assets", title: "곡·녹음·슬롯·스템·보이스", element: <Assets /> },
  { path: "/registry/claims", title: "권리 주장", element: <Claims /> },
  { path: "/registry/mandates", title: "위임", element: <Mandates /> },
  { path: "/registry/disputes", title: "분쟁", element: <Disputes /> },
  { path: "/policy", title: "정책", element: <Policies /> },
  { path: "/policy/:policyId", title: "정책 상세", element: <PolicyDetail /> },
  { path: "/packs", title: "팩", element: <Packs /> },
  { path: "/packs/:packId", title: "팩 상세", element: <PackDetail /> },
  { path: "/issues", title: "발행", element: <Issues /> },
  { path: "/issues/:snapshotId", title: "발행 상세", element: <IssueDetail /> },
  { path: "/statements", title: "명세서", element: <Statements /> },
];

/** 운영 백오피스 전용(매출·정산·원장·지급). 권리자 포털에는 없다. */
const opsRoutes: RouteDef[] = [
  { path: "/", title: "대시보드", element: <Dashboard /> },
  { path: "/revenue", title: "매출", element: <Revenue /> },
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

export function routesFor(kind: AppKind): RouteDef[] {
  return kind === "portal"
    ? [{ path: "/", title: "내 테넌트", element: <PortalHome /> }, ...rightsRoutes]
    : [...opsRoutes, ...rightsRoutes, ...devRoutes];
}

const registryMenu: MenuGroup = { title: "1 등록부", items: [
  { to: "/registry/parties", label: "당사자" }, { to: "/registry/assets", label: "곡·녹음·슬롯·스템·보이스" },
  { to: "/registry/claims", label: "권리 주장" }, { to: "/registry/mandates", label: "위임" }, { to: "/registry/disputes", label: "분쟁" },
] };

export function menuFor(kind: AppKind): MenuGroup[] {
  if (kind === "portal") {
    return [
      { title: "0 내 테넌트", items: [{ to: "/", label: "내 테넌트" }] },
      registryMenu,
      { title: "2 정책", items: [{ to: "/policy", label: "정책" }] },
      { title: "3 팩", items: [{ to: "/packs", label: "팩" }] },
      { title: "4 발행", items: [{ to: "/issues", label: "발행 조회" }] },
      { title: "5 명세", items: [{ to: "/statements", label: "명세서" }] },
    ];
  }
  return [
    { title: "0 대시보드", items: [{ to: "/", label: "대시보드" }] },
    registryMenu,
    { title: "2 정책", items: [{ to: "/policy", label: "정책" }] },
    { title: "3 팩", items: [{ to: "/packs", label: "팩" }] },
    { title: "4 발행", items: [{ to: "/issues", label: "발행" }] },
    { title: "5 매출", items: [{ to: "/revenue", label: "매출" }] },
    { title: "6 정산", items: [
      { to: "/settlement/batches", label: "정산 배치" }, { to: "/settlement/quarantine", label: "격리" }, { to: "/settlement/holds", label: "보류" },
    ] },
    { title: "7 원장", items: [{ to: "/ledger", label: "원장" }] },
    { title: "8 지급", items: [
      { to: "/payout/profiles", label: "지급 프로필" }, { to: "/payout/runs", label: "지급 run" }, { to: "/statements", label: "명세서" },
    ] },
    ...(import.meta.env.DEV ? [{ title: "9 개발 도구", items: [{ to: "/dev/psp", label: "PSP 시뮬레이터" }, { to: "/dev/data", label: "개발 데이터" }] }] : []),
  ];
}

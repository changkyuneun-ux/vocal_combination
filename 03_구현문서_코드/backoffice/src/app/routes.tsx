import type { ReactNode } from "react";
import { Dashboard } from "../pages/dashboard/Dashboard.tsx";
import { Section } from "../components/Section.tsx";

export function Placeholder({ title }: { title: string }) {
  return <Section title={title}><p className="muted">준비 중</p></Section>;
}

export type RouteDef = { path: string; title: string; element: ReactNode };
export type MenuItem = { to: string; label: string };
export type MenuGroup = { title: string; items: MenuItem[] };

const p = (path: string, title: string): RouteDef => ({ path, title, element: <Placeholder title={title} /> });

export const routes: RouteDef[] = [
  { path: "/", title: "대시보드", element: <Dashboard /> },
  p("/registry/parties", "당사자"),
  p("/registry/assets", "곡·녹음·슬롯·스템·보이스"),
  p("/registry/claims", "권리 주장"),
  p("/registry/mandates", "위임"),
  p("/registry/disputes", "분쟁"),
  p("/policy", "정책"),
  p("/policy/:policyId", "정책 상세"),
  p("/packs", "팩"),
  p("/packs/:packId", "팩 상세"),
  p("/issues", "발행"),
  p("/issues/:snapshotId", "발행 상세"),
  p("/revenue", "매출"),
  p("/settlement/batches", "정산 배치"),
  p("/settlement/batches/:batchId", "정산 배치 상세"),
  p("/settlement/runs/:runId", "정산 run 상세"),
  p("/settlement/quarantine", "격리"),
  p("/settlement/holds", "보류"),
  p("/ledger", "원장"),
  p("/ledger/entries/:entryId", "분개 상세"),
  p("/payout/profiles", "지급 프로필"),
  p("/payout/runs", "지급 run"),
  p("/payout/runs/:payoutRunId", "지급 run 상세"),
  p("/payout/instructions/:instructionId", "지급 지시 상세"),
  p("/statements", "명세서"),
  p("/dev/psp", "PSP 시뮬레이터"),
  p("/dev/data", "개발 데이터"),
];

export const menu: MenuGroup[] = [
  { title: "0 대시보드", items: [{ to: "/", label: "대시보드" }] },
  { title: "1 등록부", items: [
    { to: "/registry/parties", label: "당사자" }, { to: "/registry/assets", label: "곡·녹음·슬롯·스템·보이스" },
    { to: "/registry/claims", label: "권리 주장" }, { to: "/registry/mandates", label: "위임" }, { to: "/registry/disputes", label: "분쟁" },
  ] },
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
  { title: "9 개발 도구", items: [{ to: "/dev/psp", label: "PSP 시뮬레이터" }, { to: "/dev/data", label: "개발 데이터" }] },
];

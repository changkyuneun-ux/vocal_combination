import type { OrgClass, Role } from "./actor.ts";

/**
 * 기능 단위 권한(총괄 운영과 권한 구조, 결정 RD4). 코어의 검사 한 곳 = (모듈, 행위) 하나 = 권한 하나.
 * 이 목록이 권한의 원본이고 migrations/0039_rbac.sql이 같은 내용을 permission 표에 넣는다(test/platform/rbac.test.ts가 대조).
 * 역할–권한 매핑은 DB가 원본이다. legacy는 0039가 시드한 지금 역할의 매핑으로, 대조 시험에만 쓴다.
 * kind: decide = 권리 결정(권리자만), view = 조회, intervene = 플랫폼 개입(멈춤·보류·재처리), admin = 관리, system = 시스템 신원·대행 전용.
 * assignable = false인 권한은 사람 역할에 넣지 않는다(시스템 신원·팬 대행 발행).
 */
export type PermKind = "decide" | "view" | "intervene" | "admin" | "system";
type Def = { area: string; kind: PermKind; orgClasses: readonly OrgClass[]; legacy: readonly Role[]; assignable: boolean; description: string };
const P = "PLATFORM", R = "RIGHTS", A = "PARTICIPANT", I = "INDIVIDUAL";
const d = (area: string, kind: PermKind, orgClasses: readonly OrgClass[], legacy: readonly Role[], description: string, assignable = true): Def =>
  ({ area, kind, orgClasses, legacy, assignable, description });

export const PERMISSIONS = {
  // ⑥ 정산·재무
  "ledger.view": d("⑥", "view", [P], ["SPACE_SETTLE"], "원장·시산표·권리자 명세 조회"),
  "settlement.view": d("⑥", "view", [P], ["SPACE_OPS", "SPACE_SETTLE"], "정산 배치·run·격리·보류 조회"),
  "settlement.batch_create": d("⑥", "intervene", [P], ["SPACE_OPS"], "정산 배치 만들기"),
  "settlement.operate": d("⑥", "intervene", [P], ["SPACE_SETTLE"], "run 무효·재처리, 보류·격리 해제, 불변식 점검"),
  "settlement.confirm": d("⑥", "intervene", [P], ["SPACE_SETTLE"], "정산 배치 확정"),
  "payout.view": d("⑥", "view", [P], ["SPACE_SETTLE"], "지급 run·지시·지급 정보 조회"),
  "payout.run": d("⑥", "intervene", [P], ["SPACE_SETTLE"], "지급 실행·재지시"),
  "payout.profile_set": d("⑥", "intervene", [P], ["SPACE_SETTLE"], "지급 정보(계좌 토큰·세금·KYC) 등록"),
  "revenue.view": d("⑥", "view", [P], ["SPACE_OPS", "SPACE_SETTLE", "SYSTEM"], "매출 이벤트 조회"),
  "revenue.ingest": d("⑥", "system", [P], ["SYSTEM"], "매출 수집(시스템 신원)", false),
  "traffic.view": d("⑥", "view", [P], ["SPACE_OPS", "SPACE_SETTLE"], "감상 수익 풀 조회"),
  "traffic.manage": d("⑥", "intervene", [P], ["SPACE_SETTLE"], "감상 수익 풀 등록·배정"),
  "hub.view": d("⑥", "view", [P], ["SPACE_OPS", "SPACE_SETTLE"], "연동 허브 파일·거부 큐 조회"),
  "hub.operate": d("⑥", "intervene", [P], ["SPACE_OPS"], "연동 허브 재처리·상품 대응"),
  // ⑤ 무결성·신뢰안전
  "audio.review": d("⑤", "intervene", [P], ["SPACE_OPS"], "스템 오디오 검토·참조 음원 등록·렌더 검증"),
  "validation.request_accept": d("⑤", "intervene", [P], ["SPACE_OPS"], "정합성 이슈 위험 수용 요청"),
  "validation.accept": d("⑤", "intervene", [P], ["COMPLIANCE"], "정합성 이슈 위험 수용 승인·기각"),
  "validation.operate": d("⑤", "intervene", [P], ["SPACE_OPS"], "정합성 차단 적용 설정·정기 검사"),
  "confirmation.platform_verify": d("⑤", "intervene", [P], ["SPACE_OPS"], "확인 요청 원문 대조 확인"),
  "document.dispose": d("⑤", "intervene", [P], ["SPACE_OPS"], "원천 문서 폐기"),
  // ⑦ 관리·감사
  "audit.view": d("⑦", "view", [P, R, A], ["SPACE_OPS", "SPACE_SETTLE", "RIGHTS_EDITOR", "ONBOARDING", "COMPLIANCE", "TENANT_ADMIN"], "감사 로그 조회"),
  "inspection.unmask": d("⑦", "admin", [P], ["SPACE_SETTLE"], "계좌 토큰 마스킹 해제(사유)"),
  "breakglass.open": d("⑦", "admin", [P], ["SPACE_OPS"], "break-glass 열기"),
  "tenant.onboard": d("⑦", "admin", [P], ["SPACE_OPS", "ONBOARDING"], "조직 등록·정보·확인 항목·활성화, 당사자 이관, 독립 아티스트 온보딩"),
  "tenant.suspend": d("⑦", "admin", [P], ["SPACE_OPS", "COMPLIANCE"], "조직 정지·해지·재개"),
  "staff.manage": d("⑦", "admin", [P], ["SPACE_OPS"], "운영 인력 계정·잠금"),
  "account.onboard": d("⑦", "admin", [P], ["SPACE_OPS", "ONBOARDING"], "개인 계정과 조직의 첫 관리자 발급"),
  "account.manage": d("⑦", "admin", [R, A], ["TENANT_ADMIN"], "자기 조직 담당자 계정·역할·잠금"),
  "delegation.act": d("⑦", "admin", [P], ["ONBOARDING"], "위임받은 테넌트 업무 대행"),
  "delegation.set": d("⑦", "admin", [R], ["TENANT_ADMIN"], "플랫폼에 맡길 업무 정하기"),
  "org.view_while_inactive": d("⑦", "view", [R, A], ["TENANT_ADMIN"], "신청·정지 상태 조직에 열람으로 로그인"),
  "legal.template": d("⑦", "admin", [P], ["LEGAL"], "계약·분배 규칙 표준 템플릿 작성·승인"),
  "party.register_platform": d("①", "admin", [P], ["ONBOARDING", "RIGHTS_EDITOR"], "플랫폼 위탁 당사자 등록"),
  // ① 권리 등록
  "rights.edit": d("①", "decide", [R], ["RIGHTS_EDITOR"], "곡·녹음·스템·권리 주장·위임·원천 문서 등록"),
  "consent.record": d("①", "decide", [R], ["RIGHTS_EDITOR"], "계약서 기반 이용허락 동의 기록·철회"),
  "contract.draft": d("①", "decide", [R], ["RIGHTS_EDITOR"], "표준 계약 작성"),
  "contract.sign_org": d("①", "decide", [R], ["RIGHTS_EDITOR"], "자기 테넌트 당사자로 계약 서명"),
  "link.decide": d("①", "decide", [R], ["RIGHTS_EDITOR", "TENANT_ADMIN"], "권리 테넌트 쪽 연결·상품 대응 제안·확인"),
  "link.decide_platform": d("①", "intervene", [P], ["ONBOARDING", "SPACE_OPS"], "플랫폼 쪽 연결 제안·확인(위탁 당사자)"),
  "link.decide_trust": d("①", "decide", [A], ["TRUST_OFFICER", "TENANT_ADMIN"], "신탁단체 쪽 연결 제안·확인"),
  "link.decide_partner": d("①", "decide", [A], ["PARTNER_INTEGRATION", "TENANT_ADMIN"], "유통 파트너 쪽 연결 제안·확인"),
  "asset.propose": d("①", "intervene", [A], ["PARTNER_INTEGRATION", "TENANT_ADMIN"], "유통 파트너의 상품 대응 제안"),
  // ② 정책·팩
  "pack.edit": d("②", "decide", [R], ["RIGHTS_EDITOR"], "팩 만들기·청구권자 선언"),
  "pack.activate": d("②", "decide", [R], ["ACTIVATOR"], "팩 활성화"),
  "policy.edit": d("②", "decide", [R], ["EDITOR"], "분배 규칙 작성·컴파일"),
  "policy.approve": d("②", "decide", [R], ["WORK_APPROVER"], "분배 규칙 승인"),
  "policy.activate": d("②", "decide", [R], ["ACTIVATOR"], "분배 규칙 활성화·재고정"),
  // ③ 발행
  "issuance.issue": d("③", "system", [I], ["ISSUER"], "조합 발행(팬 대행)", false),
  // ④ 실연자 본인
  "performer.self": d("④", "decide", [I], ["PERFORMER"], "본인 동의·서명·철회, 실연자 채널"),
} as const satisfies Record<string, Def>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

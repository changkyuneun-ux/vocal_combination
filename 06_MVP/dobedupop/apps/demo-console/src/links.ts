export type App = "portal" | "artist" | "ops" | "partner";
/** 데모 진행판에서 다른 앱을 여는 주소: demo.<기본 도메인> → portal·artist·ops·partner.<기본 도메인>, 페르소나로 바로 로그인(?persona=). */
export function appUrl(loc: { protocol: string; hostname: string; port: string }, app: App, persona?: string, path = "/"): string {
  const base = loc.hostname.startsWith("demo.") ? loc.hostname.slice(5) : loc.hostname;
  const port = loc.port ? `:${loc.port}` : "";
  return `${loc.protocol}//${app}.${base}${port}${path}${persona ? `?persona=${encodeURIComponent(persona)}` : ""}`;
}

export type Persona = { userId: string; name: string; app: App; what: string };
export const PERSONAS: Persona[] = [
  { userId: "usr_bh_admin", name: "빅히트 관리자", app: "portal", what: "담당자 계정 초대·역할, 위임 대행 설정, 우리 조직 상태"},
  { userId: "usr_bh_rights", name: "빅히트 권리 편집", app: "portal", what: "곡·녹음·스템 등록, 권리 주장, 계약서·표준 계약, 명세" },
  { userId: "usr_bh_policy", name: "빅히트 정책 편집", app: "portal", what: "분배 규칙 작성" },
  { userId: "usr_bh_approver", name: "빅히트 승인", app: "portal", what: "분배 규칙 승인" },
  { userId: "usr_bh_activator", name: "빅히트 활성화", app: "portal", what: "정책·팩 활성화" },
  { userId: "usr_member_jungkook", name: "정국", app: "artist", what: "본인 인증·확인·동의·계약 서명, 사용 이력, 기여분" },
  { userId: "usr_member_jin", name: "진", app: "artist", what: "진이 정국·지민 파트까지 부른 조합" },
  { userId: "usr_ops", name: "운영(관제)", app: "ops", what: "⑧ 관제, 테넌트, 정산 실행, 확인 요청" },
  { userId: "usr_settle", name: "정산 담당", app: "ops", what: "정산 확정, 지급 실행" },
  { userId: "usr_rights", name: "플랫폼 온보딩 담당", app: "ops", what: "조직 등록·확인 항목·상태, 첫 관리자, 당사자 등록, 해외 작가 계약, 신탁 연결 제안" },
  { userId: "usr_cmo_admin", name: "가상 신탁단체 관리자", app: "partner", what: "신탁 연결 확인, 신탁 작품, 명세(참여 기관 화면)" },
  { userId: "usr_compliance", name: "컴플라이언스", app: "ops", what: "위험 수용 승인" },
];

/** 단계별로 보여 줄 화면과 페르소나. */
export const STEP_VIEW: Record<string, { app: App; persona: string; path?: string; label: string }[]> = {
  onboard: [{ app: "ops", persona: "usr_rights", label: "운영: 빅히트 뮤직(상태·확인 항목·계정)", path: "/admin/orgs/tnt_bighit" }, { app: "ops", persona: "usr_rights", label: "운영: 참여 기관", path: "/admin/participants" },
    { app: "portal", persona: "usr_bh_admin", label: "포털: 담당자 계정(빅히트 관리자)", path: "/accounts" }, { app: "partner", persona: "usr_cmo_admin", label: "참여 기관: 가상 신탁단체" }],
  register: [{ app: "portal", persona: "usr_bh_rights", label: "포털: 곡·녹음·스템", path: "/registry/assets" }, { app: "portal", persona: "usr_bh_rights", label: "포털: 원천 문서", path: "/documents" }],
  claims: [{ app: "portal", persona: "usr_bh_rights", label: "포털: 권리 요약", path: "/registry/summary" }, { app: "portal", persona: "usr_bh_rights", label: "포털: 확인 요청", path: "/confirmations" }],
  members: [{ app: "artist", persona: "usr_member_jungkook", label: "실연자 앱(정국)" }],
  contracts: [{ app: "portal", persona: "usr_bh_rights", label: "포털: 표준 계약", path: "/contracts" }, { app: "artist", persona: "usr_member_jungkook", label: "실연자 앱(정국)" }],
  "ops-verify": [{ app: "ops", persona: "usr_ops", label: "운영: 확인 요청", path: "/confirmations" }, { app: "ops", persona: "usr_rights", label: "운영: 빅히트 활성", path: "/admin/orgs/tnt_bighit" },
    { app: "partner", persona: "usr_cmo_admin", label: "참여 기관: 신탁 연결 확인", path: "/links" }],
  policy: [{ app: "portal", persona: "usr_bh_policy", label: "포털: 분배 규칙(정책 편집)", path: "/policy" }, { app: "portal", persona: "usr_bh_rights", label: "포털: 정합성 점검", path: "/validation" }],
  fans: [{ app: "ops", persona: "usr_ops", label: "운영: ⑧ 관제(발행·거부)" }, { app: "portal", persona: "usr_bh_rights", label: "포털: 발행 조합", path: "/issues" }],
  settle: [{ app: "ops", persona: "usr_settle", label: "운영: 정산 배치", path: "/settlement/batches" }, { app: "ops", persona: "usr_ops", label: "운영: ⑧ 관제" }],
  payout: [{ app: "ops", persona: "usr_settle", label: "운영: 지급", path: "/payout/runs" }, { app: "portal", persona: "usr_bh_rights", label: "포털: 명세", path: "/statements" }, { app: "artist", persona: "usr_member_jungkook", label: "실연자 앱: 수익", path: "/" }],
};

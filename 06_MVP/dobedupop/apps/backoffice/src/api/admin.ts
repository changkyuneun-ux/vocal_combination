/**
 * 조직·계정 온보딩 화면용 타입·이름·규칙(테넌트 정책 00_프로젝트_개요/테넌트_관리_기준과_정책_20261019.md).
 * 참여 구분: 권리 테넌트(RIGHTS) · 참여 기관(PARTICIPANT) · 개인(INDIVIDUAL) · 플랫폼 운영(PLATFORM).
 */
export type OrgClass = "RIGHTS" | "PARTICIPANT" | "INDIVIDUAL" | "PLATFORM";
export type TenantRow = {
  tenantId: string; tenantType: string; orgClass: OrgClass; name: string; status: string; createdAt: string; validationEnforced: boolean;
  users: number; parties: number; businessNo: string | null; country: string | null;
};
export type TenantDetail = {
  tenantId: string; tenantType: string; orgClass: OrgClass; name: string; status: string; createdAt: string; statusChangedAt: string | null; statusReason: string | null;
  businessNo: string | null; country: string | null; representative: string | null; validationEnforced: boolean;
  checks: { item: string; checkedBy: string; checkedAt: string; note: string | null; documentId: string | null }[];
  required: { VERIFIED: string[]; ACTIVE: string[] } | null; next: string[];
};
export type AccountRow = {
  userId: string; displayName: string; roles: string[]; tenantId: string; tenantName: string; partyId: string | null;
  disabled: boolean; hasPassword: boolean; totpEnabled: boolean; identityVerified: boolean; lastLoginAt: string | null;
  homeMembership?: boolean; memberships?: number;
};
export type Membership = { tenantId: string; name: string; tenantType: string; orgClass: OrgClass; status: string; home: boolean; roles: string[] };
export type Me = {
  userId: string; displayName: string; roles: string[]; tenantId: string; tenantType?: string; orgClass?: OrgClass; tenantStatus?: string; scope: string;
  readOnly?: boolean; partyId?: string; memberships?: Membership[]; actingOnBehalfOf?: string;
};
export type CreatedAccount = { userId: string; login: "PASSWORD" | "OTP"; inviteToken?: string; inviteExpiresAt?: string };
export type LinkRow = {
  linkId: string; linkType: "TRUST" | "DISTRIBUTION"; participantTenantId: string; participantName: string; authorPartyId: string | null; authorName: string | null;
  payeePartyId: string | null; rightsTenantId: string | null; rightsTenantName: string | null; memberRef: string | null; validFrom: string; validTo: string | null;
  status: string; proposedSide: "RIGHTS" | "PARTICIPANT"; proposedBy: string; proposedAt: string; decidedBy: string | null; decidedAt: string | null;
  declineReason: string | null; endedAt: string | null; endReason: string | null;
};
export type AssetMapping = { partnerTenantId: string; partnerName: string; externalId: string; vcId: string; status: string; createdAt: string; decidedAt: string | null; ownerTenantId: string | null };
export type OrgRef = { tenantId: string; name: string; tenantType: string };

export const PLATFORM = "tnt_platform";
export const PERSONAL = "tnt_platform_default";

export const RIGHTS_TYPES: [string, string][] = [["LABEL", "레이블"], ["AGENCY", "기획사·소속사"], ["PUBLISHER", "음악 출판사"], ["INDEPENDENT_ARTIST", "독립 아티스트(1인)"]];
export const PARTICIPANT_TYPES: [string, string][] = [["CMO", "신탁단체"], ["B2B_PARTNER", "유통 파트너"]];
export const TENANT_TYPES: [string, string][] = [...RIGHTS_TYPES, ...PARTICIPANT_TYPES];
export const TENANT_TYPE_LABEL: Record<string, string> = { ...Object.fromEntries(TENANT_TYPES), PLATFORM_OPS: "플랫폼 운영", PLATFORM_DEFAULT: "개인(실연자·팬)" };
export const ORG_CLASS_LABEL: Record<OrgClass, string> = { RIGHTS: "권리 테넌트", PARTICIPANT: "참여 기관", INDIVIDUAL: "개인", PLATFORM: "플랫폼 운영" };

export const STATUS_LABEL: Record<string, string> = { APPLIED: "신청", VERIFIED: "확인됨", ACTIVE: "활성", SUSPENDED: "정지", TERMINATED: "해지" };
export const STATUS_TONE: Record<string, "ok" | "info" | "warn" | "bad" | "muted"> = { APPLIED: "info", VERIFIED: "info", ACTIVE: "ok", SUSPENDED: "warn", TERMINATED: "bad" };
/** 상태가 무엇을 허용하는지(7절 표). */
export const STATUS_MEANS: Record<string, string> = {
  APPLIED: "관리자 1명만 열람으로 로그인합니다. 확인 서류를 받는 단계입니다.",
  VERIFIED: "로그인·권리 등록(참여 기관은 연결 요청)이 됩니다. 팩·정책 활성화와 판매는 아직 안 됩니다.",
  ACTIVE: "모든 업무가 됩니다(등록·활성화·판매·정산·지급).",
  SUSPENDED: "관리자만 열람으로 로그인합니다. 판매가 멈추고 지급이 보류됩니다(정산은 계속 계산).",
  TERMINATED: "로그인할 수 없습니다. 연결이 끝나고 미정산분까지 마감합니다.",
};
export const CHECK_LABEL: Record<string, string> = {
  BUSINESS_ID: "사업자 확인", IDENTITY: "본인 확인", REPRESENTATIVE: "대표자 확인", PLATFORM_AGREEMENT: "플랫폼 이용(참여) 계약 서명",
  RIGHTS_EVIDENCE: "권리 보유 증빙(녹음·퍼블리싱 계약 원문)", TRUST_LICENSE: "신탁 허가(저작권 신탁관리업)", DISTRIBUTION_AGREEMENT: "유통 계약",
};

export const ROLE_LABEL: Record<string, string> = {
  TENANT_ADMIN: "조직 관리자", RIGHTS_EDITOR: "권리 편집", EDITOR: "정책 편집", WORK_APPROVER: "정책 승인", ACTIVATOR: "활성화", ISSUER: "발행",
  TRUST_OFFICER: "신탁 담당", PARTNER_INTEGRATION: "연동 담당",
  SPACE_OPS: "운영", SPACE_SETTLE: "정산", ONBOARDING: "온보딩", COMPLIANCE: "컴플라이언스", LEGAL: "법무", PERFORMER: "실연자", SYSTEM: "시스템",
};
/** 조직 종류마다 줄 수 있는 역할(코어 assignableRoles와 같다). 운영 계정에는 권리 결정 역할이 없다(결정 TD3). */
export function rolesFor(orgClass: OrgClass, tenantType = ""): string[] {
  switch (orgClass) {
    case "RIGHTS": return ["TENANT_ADMIN", "RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR"];
    case "PARTICIPANT": return tenantType === "CMO" ? ["TENANT_ADMIN", "TRUST_OFFICER"] : ["TENANT_ADMIN", "PARTNER_INTEGRATION"];
    case "INDIVIDUAL": return ["PERFORMER"];
    case "PLATFORM": return ["SPACE_OPS", "SPACE_SETTLE", "ONBOARDING", "COMPLIANCE", "LEGAL"];
  }
}
export function classOf(tenantId: string, rows: { tenantId: string; orgClass: OrgClass }[] = []): OrgClass {
  if (tenantId === PLATFORM) return "PLATFORM";
  if (tenantId === PERSONAL) return "INDIVIDUAL";
  return rows.find((t) => t.tenantId === tenantId)?.orgClass ?? "RIGHTS";
}

/**
 * 초대 링크: 권리 테넌트 계정은 권리자 포털, 참여 기관 계정은 참여 기관 화면, 플랫폼 계정은 운영 백오피스에서 비밀번호를 정한다.
 * 서브도메인 배포(ops.<도메인> 등)면 그 앱의 서브도메인, 개발 서버(한 호스트)면 /portal/·/partner/.
 */
export function inviteUrl(loc: { protocol: string; hostname: string; port: string; origin: string }, token: string, orgClass: OrgClass): string {
  const app = orgClass === "PLATFORM" ? "ops" : orgClass === "PARTICIPANT" ? "partner" : "portal";
  const q = `?invite=${encodeURIComponent(token)}`;
  const sub = /^(ops|portal|partner)\./.exec(loc.hostname);
  if (sub) {
    const host = `${app}.${loc.hostname.slice(sub[0].length)}`;
    return `${loc.protocol}//${host}${loc.port ? `:${loc.port}` : ""}/${q}`;
  }
  return `${loc.origin}${app === "ops" ? "/" : `/${app}/`}${q}`;
}

/** 로그인 준비 상태(사람이 읽는 말). */
export function loginState(a: AccountRow): { text: string; tone: "ok" | "warn" | "muted" | "bad" } {
  if (a.disabled) return { text: "잠김", tone: "bad" };
  if (a.roles.includes("PERFORMER") || a.tenantId === PERSONAL) return a.identityVerified ? { text: "본인 인증 완료", tone: "ok" } : { text: "본인 인증 전", tone: "warn" };
  if (!a.hasPassword) return { text: "초대 수락 대기", tone: "warn" };
  if (a.tenantId === PLATFORM && !a.totpEnabled) return { text: "인증 앱 등록 전", tone: "warn" };
  return { text: a.totpEnabled ? "비밀번호 + 인증 앱" : "비밀번호", tone: "ok" };
}

export const LINK_STATUS_LABEL: Record<string, string> = { PROPOSED: "확인 대기", ACTIVE: "활성", DECLINED: "거절", ENDED: "종료" };
export const LINK_TYPE_LABEL: Record<string, string> = { TRUST: "신탁 연결", DISTRIBUTION: "유통 연결" };

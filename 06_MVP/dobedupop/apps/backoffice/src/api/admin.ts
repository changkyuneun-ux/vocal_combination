/** 온보딩(테넌트·계정) 화면용 타입·이름·초대 링크. */
export type TenantRow = {
  tenantId: string; tenantType: string; name: string; status: string; createdAt: string; validationEnforced: boolean; users: number; parties: number;
};
export type AccountRow = {
  userId: string; displayName: string; roles: string[]; tenantId: string; tenantName: string; partyId: string | null;
  disabled: boolean; hasPassword: boolean; totpEnabled: boolean; identityVerified: boolean; lastLoginAt: string | null;
};
export type CreatedAccount = { userId: string; login: "PASSWORD" | "OTP"; inviteToken?: string; inviteExpiresAt?: string };

export const PLATFORM = "tnt_platform";
export const PERSONAL = "tnt_platform_default";

export const TENANT_TYPES: [string, string][] = [["LABEL", "레이블"], ["AGENCY", "기획사·소속사"], ["PUBLISHER", "음악 출판사"], ["CMO", "신탁단체"], ["B2B_PARTNER", "유통 파트너"]];
export const TENANT_TYPE_LABEL: Record<string, string> = { ...Object.fromEntries(TENANT_TYPES), PLATFORM_OPS: "플랫폼 운영", PLATFORM_DEFAULT: "개인(실연자·팬)" };

export const ROLE_LABEL: Record<string, string> = {
  RIGHTS_EDITOR: "권리 편집", EDITOR: "정책 편집", WORK_APPROVER: "정책 승인", ACTIVATOR: "활성화", ISSUER: "발행",
  SPACE_OPS: "운영", SPACE_SETTLE: "정산", COMPLIANCE: "컴플라이언스", LEGAL: "법무", PERFORMER: "실연자", SYSTEM: "시스템",
};
/** 테넌트 종류별로 줄 수 있는 역할. 권리 결정 역할은 권리자 테넌트, 운영 역할은 플랫폼만. */
export function rolesFor(tenantId: string): string[] {
  if (tenantId === PERSONAL) return ["PERFORMER"];
  if (tenantId === PLATFORM) return ["SPACE_OPS", "SPACE_SETTLE", "COMPLIANCE", "LEGAL", "RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR", "ISSUER"];
  return ["RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR", "ISSUER"];
}

/**
 * 초대 링크: 권리자 테넌트 계정은 권리자 포털, 플랫폼 계정은 운영 백오피스에서 비밀번호를 정한다.
 * 서브도메인 배포(ops.<도메인>)면 portal.<도메인>, 개발 서버(한 호스트)면 /portal/.
 */
export function inviteUrl(loc: { protocol: string; hostname: string; port: string; origin: string }, token: string, tenantId: string): string {
  const portal = tenantId !== PLATFORM;
  const q = `?invite=${encodeURIComponent(token)}`;
  if (loc.hostname.startsWith("ops.")) {
    const host = portal ? `portal.${loc.hostname.slice(4)}` : loc.hostname;
    return `${loc.protocol}//${host}${loc.port ? `:${loc.port}` : ""}/${q}`;
  }
  return `${loc.origin}${portal ? "/portal/" : "/"}${q}`;
}

/** 로그인 준비 상태(사람이 읽는 말). */
export function loginState(a: AccountRow): { text: string; tone: "ok" | "warn" | "muted" | "bad" } {
  if (a.disabled) return { text: "잠김", tone: "bad" };
  if (a.roles.includes("PERFORMER") || a.tenantId === PERSONAL) return a.identityVerified ? { text: "본인 인증 완료", tone: "ok" } : { text: "본인 인증 전", tone: "warn" };
  if (!a.hasPassword) return { text: "초대 수락 대기", tone: "warn" };
  if (a.tenantId === PLATFORM && !a.totpEnabled) return { text: "인증 앱 등록 전", tone: "warn" };
  return { text: a.totpEnabled ? "비밀번호 + 인증 앱" : "비밀번호", tone: "ok" };
}

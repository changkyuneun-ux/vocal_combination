/**
 * 웹 앱 세 개(다음 작업 6, 테넌트 정책 결정 TD12): 운영 백오피스(ops), 권리자 포털(portal), 참여 기관 화면(partner — 신탁단체·유통 파트너).
 * 같은 코드베이스에서 화면·메뉴·API 채널만 다르다.
 * - 빌드는 VITE_APP=ops | portal | partner로 각각 만든다.
 * - 개발 서버는 하나로 셋을 같이 띄운다: /portal 아래는 포털, /partner 아래는 참여 기관 화면, 나머지는 운영 백오피스.
 * - MVP 서브도메인 배포(portal.·partner.dobedupop.*)는 앱을 루트에 둔다: VITE_PORTAL_BASE=/ · VITE_PARTNER_BASE=/ 로 빌드한다.
 */
const portalBase = (import.meta.env?.VITE_PORTAL_BASE as string | undefined) ?? "/portal";
const partnerBase = (import.meta.env?.VITE_PARTNER_BASE as string | undefined) ?? "/partner";
export type AppKind = "ops" | "portal" | "partner";

export const APPS: Record<AppKind, { name: string; basename: string; channel: string }> = {
  ops: { name: "dobedupop · 운영 백오피스", basename: "", channel: "ops" },
  portal: { name: "dobedupop · 권리자 포털", basename: portalBase === "/" ? "" : portalBase, channel: "portal" },
  partner: { name: "dobedupop · 참여 기관", basename: partnerBase === "/" ? "" : partnerBase, channel: "partner" },
};

/** 빌드가 정한 앱(VITE_APP)이 있으면 그것, 없으면(개발 서버) 경로로 정한다. */
export function appKind(pathname: string, built: string | undefined): AppKind {
  if (built === "ops" || built === "portal" || built === "partner") return built;
  if (pathname === "/portal" || pathname.startsWith("/portal/")) return "portal";
  if (pathname === "/partner" || pathname.startsWith("/partner/")) return "partner";
  return "ops";
}

function browserPath(): string {
  return typeof location === "undefined" ? "/" : location.pathname;
}

/** 지금 실행 중인 앱. */
export function currentApp(): AppKind {
  return appKind(browserPath(), import.meta.env.VITE_APP as string | undefined);
}

/**
 * 웹 앱 두 개(다음 작업 6): 운영 백오피스(ops)와 권리자 포털(portal). 같은 코드베이스에서 화면·메뉴·API 채널만 다르다.
 * - 운영 빌드는 VITE_APP=ops, 포털 빌드는 VITE_APP=portal(포털은 /portal 아래에 배포)로 각각 만든다.
 * - 개발 서버는 하나로 두 앱을 같이 띄운다: /portal 아래는 포털, 나머지는 운영 백오피스.
 */
export type AppKind = "ops" | "portal";

export const APPS: Record<AppKind, { name: string; basename: string; channel: string }> = {
  ops: { name: "dobedubpop · 운영 백오피스", basename: "", channel: "ops" },
  portal: { name: "dobedubpop · 권리자 포털", basename: "/portal", channel: "portal" },
};

/** 빌드가 정한 앱(VITE_APP)이 있으면 그것, 없으면(개발 서버) 경로로 정한다. */
export function appKind(pathname: string, built: string | undefined): AppKind {
  if (built === "ops" || built === "portal") return built;
  return pathname === "/portal" || pathname.startsWith("/portal/") ? "portal" : "ops";
}

function browserPath(): string {
  return typeof location === "undefined" ? "/" : location.pathname;
}

/** 지금 실행 중인 앱. */
export function currentApp(): AppKind {
  return appKind(browserPath(), import.meta.env.VITE_APP as string | undefined);
}

import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "./Layout.tsx";
import { routesFor } from "./routes.tsx";
import { APPS, currentApp } from "./apps.ts";
import { queryClient } from "./queryClient.ts";
import { api, ApiError, authApi, sessionMode } from "../api/client.ts";
import { LoginPage } from "./Login.tsx";

export type Me = { userId: string; displayName: string; roles: string[]; tenantId: string; scope: string };

/**
 * 로그인 관문(MVP 진행계획 M3): 빌드된 앱은 세션이 없으면 로그인 화면을 보여 준다. 쓰는 중 세션이 끝나면(401) 다시 로그인 화면으로 간다.
 * 개발 서버는 사용자 전환(x-actor)을 쓰므로 관문이 없다.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "in" | "out">(sessionMode ? "checking" : "in");
  const check = () => api<Me>("GET", "/me").then(() => setState("in"), (e) => setState(e instanceof ApiError && e.status === 401 ? "out" : "in"));
  useEffect(() => {
    if (!sessionMode) return;
    // 데모 진행판이 연 링크(?persona=): 데모 환경이면 그 페르소나로 바로 로그인한다(운영 환경은 이 경로가 404라 로그인 화면이 나온다).
    const params = new URLSearchParams(location.search);
    const persona = params.get("persona");
    if (persona) {
      params.delete("persona");
      history.replaceState(null, "", `${location.pathname}${params.size > 0 ? `?${params}` : ""}`);
      void authApi("POST", "/dev-login", { userId: persona }).then(() => { queryClient.clear(); return check(); }, () => check());
    } else void check();
    return queryClient.getQueryCache().subscribe((ev) => {
      const e = ev.query.state.error;
      if (e instanceof ApiError && e.status === 401 && e.code !== "CHANNEL_FORBIDDEN") setState("out");
    });
  }, []);
  if (state === "checking") return <p className="muted" style={{ padding: 24 }}>확인 중…</p>;
  if (state === "out") return <LoginPage onDone={() => { queryClient.clear(); setState("in"); }} />;
  return <>{children}</>;
}

export function App() {
  const kind = currentApp();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <BrowserRouter basename={APPS[kind].basename}>
          <Routes>
            <Route element={<Layout />}>
              {routesFor(kind).map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthGate>
    </QueryClientProvider>
  );
}

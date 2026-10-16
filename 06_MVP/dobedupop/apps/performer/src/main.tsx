import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { authApi, sessionMode } from "./api.ts";
import "./styles.css";

// 서비스 워커: 웹 푸시 수신과 알림 클릭 처리(public/sw.js).
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);

// 데모 진행판이 연 링크(?persona=): 데모 환경이면 그 멤버로 먼저 로그인하고 화면을 그린다(운영 환경은 이 경로가 404라 로그인 화면이 나온다).
async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const persona = params.get("persona");
  if (sessionMode && persona) {
    params.delete("persona");
    history.replaceState(null, "", `${location.pathname}${params.size > 0 ? `?${params}` : ""}`);
    await authApi("POST", "/dev-login", { userId: persona }).catch(() => undefined);
  }
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
}
void boot();

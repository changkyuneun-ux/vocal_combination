import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// 서비스 워커: 웹 푸시 수신과 알림 클릭 처리(public/sw.js).
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "./styles.css";
import "./portal.css";
import { currentApp } from "./app/apps.ts";

// 앱별 색 체계(공통 테마 html[data-app]): 포털 파랑·운영 어두운 머리글·참여 기관 청록.
document.documentElement.dataset.app = currentApp();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

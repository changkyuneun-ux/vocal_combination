import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** 데모 진행판(MVP 진행계획 M5, 결정 MD7): 데모 환경에서만 배포한다. API는 데모 진행판 서버(/api/demo)와 코어 개발 도구(/api/dev). */
export default defineConfig({
  plugins: [react()],
  // 글꼴은 늘 파일로 낸다: 작은 글꼴을 data: URI로 넣으면 게이트웨이 CSP(font-src 'self')가 막는다.
  build: { assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined) },
  server: { proxy: { "/api/demo": { target: "http://127.0.0.1:8095", rewrite: (p) => p.replace(/^\/api\/demo/, "") } } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

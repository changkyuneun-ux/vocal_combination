import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 글꼴은 늘 파일로 낸다: 작은 글꼴을 data: URI로 넣으면 게이트웨이 CSP(font-src 'self')가 막는다.
  build: { assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined) },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  test: { include: ["src/**/*.test.ts"], exclude: ["e2e/**", "node_modules/**"], environment: "node" },
});

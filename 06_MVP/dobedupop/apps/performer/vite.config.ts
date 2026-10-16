import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** 실연자 앱(다음 작업 11): 모바일 우선 PWA. API는 코어의 실연자 채널(/performer)만 쓴다. */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8080", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

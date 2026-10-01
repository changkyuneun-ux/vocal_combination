import { defineConfig } from "@playwright/test";

/**
 * 사전 조건: 개발 DB를 한 번 만들어 둔다(`npm run dev:db -w rights-core`, docker compose up -d 필요).
 * 개발 DB 하나를 공유하므로 워커 1개로 순서대로 실행한다. 서버가 이미 떠 있으면 재사용한다.
 * Vite는 localhost(IPv4 또는 IPv6)로 뜨므로 주소를 localhost로 맞춘다.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "npm run dev --prefix ../rights-core",
      url: "http://127.0.0.1:8080/dev/clock",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
  ],
});

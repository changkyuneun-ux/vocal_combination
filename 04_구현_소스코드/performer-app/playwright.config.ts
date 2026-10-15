import { defineConfig, devices } from "@playwright/test";

/**
 * 실연자 앱 E2E(모바일 화면). 코어 개발 서버(8080, RC_DEV)와 이 앱(5174)을 띄운다. 이미 떠 있으면 재사용한다.
 * 개발 DB 하나를 백오피스 E2E와 같이 쓰므로 워커 1개로 순서대로 실행한다.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5174", trace: "retain-on-failure" },
  projects: [{ name: "mobile", use: { ...devices["Pixel 7"] } }],
  webServer: [
    { command: "npm run dev --prefix ../rights-core", url: "http://127.0.0.1:8080/dev/clock", reuseExistingServer: true, timeout: 60_000 },
    { command: "npm run dev", url: "http://localhost:5174", reuseExistingServer: true, timeout: 60_000 },
  ],
});

/**
 * 게이트웨이 연기 시험(MVP 진행계획 M2·M6): 서브도메인 = 채널, 다른 채널·코어 루트 경로 차단, 보안 헤더, 데모 도구 위치.
 *   node deploy/smoke/gateway-smoke.ts [기본 도메인(기본 dobedupop.localhost)] [포트(기본 80)]
 * 신원은 아직 개발용 x-actor 헤더다(M3에서 세션으로 바뀐다).
 */
const domain = process.argv[2] ?? "dobedupop.localhost";
const port = process.argv[3] ?? "80";
type Case = { host: string; path: string; actor?: string; status: number; contains?: string; note: string };
const cases: Case[] = [
  { host: "portal", path: "/", status: 200, contains: "<div id=\"root\">", note: "포털 앱" },
  { host: "portal", path: "/api/portal/parties", actor: "usr_editor", status: 200, note: "포털 채널 통과" },
  { host: "portal", path: "/api/ops/parties", actor: "usr_ops", status: 403, contains: "CHANNEL_FORBIDDEN", note: "포털 주소로 운영 채널 차단" },
  { host: "portal", path: "/api/dev/clock", status: 403, contains: "CHANNEL_FORBIDDEN", note: "포털 주소로 개발 도구 차단" },
  { host: "artist", path: "/", status: 200, contains: "<div id=\"root\">", note: "실연자 앱" },
  { host: "artist", path: "/api/portal/parties", actor: "usr_editor", status: 403, contains: "CHANNEL_FORBIDDEN", note: "실연자 주소로 포털 채널 차단" },
  { host: "ops", path: "/", status: 200, contains: "<div id=\"root\">", note: "운영 앱" },
  { host: "ops", path: "/api/ops/pipeline/signals", actor: "usr_ops", status: 200, note: "운영 채널 통과" },
  { host: "ops", path: "/api/performer/me", actor: "usr_ops", status: 403, contains: "CHANNEL_FORBIDDEN", note: "운영 주소로 실연자 채널 차단" },
  { host: "demo", path: "/api/dev/clock", status: 200, contains: "now", note: "데모 주소의 개발 도구(데모 환경만)" },
  { host: "portal", path: "/healthz", status: 200, contains: "<div id=\"root\">", note: "코어 상태 점검은 밖에 열지 않음(앱 화면이 나온다)" },
];
let failed = 0;
for (const c of cases) {
  const url = `http://${c.host}.${domain}${port === "80" ? "" : `:${port}`}${c.path}`;
  try {
    const r = await fetch(url, { headers: c.actor ? { "x-actor": c.actor } : {} });
    const body = await r.text();
    const ok = r.status === c.status && (c.contains === undefined || body.includes(c.contains));
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.host.padEnd(6)} ${c.path.padEnd(28)} ${r.status} — ${c.note}${ok ? "" : ` | ${body.slice(0, 120)}`}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.host} ${c.path} — ${e instanceof Error ? e.message : e}`);
  }
}
const h = await fetch(`http://portal.${domain}${port === "80" ? "" : `:${port}`}/`);
for (const name of ["content-security-policy", "x-frame-options", "x-content-type-options"]) {
  const v = h.headers.get(name);
  if (v === null) failed++;
  console.log(`${v === null ? "FAIL" : "ok  "} header ${name}`);
}
if (h.headers.get("server") !== null) { failed++; console.log("FAIL header server should be hidden"); }
console.log(failed === 0 ? "gateway smoke: all passed" : `gateway smoke: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

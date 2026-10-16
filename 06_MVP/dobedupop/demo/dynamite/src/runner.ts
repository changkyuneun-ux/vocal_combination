import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { STEPS, type State } from "../../../services/rights-core/src/scenario/dynamite-personas.ts";
import { httpDriver } from "./http-driver.ts";

/**
 * 데모 진행판 서버(MVP 진행계획 M4·M5, 결정 MD7): Dynamite 시연 단계를 하나씩 또는 끝까지 실행한다. 데모 환경에서만 띄운다.
 * 게이트웨이의 demo 호스트가 /api/demo/*를 이리로 넘긴다. 단계는 순서대로만 실행하고, 처음부터 하려면 초기화(코어 /dev/reset)한다.
 *   CORE_URL(기본 http://core-api:8080), PORT(기본 8095), DEMO_PURCHASES=small(구매 건수를 줄여 빨리 돌린다)
 */
const CORE = process.env.CORE_URL ?? "http://core-api:8080";
const driver = httpDriver(CORE);
type Status = { status: "todo" | "running" | "done" | "failed"; error?: string; startedAt?: string; finishedAt?: string };
let results: Status[] = STEPS.map(() => ({ status: "todo" }));
let state: State = {};
let running = false;
const SMALL = { vc_bts_orig: 12, vc_bts_swap: 5, vc_bts_vocal: 3, vc_bts_jin: 2 };
const opts = process.env.DEMO_PURCHASES === "small" ? { purchases: SMALL } : {};

const next = () => results.findIndex((r) => r.status !== "done");
async function runUpTo(last: number): Promise<void> {
  running = true;
  try {
    for (let i = next(); i !== -1 && i <= last; i = next()) {
      results[i] = { status: "running", startedAt: new Date().toISOString() };
      try {
        await STEPS[i]!.run(driver, state, opts);
        results[i] = { ...results[i]!, status: "done", finishedAt: new Date().toISOString() };
      } catch (e) {
        results[i] = { ...results[i]!, status: "failed", error: e instanceof Error ? e.message : String(e), finishedAt: new Date().toISOString() };
        console.error(`demo step ${STEPS[i]!.id} failed:`, e);
        return;
      }
    }
  } finally {
    running = false;
  }
}

/** 서버가 다시 떴을 때: 데이터가 이미 있으면 어디까지 했는지 모르므로 "처음부터 다시"를 권한다. */
async function detect(): Promise<string | null> {
  try {
    // 마지막 단계(지급)까지 끝난 데이터면 모두 완료로 본다.
    const paid = await driver.call("ops", "usr_settle", "GET", "/payout-runs/pay-2026-05/instructions?limit=1");
    if (paid.status === 200 && ((paid.body as { items?: unknown[] }).items ?? []).length > 0) {
      results = STEPS.map(() => ({ status: "done" }));
      return null;
    }
    const r = await driver.call("ops", "usr_ops", "GET", "/tenants");
    if (r.status === 200 && (r.body as { tenantId: string }[]).some((t) => t.tenantId === "tnt_bighit")) return "이전 데모 데이터가 중간까지만 남아 있습니다. 진행 상태를 알 수 없으니 '처음부터 다시'로 시작하세요.";
  } catch { /* 코어가 아직 안 떴다 */ }
  return null;
}
let notice: string | null = null;
void detect().then((n) => { notice = n; });

async function view() {
  // 다 끝났다고 기억하는데 지급 데이터가 없으면(밖에서 초기화됨) 처음 상태로 돌린다.
  if (!running && results.every((r) => r.status === "done")) {
    const paid = await driver.call("ops", "usr_settle", "GET", "/payout-runs/pay-2026-05/instructions?limit=1").catch(() => null);
    if (paid !== null && (paid.status !== 200 || ((paid.body as { items?: unknown[] }).items ?? []).length === 0)) {
      results = STEPS.map(() => ({ status: "todo" }));
      state = {};
      notice = await detect();
    }
  }
  const c = await fetch(`${CORE}/dev/clock`).then((r) => r.json()).catch(() => null) as { now?: string } | null;
  return {
    clock: c?.now ?? null, running, notice, next: next() === -1 ? null : STEPS[next()]!.id,
    steps: STEPS.map((s, i) => ({ id: s.id, title: s.title, detail: s.detail, persona: s.persona, app: s.app, ...results[i]! })),
    summary: { blocks: state.blocks, issued: state.issued, solo: state.solo, runs: state.runs },
  };
}

const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/steps") return send(res, 200, await view());
  if (req.method !== "POST") return send(res, 404, { code: "NOT_FOUND" });
  if (req.headers["x-dbp-csrf"] !== "1") return send(res, 403, { code: "CSRF_REQUIRED" });
  if (running) return send(res, 409, { code: "BUSY", message: "다른 단계가 실행 중입니다" });
  if (url.pathname === "/reset") {
    const r = await fetch(`${CORE}/dev/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!r.ok) return send(res, 500, { code: "RESET_FAILED", message: await r.text() });
    results = STEPS.map(() => ({ status: "todo" }));
    state = {};
    notice = null;
    return send(res, 200, await view());
  }
  if (notice !== null) return send(res, 409, { code: "RESET_FIRST", message: notice });
  const m = /^\/steps\/([a-z-]+)\/run$/.exec(url.pathname);
  if (m) {
    const i = STEPS.findIndex((s) => s.id === m[1]);
    if (i === -1) return send(res, 404, { code: "NOT_FOUND" });
    if (i !== next()) return send(res, 409, { code: "OUT_OF_ORDER", message: `다음 단계는 ${STEPS[next()]?.title ?? "없음"}입니다` });
    void runUpTo(i);
    return send(res, 202, await view());
  }
  if (url.pathname === "/run-all") { void runUpTo(STEPS.length - 1); return send(res, 202, await view()); }
  return send(res, 404, { code: "NOT_FOUND" });
}

const port = Number(process.env.PORT ?? 8095);
const host = process.env.DEMO_LISTEN_HOST || "127.0.0.1";
createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) })); })
  .listen(port, host, () => console.log(`demo runner listening on http://${host}:${port} (core ${CORE})`));

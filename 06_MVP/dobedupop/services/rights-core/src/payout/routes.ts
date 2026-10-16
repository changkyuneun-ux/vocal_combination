import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../platform/actor.ts";
import { maskRef, unmaskRequested } from "../platform/inspection.ts";
import { DomainError } from "../platform/errors.ts";
import { withActor, type Deps } from "../http/server.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import type { Tx } from "../platform/db.ts";
import * as q from "./queries.ts";
import { recordWebhook, resubmitPayout } from "./handlers.ts";
import { createPayoutRun, setPayoutProfile } from "./service.ts";

const str = (b: any, k: string): string => {
  if (typeof b?.[k] !== "string") throw new DomainError("BAD_REQUEST", 400, `${k} must be a string`);
  return b[k];
};

/** 1~200자 문자열(webhook의 PSP 식별자 — inbox 열의 길이 제한과 같다). */
const id200 = (b: any, k: string): string => {
  const v = str(b, k);
  if (v.length === 0 || v.length > 200) throw new DomainError("BAD_REQUEST", 400, `${k} must be 1 to 200 characters`);
  return v;
};

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 지급 API(통합 설계 11.2-14). 운영 라우트는 SPACE_SETTLE(서비스가 검사). 신원(401)이 본문 검증(400)보다 먼저다.
 * POST /psp/webhook은 신원이 없다: 공유 비밀 헤더 x-psp-secret를 deps.pspSecret(env RC_PSP_SECRET)과 비교한다 — 설정이 없으면 503, 다르면 401.
 * 본문: providerEventId·providerRef는 1~200자 문자열, status는 PAID|FAILED(아니면 400).
 */
export function payoutRoutes(app: FastifyInstance, deps: Deps): void {
  const d = () => ({ db: deps.db, clock: deps.clock, jobs: deps.jobs });
  app.put<{ Params: { id: string } }>("/parties/:id/payout-profile", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    const b: any = req.body;
    return deps.db.tx((tx) => setPayoutProfile(tx, deps.clock, actor, {
      partyId: req.params.id, taxType: b?.taxType, kycVerified: b?.kycVerified,
      ...(b !== null && typeof b === "object" && "payoutAccountRef" in b ? { payoutAccountRef: b.payoutAccountRef } : {}),
    }));
  });
  app.post("/payout-runs", async (req, reply) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    requireRole(actor, "SPACE_SETTLE");
    const b: any = req.body;
    return reply.status(201).send(await createPayoutRun(d(), actor, { payoutRunId: str(b, "payoutRunId"), asOf: str(b, "asOf") }));
  });
  app.post<{ Params: { id: string } }>("/payouts/:id/resubmit", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    requireRole(actor, "SPACE_SETTLE");
    if (deps.provider === undefined) throw new DomainError("PSP_NOT_CONFIGURED", 503, "no payout provider is configured");
    return resubmitPayout({ ...d(), provider: deps.provider }, actor, req.params.id);
  });
  // 조회(SPACE_SETTLE). 역할 검사가 필터·커서 검증보다 먼저다.
  const read = <T>(path: string, fn: (tx: Tx, req: any) => Promise<T>) =>
    app.get(path, async (req) => withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "SPACE_SETTLE");
      return fn(tx, req);
    }));
  const qs = (req: { query: unknown }) => req.query as Record<string, unknown>;
  read("/payout-policy", (tx) => q.getPayoutPolicy(tx));
  // 계좌 토큰은 기본 마스킹(조회 통제 2단계). unmask=1&reason=…이면 열람을 기록하고 원문을 준다.
  app.get<{ Params: { id: string } }>("/parties/:id/payout-profile", async (req) => withActor(deps, req, async (tx, actor) => {
    requireRole(actor, "SPACE_SETTLE");
    const p = await q.getPayoutProfile(tx, req.params.id);
    const open = await unmaskRequested(tx, deps.clock, actor, qs(req), { partyId: req.params.id, nodeType: "party_payout_profile", nodeId: req.params.id, ip: req.ip });
    return open ? p : { ...p, payoutAccountRef: maskRef(p.payoutAccountRef) };
  }));
  read("/payout-runs", (tx, req) => q.listPayoutRuns(tx, parsePage(qs(req))));
  read("/payout-runs/:id/instructions", async (tx, req) => {
    const page = await q.listInstructions(tx, req.params.id, { status: optFilter(qs(req), "status") }, parsePage(qs(req)));
    return { ...page, items: page.items.map((i) => ({ ...i, submittedAccountRef: maskRef(i.submittedAccountRef), decidedAccountRef: maskRef(i.decidedAccountRef) })) };
  });
  app.get<{ Params: { id: string } }>("/payouts/:id", async (req) => withActor(deps, req, async (tx, actor) => {
    requireRole(actor, "SPACE_SETTLE");
    const d = await q.getPayout(tx, req.params.id);
    const open = await unmaskRequested(tx, deps.clock, actor, qs(req), { partyId: d.partyId, nodeType: "payout_instruction", nodeId: req.params.id, ip: req.ip });
    // 판정·전송 토큰이 같은지는 원문으로 비교해 알려 준다(마스킹된 값끼리는 비교할 수 없다).
    const accountRefMismatch = d.decidedAccountRef !== null && d.submittedAccountRef !== null && d.decidedAccountRef !== d.submittedAccountRef;
    return open ? { ...d, accountRefMismatch } : { ...d, submittedAccountRef: maskRef(d.submittedAccountRef), decidedAccountRef: maskRef(d.decidedAccountRef), accountRefMismatch };
  }));
}

/**
 * PSP 결과 통지(외부 시스템 → 코어). 사용자 채널이 아니라 연동 경로라 채널 접두 없이 루트에 둔다(연동 허브는 다음 작업 14).
 * 신원 대신 공유 비밀 헤더 x-psp-secret를 검사한다.
 */
export function pspWebhookRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/psp/webhook", async (req, reply) => {
    if (deps.pspSecret === undefined || deps.pspSecret === "") throw new DomainError("PSP_NOT_CONFIGURED", 503, "RC_PSP_SECRET is not configured");
    if (!secretMatches(req.headers["x-psp-secret"], deps.pspSecret)) throw new DomainError("BAD_SECRET", 401, "x-psp-secret is missing or wrong");
    const b: any = req.body;
    const providerEventId = id200(b, "providerEventId");
    const providerRef = id200(b, "providerRef");
    const status = b?.status;
    if (status !== "PAID" && status !== "FAILED") throw new DomainError("BAD_REQUEST", 400, "status must be PAID or FAILED");
    const w = { providerEventId, providerRef, status, payload: b.payload ?? b } as const;
    const r = await deps.db.tx((tx) => recordWebhook(tx, deps.clock, deps.jobs, w));
    return reply.status(r.created ? 201 : 200).send(r);
  });
}

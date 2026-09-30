import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import { withActor, type Deps } from "../http/server.ts";
import { recordWebhook, resubmitPayout } from "./handlers.ts";
import { createPayoutRun, setPayoutProfile } from "./service.ts";

const str = (b: any, k: string): string => {
  if (typeof b?.[k] !== "string") throw new DomainError("BAD_REQUEST", 400, `${k} must be a string`);
  return b[k];
};

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 지급 API(통합 설계 11.2-14). 운영 라우트는 SPACE_SETTLE(서비스가 검사). 신원(401)이 본문 검증(400)보다 먼저다.
 * POST /psp/webhook은 신원이 없다: 공유 비밀 헤더 x-psp-secret를 deps.pspSecret(env RC_PSP_SECRET)과 비교한다 — 설정이 없으면 503, 다르면 401.
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
    const b: any = req.body;
    return reply.status(201).send(await createPayoutRun(d(), actor, { payoutRunId: str(b, "payoutRunId"), asOf: str(b, "asOf") }));
  });
  app.post<{ Params: { id: string } }>("/payouts/:id/resubmit", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    if (deps.provider === undefined) throw new DomainError("PSP_NOT_CONFIGURED", 503, "no payout provider is configured");
    return resubmitPayout({ ...d(), provider: deps.provider }, actor, req.params.id);
  });
  app.post("/psp/webhook", async (req, reply) => {
    if (deps.pspSecret === undefined || deps.pspSecret === "") throw new DomainError("PSP_NOT_CONFIGURED", 503, "RC_PSP_SECRET is not configured");
    if (!secretMatches(req.headers["x-psp-secret"], deps.pspSecret)) throw new DomainError("BAD_SECRET", 401, "x-psp-secret is missing or wrong");
    const b: any = req.body;
    const status = str(b, "status");
    if (status !== "PAID" && status !== "FAILED") throw new DomainError("BAD_REQUEST", 400, "status must be PAID or FAILED");
    const w = { providerEventId: str(b, "providerEventId"), providerRef: str(b, "providerRef"), status, payload: b.payload ?? b } as const;
    const r = await deps.db.tx((tx) => recordWebhook(tx, deps.clock, deps.jobs, w));
    return reply.status(r.created ? 201 : 200).send(r);
  });
}

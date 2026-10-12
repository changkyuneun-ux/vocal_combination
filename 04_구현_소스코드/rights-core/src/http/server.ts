import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { loadActor, type Actor } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { platformRoutes } from "../platform/routes.ts";
import { registryRoutes } from "../registry/routes.ts";
import { policyRoutes } from "../policy/routes.ts";
import { issuanceRoutes } from "../issuance/routes.ts";
import { sealRoutes } from "./seal-routes.ts";
import { revenueRoutes } from "../revenue/routes.ts";
import { settlementRoutes } from "../settlement/routes.ts";
import { refundHook, revisionHook } from "../settlement/service.ts";
import type { Jobs } from "../platform/jobs.ts";
import type { PayoutProvider } from "../payout/provider.ts";
import { ledgerRoutes } from "../ledger/routes.ts";
import { payoutRoutes } from "../payout/routes.ts";
import { devRoutes, type DevDeps } from "../dev/routes.ts";

/** provider·pspSecret은 지급 운영 라우트용: provider가 없으면 재전송 503, pspSecret이 없으면 webhook 503. */
export type Deps = { db: Db; ctx: BridgeCtx; clock: Clock; jobs: Jobs; provider?: PayoutProvider; pspSecret?: string; dev?: DevDeps };

/** 요청 하나 = 트랜잭션 하나. x-actor 헤더로 신원을 읽는다(개발용 — 통합 설계 9.1). */
export async function withActor<T>(deps: Deps, req: FastifyRequest, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const userId = req.headers["x-actor"];
  if (typeof userId !== "string" || userId === "") throw new DomainError("UNKNOWN_ACTOR", 401, "x-actor header is required");
  return deps.db.tx(async (tx) => fn(tx, await loadActor(tx, userId)));
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false });
  // 본문 없는 JSON POST(예: approve/activate)는 {}로 취급한다.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === "") return done(null, {});
    try { done(null, JSON.parse(text)); } catch (e) { const err: any = e; err.statusCode = 400; done(err, undefined); }
  });
  app.addHook("preValidation", async (req) => { if (req.body == null) req.body = {}; });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, diagnostics: err.diagnostics });
    }
    if (err?.code === "23505") return reply.status(409).send({ code: "CONFLICT", message: err.detail ?? err.message, diagnostics: [] });
    // 교착(40P01)·직렬화 실패(40001)는 트랜잭션 전체를 다시 시도하면 된다.
    if (err?.code === "40P01" || err?.code === "40001") return reply.status(409).send({ code: "RETRY", message: "transaction conflict; retry the request", diagnostics: [] });
    if (err?.code === "RC001") return reply.status(409).send({ code: "APPEND_ONLY", message: err.message, diagnostics: [] });
    if (err?.code === "23503" || err?.code === "23514") return reply.status(422).send({ code: "INVALID_REFERENCE", message: err.detail ?? err.message, diagnostics: [] });
    if (err?.validation || (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500)) return reply.status(400).send({ code: "BAD_REQUEST", message: err.message, diagnostics: [] });
    if (err?.code === "22P02" || err?.code === "23502") return reply.status(400).send({ code: "BAD_REQUEST", message: err.message, diagnostics: [] });
    console.error("unhandled", err);
    return reply.status(500).send({ code: "INTERNAL", message: "internal error", diagnostics: [] });
  });
  platformRoutes(app, deps);
  registryRoutes(app, deps);
  policyRoutes(app, deps);
  issuanceRoutes(app, deps);
  sealRoutes(app, deps);
  revenueRoutes(app, deps, refundHook(deps.jobs), revisionHook(deps.jobs));
  settlementRoutes(app, deps);
  ledgerRoutes(app, deps);
  payoutRoutes(app, deps);
  if (deps.dev !== undefined) devRoutes(app, { ...deps, dev: deps.dev });
  return app;
}

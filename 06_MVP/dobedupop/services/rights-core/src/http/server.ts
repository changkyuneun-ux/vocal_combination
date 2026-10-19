import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { applyActorScope, withSystemScope, type Actor } from "../platform/actor.ts";
import { getTenant } from "../platform/tenants.ts";
import { delegatedActor } from "../platform/delegation.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { actorForChannel, type Channel } from "./channels.ts";
import { activeBreakGlass, applyBreakGlass, inspectRoute } from "../platform/inspection.ts";
import { platformRoutes, userListRoutes } from "../platform/routes.ts";
import { registryRoutes } from "../registry/routes.ts";
import { policyRoutes } from "../policy/routes.ts";
import { issuanceRoutes } from "../issuance/routes.ts";
import { sealRoutes } from "./seal-routes.ts";
import { revenueRoutes } from "../revenue/routes.ts";
import { opsHubRoutes, partnerHubRoutes } from "../hub/routes.ts";
import { settlementRoutes } from "../settlement/routes.ts";
import { refundHook, revisionHook } from "../settlement/service.ts";
import type { Jobs } from "../platform/jobs.ts";
import type { PayoutProvider } from "../payout/provider.ts";
import { ledgerRoutes } from "../ledger/routes.ts";
import { payoutRoutes, pspWebhookRoutes } from "../payout/routes.ts";
import { devRoutes, type DevDeps } from "../dev/routes.ts";
import { fanRenderRoutes, fanRoutes, partnerRoutes, performerRoutes, portalRoutes } from "./channel-routes.ts";
import { monitorRoutes } from "../monitor/routes.ts";
import { audioOpsRoutes, stemAudioRoutes } from "../audio/routes.ts";
import type { AudioDeps } from "../audio/deps.ts";
import type { DocumentStore } from "../documents/store.ts";
import { documentRoutes } from "../documents/routes.ts";
import { validationRoutes } from "../validation/routes.ts";
import { contractRoutes, devEsignRoutes } from "../contracts/routes.ts";
import { linkRoutes, participantRoutes } from "../participants/routes.ts";
import { readCookie, resolveSession, SESSION_COOKIE } from "../platform/auth.ts";
import { assertCsrf, authRoutes, userAdminRoutes } from "../platform/auth-routes.ts";
import type { SignatureProvider } from "../contracts/esign.ts";
import type { IdentityProvider } from "../performer/identity.ts";
import type { PushSender } from "../performer/notifications.ts";

/** provider·pspSecret은 지급 운영 라우트용: provider가 없으면 재전송 503, pspSecret이 없으면 webhook 503. */
/**
 * audio는 오디오 처리 서비스 연동(스템 업로드·검사·렌더). identity는 본인 인증 공급자, push는 웹 푸시 전송자(실연자 앱).
 * 없으면 해당 경로가 503이다.
 */
export type Deps = { db: Db; ctx: BridgeCtx; clock: Clock; jobs: Jobs; provider?: PayoutProvider; pspSecret?: string; dev?: DevDeps; audio?: AudioDeps; identity?: IdentityProvider; push?: PushSender; documents?: DocumentStore; esign?: SignatureProvider;
  /** 개발용 신원 헤더(x-actor)를 받을지. 기본 받음(시험·개발 서버). 운영 진입점은 끈다(세션 쿠키만). */
  headerIdentity?: boolean;
  /** 세션 쿠키에 Secure를 붙일지(HTTPS 운영). */
  cookieSecure?: boolean;
};

/**
 * 요청 하나 = 트랜잭션 하나. 신원은 그 채널의 세션 쿠키(MVP 진행계획 M3)에서 읽고, 개발·시험에서는 x-actor 헤더도 받는다(운영 진입점은 끈다).
 * 쿠키 세션으로 상태를 바꾸는 요청은 CSRF 헤더가 있어야 한다. 트랜잭션 조회 범위는 행위자의 테넌트로 좁힌다.
 */
export async function withActor<T>(deps: Deps, req: FastifyRequest, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const cookie = req.channel === undefined ? undefined : readCookie(req.headers.cookie, SESSION_COOKIE(req.channel));
  const header = deps.headerIdentity === false ? undefined : req.headers["x-actor"];
  if (cookie === undefined && (typeof header !== "string" || header === "")) throw new DomainError("UNAUTHENTICATED", 401, "sign in first");
  if (cookie !== undefined && !["GET", "HEAD", "OPTIONS"].includes(req.method)) assertCsrf(req);
  return deps.db.tx(async (tx) => {
    // 사용자 API는 모두 채널 아래에 있다. 채널 없이 신원을 쓰는 경로는 만들지 않는다.
    if (req.channel === undefined) throw new DomainError("CHANNEL_REQUIRED", 404, "user APIs live under a channel: /ops, /portal, /performer, /fan, /partner");
    const session = cookie !== undefined ? await resolveSession(tx, deps.clock, cookie, req.channel) : null;
    if (cookie !== undefined && session === null) throw new DomainError("UNAUTHENTICATED", 401, "the session expired; sign in again");
    // 지금 일하는 소속(결정 TD9): 세션에 있고, 개발·시험 헤더는 x-tenant로 고른다.
    const xt = req.headers["x-tenant"];
    let actor = session !== null
      ? await actorForChannel(tx, session.userId, req.channel, session.tenantId)
      : await actorForChannel(tx, header as string, req.channel, typeof xt === "string" && xt !== "" ? xt : undefined);
    // 위임 대행(TN6): 권리자 포털에서 플랫폼 온보딩이 맡긴 테넌트 권한으로 일한다(세션 또는 개발 헤더 x-on-behalf-of).
    const xb = req.headers["x-on-behalf-of"];
    const behalf = session !== null ? session.onBehalfOf : typeof xb === "string" && xb !== "" ? xb : null;
    if (behalf !== null && req.channel === "portal") actor = await delegatedActor(tx, actor, behalf);
    // 신청·정지 상태 조직의 관리자는 열람만 한다(결정 TD7).
    if (actor.readOnly === true && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      throw new DomainError("TENANT_INACTIVE", 403, `tenant ${actor.tenantId} is ${actor.tenantStatus}; read only`);
    }
    await applyActorScope(tx, actor);
    // 3단계 통제: 플랫폼 사용자가 break-glass를 열어 두었으면 그 테넌트 소유 데이터에도 쓸 수 있다(RLS rc_can_write).
    const bg = actor.scope === "platform" ? await activeBreakGlass(tx, actor.userId, () => deps.clock.now()) : undefined;
    if (bg !== undefined) await applyBreakGlass(tx, bg);
    const out = await fn(tx, actor);
    // 위임 대행으로 바꾼 요청은 업무 모듈이 감사를 남기지 않아도 한 줄 남긴다(대상 테넌트는 acting_on_behalf_of 열이 받는다).
    if (actor.actingOnBehalfOf !== undefined && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      await audit(tx, deps.clock, { actor: actor.userId, action: "DELEGATED_REQUEST", entityType: "route", entityId: `${req.method} ${req.url.split("?")[0]}` });
    }
    // 1단계 통제: 운영 채널에서 다른 테넌트의 레코드 상세를 읽었으면 같은 트랜잭션에서 열람을 기록한다.
    if (req.channel === "ops" && req.method === "GET") {
      const route = (req.routeOptions.url ?? "").replace(/^\/ops/, "");
      await inspectRoute(tx, deps.clock, actor, route, req.params as Record<string, string>, req.ip, bg?.breakGlassId);
    }
    return out;
  });
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false });
  // 상태 점검(게이트웨이는 외부에 열지 않는다): 살아 있음, DB 연결 준비.
  app.get("/healthz", async () => ({ status: "ok", role: "api" }));
  app.get("/readyz", async () => { await deps.db.tx((tx) => tx.query("SELECT 1")); return { status: "ready", role: "api" }; });
  // 본문 없는 JSON POST(예: approve/activate)는 {}로 취급한다.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === "") return done(null, {});
    try { done(null, JSON.parse(text)); } catch (e) { const err: any = e; err.statusCode = 400; done(err, undefined); }
  });
  // 스템 오디오·참조 음원은 원시 바이트로 받는다.
  // 원천 문서 원문(PDF·스캔 이미지)도 원시 바이트로 받는다.
  for (const ct of ["application/octet-stream", /^audio\//, "application/pdf", /^image\//] as const) {
    app.addContentTypeParser(ct, { parseAs: "buffer", bodyLimit: 200 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  }
  app.addHook("preValidation", async (req) => { if (req.body == null) req.body = {}; });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, diagnostics: err.diagnostics });
    }
    if (err?.code === "23505") return reply.status(409).send({ code: "CONFLICT", message: err.detail ?? err.message, diagnostics: [] });
    // 교착(40P01)·직렬화 실패(40001)는 트랜잭션 전체를 다시 시도하면 된다.
    if (err?.code === "40P01" || err?.code === "40001") return reply.status(409).send({ code: "RETRY", message: "transaction conflict; retry the request", diagnostics: [] });
    // RLS 쓰기 거부(42501): 다른 테넌트 소유 행 밑에 쓰려 했다.
    if (err?.code === "42501") return reply.status(403).send({ code: "TENANT_FORBIDDEN", message: err.message, diagnostics: [] });
    if (err?.code === "RC001") return reply.status(409).send({ code: "APPEND_ONLY", message: err.message, diagnostics: [] });
    if (err?.code === "23503" || err?.code === "23514") return reply.status(422).send({ code: "INVALID_REFERENCE", message: err.detail ?? err.message, diagnostics: [] });
    if (err?.validation || (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500)) return reply.status(400).send({ code: "BAD_REQUEST", message: err.message, diagnostics: [] });
    if (err?.code === "22P02" || err?.code === "23502") return reply.status(400).send({ code: "BAD_REQUEST", message: err.message, diagnostics: [] });
    console.error("unhandled", err);
    return reply.status(500).send({ code: "INTERNAL", message: "internal error", diagnostics: [] });
  });
  app.decorateRequest("channel", undefined);
  const revenue = (sub: FastifyInstance) => revenueRoutes(sub, deps, refundHook(deps.jobs), revisionHook(deps.jobs));
  const all = (sub: FastifyInstance) => {
    platformRoutes(sub, deps); registryRoutes(sub, deps); policyRoutes(sub, deps); issuanceRoutes(sub, deps); sealRoutes(sub, deps);
    revenue(sub); settlementRoutes(sub, deps); ledgerRoutes(sub, deps); payoutRoutes(sub, deps);
  };
  // 채널별 표면(다음 작업 5). 같은 처리기를 여러 채널에 올려도 들어올 수 있는 신원은 채널 정책(assertChannel)이 정한다.
  const channel = (ch: Channel, register: (sub: FastifyInstance) => void) =>
    app.register(async (sub) => {
      sub.addHook("onRequest", async (req) => { req.channel = ch; });
      register(sub);
    }, { prefix: `/${ch}` });
  const hubHooks = { onRefund: refundHook(deps.jobs), onRevision: revisionHook(deps.jobs) };
  channel("ops", (sub) => { all(sub); authRoutes(sub, deps); userAdminRoutes(sub, deps); monitorRoutes(sub, deps); stemAudioRoutes(sub, deps); audioOpsRoutes(sub, deps); fanRenderRoutes(sub, deps); opsHubRoutes(sub, deps, hubHooks); documentRoutes(sub, deps); validationRoutes(sub, deps); contractRoutes(sub, deps); linkRoutes(sub, deps); });
  channel("portal", (sub) => {
    authRoutes(sub, deps); userAdminRoutes(sub, deps); platformRoutes(sub, deps); registryRoutes(sub, deps); policyRoutes(sub, deps); issuanceRoutes(sub, deps); sealRoutes(sub, deps); portalRoutes(sub, deps); stemAudioRoutes(sub, deps); documentRoutes(sub, deps); validationRoutes(sub, deps); contractRoutes(sub, deps); linkRoutes(sub, deps);
  });
  channel("performer", (sub) => { authRoutes(sub, deps); performerRoutes(sub, deps); });
  channel("fan", (sub) => { fanRoutes(sub, deps); fanRenderRoutes(sub, deps); });
  // 참여 기관(결정 TD12): 신탁단체·유통 파트너. 자기 당사자 명세(portalRoutes의 /my/parties·명세)와 연결·신탁 작품·상품 대응, 파트너 리포트.
  channel("partner", (sub) => {
    authRoutes(sub, deps); userAdminRoutes(sub, deps); userListRoutes(sub, deps); partnerRoutes(sub, deps); partnerHubRoutes(sub, deps, hubHooks); portalRoutes(sub, deps); linkRoutes(sub, deps); participantRoutes(sub, deps);
    sub.get("/tenants/:id", async (req) => withActor(deps, req, async (tx, actor) => {
      if (actor.tenantId !== (req.params as { id: string }).id) throw new DomainError("NOT_FOUND", 404, "tenant not found");
      return withSystemScope(tx, () => getTenant(tx, actor.tenantId));
    }));
  });
  // 루트에는 채널이 아닌 경로만 둔다: 외부 연동(PSP 결과 통지)과 개발 도구(/dev, RC_DEV).
  pspWebhookRoutes(app, deps);
  if (deps.dev !== undefined) { devRoutes(app, { ...deps, dev: deps.dev }); devEsignRoutes(app, deps); }
  return app;
}

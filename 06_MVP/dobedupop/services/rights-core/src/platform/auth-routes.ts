import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { actorForChannel, type Channel } from "../http/channels.ts";
import { listMemberships, withSystemScope } from "./actor.ts";
import { DomainError } from "./errors.ts";
import {
  acceptInvite, addMembership, createAccount, devLogin, logout, otpConfirm, otpStart, passwordLogin, readCookie, reinvite, SESSION_COOKIE, SESSION_TTL_MS, sessionCookie,
  actFor, setDisabled, setRoles, switchTenant,
} from "./auth.ts";

/** 상태를 바꾸는 요청은 이 헤더가 있어야 한다(쿠키 세션의 CSRF 방어: 다른 출처는 사용자 정의 헤더를 붙여 보낼 수 없다). */
export const CSRF_HEADER = "x-dbp-csrf";
export function assertCsrf(req: FastifyRequest): void {
  if (req.headers[CSRF_HEADER] !== "1") throw new DomainError("CSRF_REQUIRED", 403, `state-changing requests need the ${CSRF_HEADER} header`);
}

/** 로그인·로그아웃·초대 수락(채널마다, 신원 없이). 세션 쿠키는 그 서브도메인에만 남는다(Domain 속성 없음). */
export function authRoutes(app: FastifyInstance, deps: Deps): void {
  const channel = (req: FastifyRequest) => req.channel as Channel;
  const meta = (req: FastifyRequest) => ({ ip: req.ip, ...(typeof req.headers["user-agent"] === "string" && { userAgent: req.headers["user-agent"] }) });
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const signedIn = (reply: FastifyReply, ch: Channel, r: { token: string; expiresAt: string; userId: string }) =>
    reply.header("set-cookie", sessionCookie(ch, r.token, { maxAgeMs: SESSION_TTL_MS[ch], secure: deps.cookieSecure === true }))
      .send({ status: "OK", userId: r.userId, expiresAt: r.expiresAt });

  app.get("/auth/config", async (req) => {
    const ch = channel(req);
    // 데모 환경: 이 채널에 들어올 수 있는 페르소나(시스템 신원 제외).
    const personas = deps.dev === undefined ? [] : await deps.db.tx((tx) => withSystemScope(tx, async () => {
      const users = (await tx.query("SELECT user_id, display_name FROM user_account WHERE disabled_at IS NULL AND user_id NOT LIKE 'sys\\_%' ORDER BY user_id")).rows;
      const out: { userId: string; displayName: string; roles: string[] }[] = [];
      for (const u of users) {
        const a = await actorForChannel(tx, u.user_id as string, ch).catch(() => undefined);
        if (a !== undefined) out.push({ userId: a.userId, displayName: u.display_name as string, roles: [...a.roles].sort() });
      }
      return out;
    }));
    return {
      channel: ch,
      method: ch === "performer" || ch === "fan" ? "OTP" : "PASSWORD",
      mfa: ch === "ops" ? "REQUIRED" : ch === "portal" ? "OPTIONAL" : "NONE",
      // 데모 환경에서만: 페르소나 빠른 로그인(운영 빌드·운영 서버에는 없다).
      devLogin: deps.dev !== undefined,
      personas,
    };
  });
  app.post("/auth/login", async (req, reply) => {
    assertCsrf(req);
    const r = await deps.db.tx((tx) => passwordLogin(tx, deps.clock, channel(req), body(req), meta(req)));
    if (r.status === "FAILED") return reply.status(401).send({ code: "LOGIN_FAILED", message: "wrong login id, password or code", diagnostics: [] });
    if (r.status !== "OK") return reply.send(r);
    return signedIn(reply, channel(req), r);
  });
  app.post("/auth/otp/start", async (req) => {
    assertCsrf(req);
    return deps.db.tx((tx) => otpStart(tx, deps.clock, deps.identity, channel(req), body(req).loginId));
  });
  app.post("/auth/otp/confirm", async (req, reply) => {
    assertCsrf(req);
    const r = await deps.db.tx((tx) => otpConfirm(tx, deps.clock, channel(req), body(req), meta(req)));
    if (r.status === "FAILED") return reply.status(401).send({ code: "LOGIN_FAILED", message: "wrong code", attemptsLeft: r.attemptsLeft, diagnostics: [] });
    return signedIn(reply, channel(req), r);
  });
  app.post("/auth/dev-login", async (req, reply) => {
    assertCsrf(req);
    if (deps.dev === undefined) throw new DomainError("NOT_FOUND", 404, "persona login exists only in the demo environment");
    return signedIn(reply, channel(req), await deps.db.tx((tx) => devLogin(tx, deps.clock, channel(req), body(req).userId, meta(req), body(req).tenantId)));
  });
  /** 위임 대행 시작·끝(TN6): { tenantId } 또는 { tenantId: null }. */
  app.post("/auth/act-for", async (req) => {
    assertCsrf(req);
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE(channel(req)));
    if (raw === undefined) throw new DomainError("UNAUTHENTICATED", 401, "sign in first");
    return deps.db.tx((tx) => actFor(tx, deps.clock, raw, channel(req), body(req).tenantId ?? null));
  });
  /** 소속 전환(결정 TD9): 지금 세션의 일하는 소속을 바꾼다. */
  app.post("/auth/switch", async (req) => {
    assertCsrf(req);
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE(channel(req)));
    if (raw === undefined) throw new DomainError("UNAUTHENTICATED", 401, "sign in first");
    return deps.db.tx((tx) => switchTenant(tx, deps.clock, raw, channel(req), body(req).tenantId));
  });
  app.post("/auth/logout", async (req, reply) => {
    assertCsrf(req);
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE(channel(req)));
    if (raw !== undefined) await deps.db.tx((tx) => logout(tx, deps.clock, raw));
    return reply.header("set-cookie", sessionCookie(channel(req), "", { maxAgeMs: 0, secure: deps.cookieSecure === true })).send({ status: "OK" });
  });
  app.post("/auth/invite/accept", async (req) => {
    assertCsrf(req);
    return deps.db.tx((tx) => acceptInvite(tx, deps.clock, body(req)));
  });
}

/**
 * 계정 관리(결정 TD4): 운영 백오피스에서는 운영 인력·개인 계정·조직의 첫 관리자, 권리자 포털·참여 기관 화면에서는 조직 관리자가 자기 조직 담당자를.
 * 권한 판정은 auth.ts가 한다.
 */
export function userAdminRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/users", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => createAccount(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));
  app.put<{ Params: { id: string }; Body: { roles?: unknown; tenantId?: unknown } }>("/users/:id/roles", async (req) =>
    withActor(deps, req, (tx, actor) => setRoles(tx, deps.clock, actor, req.params.id, req.body?.roles, req.body?.tenantId)));
  app.post<{ Params: { id: string } }>("/users/:id/memberships", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => addMembership(tx, deps.clock, actor, req.params.id, (req.body ?? {}) as Record<string, unknown>))));
  app.get<{ Params: { id: string } }>("/users/:id/memberships", async (req) => withActor(deps, req, (tx, actor) => withSystemScope(tx, async () => {
    const all = await listMemberships(tx, req.params.id);
    // 조직 관리자는 자기 조직 소속인 계정만, 그 계정의 다른 소속은 이름만 보인다.
    if (actor.scope === "platform" || req.params.id === actor.userId) return all;
    if (!all.some((m) => m.tenantId === actor.tenantId)) throw new DomainError("NOT_FOUND", 404, `user ${req.params.id} not found`);
    return all.map((m) => (m.tenantId === actor.tenantId ? m : { ...m, roles: [] }));
  })));
  app.put<{ Params: { id: string }; Body: { disabled?: unknown } }>("/users/:id/disabled", async (req) =>
    withActor(deps, req, (tx, actor) => setDisabled(tx, deps.clock, actor, req.params.id, req.body?.disabled)));
  app.post<{ Params: { id: string } }>("/users/:id/invite", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => reinvite(tx, deps.clock, actor, req.params.id))));
}

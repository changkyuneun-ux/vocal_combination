import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { requireAnyRole, requireRole, withSystemScope } from "./actor.ts";
import { audit } from "./audit.ts";
import { endBreakGlass, listBreakGlass, listInspections, startBreakGlass } from "./inspection.ts";
import { DomainError } from "./errors.ts";
import { cursorKey, optFilter, pageOf, parsePage, ts } from "./paging.ts";

/** 조회(로그인한 누구나): 내 신원, 사용자 목록, 감사 로그(역할 필요). */
export function platformRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      const u = (await tx.query("SELECT display_name FROM user_account WHERE user_id = $1", [actor.userId])).rows[0];
      return { userId: actor.userId, displayName: u.display_name as string, roles: [...actor.roles].sort(), tenantId: actor.tenantId, scope: actor.scope };
    }));

  /** 서버 시각(데모 환경은 가상 시계): 화면의 기간 기본값("지금")에 쓴다. 로그인한 누구나. */
  app.get("/clock", async (req) => withActor(deps, req, async () => ({ now: deps.clock.now() })));

  /** 테넌트 목록(온보딩 화면): 플랫폼 범위는 전부, 테넌트 범위는 자기 테넌트만. 사용자·당사자 수를 함께 준다. */
  app.get("/tenants", async (req) =>
    withActor(deps, req, async (tx, actor) => withSystemScope(tx, async () => {
      const rows = (await tx.query(
        `SELECT t.tenant_id, t.tenant_type, t.name, t.status, t.created_at, t.validation_enforced,
                (SELECT count(*)::int FROM user_account u WHERE u.tenant_id = t.tenant_id) AS users,
                (SELECT count(*)::int FROM party p WHERE p.tenant_id = t.tenant_id) AS parties
           FROM tenant t WHERE $1 OR t.tenant_id = $2 ORDER BY t.created_at, t.tenant_id`, [actor.scope === "platform", actor.tenantId],
      )).rows;
      return rows.map((r) => ({
        tenantId: r.tenant_id as string, tenantType: r.tenant_type as string, name: r.name as string, status: r.status as string,
        createdAt: ts(r.created_at)!, validationEnforced: r.validation_enforced as boolean, users: r.users as number, parties: r.parties as number,
      }));
    })));

  /**
   * 조회 통제(다음 작업 7). 열람 기록과 break-glass 기록은 플랫폼 범위에서 전부, 테넌트 범위에서는 자기 테넌트가 대상인 것만 보인다(투명성).
   */
  app.get("/inspections", async (req) => withActor(deps, req, (tx, actor) =>
    listInspections(tx, { ...(actor.scope === "platform" && typeof (req.query as any).tenant === "string" && { tenant: (req.query as any).tenant }) })));
  app.get("/break-glass", async (req) => withActor(deps, req, (tx) => listBreakGlass(tx)));
  app.post("/break-glass", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => startBreakGlass(tx, deps.clock, actor, req.body as any))));
  app.post<{ Params: { id: string } }>("/break-glass/:id/end", async (req) =>
    withActor(deps, req, (tx, actor) => endBreakGlass(tx, deps.clock, actor, Number(req.params.id))));

  /** 테넌트 등록(권리자 온보딩): 플랫폼 운영(SPACE_OPS, 플랫폼 범위)만. */
  app.post("/tenants", async (req, reply) => {
    const out = await withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "SPACE_OPS");
      if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators can register tenants");
      const b = req.body as { tenantId?: string; tenantType?: string; name?: string };
      if (!b.tenantId || !b.tenantType || !b.name) throw new DomainError("BAD_REQUEST", 400, "missing required fields: tenantId, tenantType, name");
      if (!/^tnt_[a-z0-9_]+$/.test(b.tenantId)) throw new DomainError("BAD_REQUEST", 400, "tenantId must look like tnt_<소문자·숫자·_>");
      if (!["LABEL", "AGENCY", "PUBLISHER", "CMO", "B2B_PARTNER"].includes(b.tenantType)) throw new DomainError("BAD_REQUEST", 400, "tenantType must be LABEL, AGENCY, PUBLISHER, CMO or B2B_PARTNER");
      if ((await tx.query("SELECT 1 FROM tenant WHERE tenant_id = $1", [b.tenantId])).rowCount !== 0) throw new DomainError("TENANT_EXISTS", 409, `tenant ${b.tenantId} exists`);
      await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1,$2,$3,$4)", [b.tenantId, b.tenantType, b.name, deps.clock.now()]);
      await audit(tx, deps.clock, { actor: actor.userId, action: "TENANT_REGISTER", entityType: "tenant", entityId: b.tenantId, after: { tenantType: b.tenantType, name: b.name } });
      return { tenantId: b.tenantId };
    });
    return reply.status(201).send(out);
  });

  /**
   * 계정 목록(온보딩 화면·개발 서버 사용자 전환): 플랫폼 범위는 전부(?tenant=로 거른다), 테넌트 범위는 자기 테넌트 계정만.
   * 로그인 준비 상태(비밀번호·인증 앱)와 마지막 로그인을 함께 준다. 비밀번호·토큰 값은 주지 않는다.
   */
  app.get("/users", async (req) =>
    withActor(deps, req, async (tx, actor) => withSystemScope(tx, async () => {
      const q = req.query as Record<string, unknown>;
      const page = parsePage(q);
      const after = cursorKey(page, ["s"]);
      const tenant = actor.scope === "platform" ? optFilter(q, "tenant") ?? null : actor.tenantId;
      const p: unknown[] = [tenant, after?.[0] ?? null, page.limit + 1];
      const rows = (await tx.query(
        `SELECT u.user_id, u.display_name, u.tenant_id, u.party_id, u.disabled_at, u.identity_verified_at, t.name AS tenant_name,
                COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
                c.password_hash IS NOT NULL AS has_password, c.totp_enabled_at IS NOT NULL AS totp_enabled,
                (SELECT max(s.created_at) FROM user_session s WHERE s.user_id = u.user_id) AS last_login_at
           FROM user_account u JOIN tenant t ON t.tenant_id = u.tenant_id
           LEFT JOIN portal_role r ON r.user_id = u.user_id LEFT JOIN user_credential c ON c.user_id = u.user_id
          WHERE ($1::text IS NULL OR u.tenant_id = $1) AND ($2::text IS NULL OR u.user_id > $2)
          GROUP BY u.user_id, t.name, c.password_hash, c.totp_enabled_at ORDER BY u.user_id LIMIT $3`, p,
      )).rows;
      return pageOf(rows.map((r) => ({
        userId: r.user_id as string, displayName: r.display_name as string, roles: r.roles as string[],
        tenantId: r.tenant_id as string, tenantName: r.tenant_name as string, partyId: (r.party_id as string | null) ?? null,
        disabled: r.disabled_at !== null, hasPassword: r.has_password === true, totpEnabled: r.totp_enabled === true,
        identityVerified: r.identity_verified_at !== null, lastLoginAt: ts(r.last_login_at),
      })), page, (r) => [r.userId]);
    })));

  /** audit_id DESC. 역할: SPACE_OPS·SPACE_SETTLE·RIGHTS_EDITOR 중 하나. */
  app.get("/audit", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireAnyRole(actor, ["SPACE_OPS", "SPACE_SETTLE", "RIGHTS_EDITOR"]);
      const q = req.query as Record<string, unknown>;
      const page = parsePage(q);
      const after = cursorKey(page, ["n"]);
      const p: unknown[] = [];
      const w: string[] = [];
      for (const [name, col] of [["entityType", "entity_type"], ["entityId", "entity_id"], ["actor", "actor_user_id"]] as const) {
        const v = optFilter(q, name);
        if (v !== undefined) { p.push(v); w.push(`${col} = $${p.length}`); }
      }
      if (after) { p.push(after[0]); w.push(`audit_id < $${p.length}::bigint`); }
      p.push(page.limit + 1);
      const rows = (await tx.query(`SELECT * FROM audit_log ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY audit_id DESC LIMIT $${p.length}`, p)).rows;
      return pageOf(rows.map((r) => ({
        auditId: Number(r.audit_id), occurredAt: ts(r.occurred_at)!, actor: r.actor_user_id as string, action: r.action_name as string,
        entityType: r.entity_type as string, entityId: r.entity_id as string, after: r.after_json as unknown,
      })), page, (r) => [r.auditId]);
    }));
}

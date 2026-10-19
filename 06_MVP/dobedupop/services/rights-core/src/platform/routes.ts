import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { listMemberships, requireAnyRole, withSystemScope } from "./actor.ts";
import { endBreakGlass, listBreakGlass, listInspections, startBreakGlass } from "./inspection.ts";
import { DomainError } from "./errors.ts";
import { cursorKey, optFilter, pageOf, parsePage, ts } from "./paging.ts";
import { getTenant, onboardIndependentArtist, registerTenant, setCheck, setTenantStatus, transferParty, updateTenantInfo } from "./tenants.ts";
import { delegationLog, getDelegation, setDelegation } from "./delegation.ts";
import type { Tx } from "./db.ts";
import type { Clock } from "./clock.ts";

/** 해지 때 함께 끝낼 것(연결 모듈이 등록한다 — 순환 import를 피한다). */
export const tenantTerminateHooks: ((tx: Tx, clock: Clock, tenantId: string) => Promise<void>)[] = [];

/** 조회(로그인한 누구나): 내 신원, 사용자 목록, 감사 로그(역할 필요). */
export function platformRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      const u = (await tx.query("SELECT display_name FROM user_account WHERE user_id = $1", [actor.userId])).rows[0];
      return {
        userId: actor.userId, displayName: u.display_name as string, roles: [...actor.roles].sort(), tenantId: actor.tenantId, tenantType: actor.tenantType,
        orgClass: actor.orgClass, tenantStatus: actor.tenantStatus, scope: actor.scope, ...(actor.readOnly && { readOnly: true }),
        ...(actor.actingOnBehalfOf !== undefined && { actingOnBehalfOf: actor.actingOnBehalfOf }),
        memberships: await withSystemScope(tx, () => listMemberships(tx, actor.userId)),
      };
    }));

  /** 서버 시각(데모 환경은 가상 시계): 화면의 기간 기본값("지금")에 쓴다. 로그인한 누구나. */
  app.get("/clock", async (req) => withActor(deps, req, async () => ({ now: deps.clock.now() })));

  /**
   * 조직 목록(온보딩 화면): 플랫폼 범위는 전부, 그 밖에는 자기 소속 조직만. ?class=RIGHTS|PARTICIPANT|INDIVIDUAL|PLATFORM으로 거른다(결정 TD1 —
   * 화면의 "테넌트"는 권리 테넌트만, 참여 기관은 따로). 계정(소속) 수·당사자 수를 함께 준다.
   */
  app.get("/tenants", async (req) =>
    withActor(deps, req, async (tx, actor) => withSystemScope(tx, async () => {
      const cls = optFilter(req.query as Record<string, unknown>, "class") ?? null;
      const rows = (await tx.query(
        `SELECT t.tenant_id, t.tenant_type, t.org_class, t.name, t.status, t.created_at, t.validation_enforced, t.business_no, t.country,
                (SELECT count(*)::int FROM user_membership m WHERE m.tenant_id = t.tenant_id) AS users,
                (SELECT count(*)::int FROM party p WHERE p.tenant_id = t.tenant_id) AS parties
           FROM tenant t WHERE ($1 OR t.tenant_id = $2) AND ($3::text IS NULL OR t.org_class = $3) ORDER BY t.created_at, t.tenant_id`, [actor.scope === "platform", actor.tenantId, cls],
      )).rows;
      return rows.map((r) => ({
        tenantId: r.tenant_id as string, tenantType: r.tenant_type as string, orgClass: r.org_class as string, name: r.name as string, status: r.status as string,
        createdAt: ts(r.created_at)!, validationEnforced: r.validation_enforced as boolean, users: r.users as number, parties: r.parties as number,
        businessNo: (r.business_no as string | null) ?? null, country: (r.country as string | null) ?? null,
      }));
    })));
  /** 위임 업무(TN6): 조회는 그 조직과 플랫폼, 변경은 그 조직 관리자만. 대행 기록은 그 조직과 플랫폼이 본다. */
  app.get<{ Params: { id: string } }>("/tenants/:id/delegation", async (req) => withActor(deps, req, async (tx, actor) => {
    if (actor.scope !== "platform" && actor.tenantId !== req.params.id) throw new DomainError("NOT_FOUND", 404, `tenant not found: ${req.params.id}`);
    return withSystemScope(tx, async () => ({ ...(await getDelegation(tx, req.params.id)), log: await delegationLog(tx, req.params.id) }));
  }));
  app.put<{ Params: { id: string }; Body: { tasks?: unknown } }>("/tenants/:id/delegation", async (req) =>
    withActor(deps, req, (tx, actor) => withSystemScope(tx, () => setDelegation(tx, deps.clock, actor, req.params.id, req.body?.tasks))));
  /** 관리 이관(TN2·TD6): 당사자의 관리 주체를 옮긴다(플랫폼 온보딩). */
  app.post<{ Params: { id: string } }>("/parties/:id/manager", async (req) =>
    withActor(deps, req, (tx, actor) => transferParty(tx, deps.clock, actor, req.params.id, (req.body ?? {}) as Record<string, unknown>)));
  /** 독립 아티스트 1인 온보딩(TN12): 본인 인증한 개인 계정 → 1인 권리 테넌트 + 관리자 소속 + 본인 당사자 관리 이관. */
  app.post("/onboarding/independent-artists", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => onboardIndependentArtist(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));
  /** 조직 상세(확인 항목·다음 상태): 플랫폼은 전부, 조직 사용자는 자기 조직만. */
  app.get<{ Params: { id: string } }>("/tenants/:id", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      if (actor.scope !== "platform" && actor.tenantId !== req.params.id) throw new DomainError("NOT_FOUND", 404, `tenant not found: ${req.params.id}`);
      return withSystemScope(tx, () => getTenant(tx, req.params.id));
    }));
  app.put<{ Params: { id: string } }>("/tenants/:id", async (req) =>
    withActor(deps, req, (tx, actor) => updateTenantInfo(tx, deps.clock, actor, req.params.id, (req.body ?? {}) as Record<string, unknown>)));
  app.put<{ Params: { id: string; item: string } }>("/tenants/:id/checks/:item", async (req) =>
    withActor(deps, req, (tx, actor) => setCheck(tx, deps.clock, actor, req.params.id, req.params.item, (req.body ?? {}) as Record<string, unknown>)));
  app.post<{ Params: { id: string } }>("/tenants/:id/status", async (req) =>
    withActor(deps, req, (tx, actor) => setTenantStatus(tx, deps.clock, actor, req.params.id, (req.body ?? {}) as Record<string, unknown>, {
      onTerminate: async (t, id) => { for (const h of tenantTerminateHooks) await h(t, deps.clock, id); },
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

  /** 조직 등록(권리 테넌트·참여 기관 온보딩): 플랫폼 운영(SPACE_OPS·ONBOARDING)만. 신청(APPLIED) 상태로 만든다. */
  app.post("/tenants", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => registerTenant(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));

  userListRoutes(app, deps);

  /** audit_id DESC. 역할: SPACE_OPS·SPACE_SETTLE·RIGHTS_EDITOR 중 하나. */
  app.get("/audit", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireAnyRole(actor, ["SPACE_OPS", "SPACE_SETTLE", "RIGHTS_EDITOR", "ONBOARDING", "COMPLIANCE", "TENANT_ADMIN"]);
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

/** 계정 목록: 운영·포털·참여 기관 채널이 함께 쓴다. */
export function userListRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * 계정 목록(온보딩 화면·개발 서버 사용자 전환): 플랫폼 범위는 전부(?tenant=로 거른다), 테넌트 범위는 자기 테넌트 계정만.
   * 로그인 준비 상태(비밀번호·인증 앱)와 마지막 로그인을 함께 준다. 비밀번호·토큰 값은 주지 않는다.
   */
  app.get("/users", async (req) =>
    withActor(deps, req, async (tx, actor) => withSystemScope(tx, async () => {
      const q = req.query as Record<string, unknown>;
      const page = parsePage(q);
      const after = cursorKey(page, ["s"]);
      // 소속 기준(결정 TD9): 조직을 고르면 그 조직 소속 계정과 그 조직에서의 역할, 아니면 기본 소속과 그 역할.
      const tenant = actor.scope === "platform" ? optFilter(q, "tenant") ?? null : actor.tenantId;
      const p: unknown[] = [tenant, after?.[0] ?? null, page.limit + 1];
      const rows = (await tx.query(
        `SELECT u.user_id, u.display_name, m.tenant_id, u.party_id, u.disabled_at, u.identity_verified_at, t.name AS tenant_name, m.tenant_id = u.tenant_id AS home,
                COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
                (SELECT count(*)::int FROM user_membership x WHERE x.user_id = u.user_id) AS memberships,
                c.password_hash IS NOT NULL AS has_password, c.totp_enabled_at IS NOT NULL AS totp_enabled,
                (SELECT max(s.created_at) FROM user_session s WHERE s.user_id = u.user_id) AS last_login_at
           FROM user_account u JOIN user_membership m ON m.user_id = u.user_id AND m.tenant_id = COALESCE($1::text, u.tenant_id)
           JOIN tenant t ON t.tenant_id = m.tenant_id
           LEFT JOIN portal_role r ON r.user_id = u.user_id AND r.tenant_id = m.tenant_id LEFT JOIN user_credential c ON c.user_id = u.user_id
          WHERE ($2::text IS NULL OR u.user_id > $2)
          GROUP BY u.user_id, m.tenant_id, t.name, c.password_hash, c.totp_enabled_at ORDER BY u.user_id LIMIT $3`, p,
      )).rows;
      return pageOf(rows.map((r) => ({
        userId: r.user_id as string, displayName: r.display_name as string, roles: r.roles as string[],
        tenantId: r.tenant_id as string, tenantName: r.tenant_name as string, partyId: (r.party_id as string | null) ?? null,
        homeMembership: r.home === true, memberships: r.memberships as number,
        disabled: r.disabled_at !== null, hasPassword: r.has_password === true, totpEnabled: r.totp_enabled === true,
        identityVerified: r.identity_verified_at !== null, lastLoginAt: ts(r.last_login_at),
      })), page, (r) => [r.userId]);
    })));
}

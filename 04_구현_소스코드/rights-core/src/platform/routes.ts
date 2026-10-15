import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { requireAnyRole, requireRole } from "./actor.ts";
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

  /** 테넌트 목록: 플랫폼 범위는 전부, 테넌트 범위는 자기 테넌트만. */
  app.get("/tenants", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      const rows = (await tx.query(
        "SELECT tenant_id, tenant_type, name, status FROM tenant WHERE $1 OR tenant_id = $2 ORDER BY tenant_id", [actor.scope === "platform", actor.tenantId],
      )).rows;
      return rows.map((r) => ({ tenantId: r.tenant_id as string, tenantType: r.tenant_type as string, name: r.name as string, status: r.status as string }));
    }));

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
      await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1,$2,$3,$4)", [b.tenantId, b.tenantType, b.name, deps.clock.now()]);
      await audit(tx, deps.clock, { actor: actor.userId, action: "TENANT_REGISTER", entityType: "tenant", entityId: b.tenantId, after: { tenantType: b.tenantType, name: b.name } });
      return { tenantId: b.tenantId };
    });
    return reply.status(201).send(out);
  });

  app.get("/users", async (req) =>
    withActor(deps, req, async (tx) => {
      const page = parsePage(req.query as Record<string, unknown>);
      const after = cursorKey(page, ["s"]);
      const p: unknown[] = [];
      let where = "";
      if (after) { p.push(after[0]); where = "WHERE u.user_id > $1"; }
      p.push(page.limit + 1);
      const rows = (await tx.query(
        `SELECT u.user_id, u.display_name, COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
           FROM user_account u LEFT JOIN portal_role r ON r.user_id = u.user_id ${where}
          GROUP BY u.user_id, u.display_name ORDER BY u.user_id LIMIT $${p.length}`, p,
      )).rows;
      return pageOf(rows.map((r) => ({ userId: r.user_id as string, displayName: r.display_name as string, roles: r.roles as string[] })), page, (r) => [r.userId]);
    }));

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

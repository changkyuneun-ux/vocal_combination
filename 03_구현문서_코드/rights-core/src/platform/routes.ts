import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { requireAnyRole } from "./actor.ts";
import { cursorKey, optFilter, pageOf, parsePage, ts } from "./paging.ts";

/** 조회(로그인한 누구나): 내 신원, 사용자 목록, 감사 로그(역할 필요). */
export function platformRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      const u = (await tx.query("SELECT display_name FROM user_account WHERE user_id = $1", [actor.userId])).rows[0];
      return { userId: actor.userId, displayName: u.display_name as string, roles: [...actor.roles].sort() };
    }));

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

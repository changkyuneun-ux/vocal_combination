import type { FastifyInstance } from "fastify";
import { requireRole } from "../platform/actor.ts";
import { DomainError } from "../platform/errors.ts";
import { withActor, type Deps } from "../http/server.ts";
import { trialBalance } from "./journal.ts";
import { partyStatement } from "./statements.ts";

/** 원장 조회(통합 설계 11.2-14, SPACE_SETTLE): 권리자 명세와 시산표. */
export function ledgerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/parties/:id/statements", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "SPACE_SETTLE");
      const { from, to } = req.query;
      if (typeof from !== "string" || typeof to !== "string") throw new DomainError("BAD_REQUEST", 400, "from and to query parameters are required");
      return partyStatement(tx, req.params.id, from, to);
    }));
  app.get("/ledger/trial-balance", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "SPACE_SETTLE");
      const rows = await trialBalance(tx);
      return { accounts: rows.map((r) => ({ accountId: r.accountId, kind: r.kind, balance: r.balance.toString() })), sum: rows.reduce((a, r) => a + r.balance, 0n).toString() };
    }));
}

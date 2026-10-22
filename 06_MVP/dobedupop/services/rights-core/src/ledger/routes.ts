import type { FastifyInstance } from "fastify";
import { DomainError, notFound } from "../platform/errors.ts";
import { withActor, type Deps } from "../http/server.ts";
import type { Tx } from "../platform/db.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import * as q from "./queries.ts";
import { trialBalance } from "./journal.ts";
import { partyStatement } from "./statements.ts";
import { requirePermission } from "../platform/permissions.ts";

/** 원장 조회(통합 설계 11.2-14, ledger.view): 권리자 명세와 시산표. */
export function ledgerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/parties/:id/statements", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requirePermission(actor, "ledger.view");
      const { from, to } = req.query;
      if (typeof from !== "string" || typeof to !== "string") throw new DomainError("BAD_REQUEST", 400, "from and to query parameters are required");
      // 참여 데이터: 다른 테넌트 파티의 명세는 없는 것으로 다룬다(RLS가 전기를 걸러도 빈 명세 대신 404).
      if (!(await tx.query("SELECT rc_party_visible($1) AS v", [req.params.id])).rows[0].v) throw notFound("party", req.params.id);
      return partyStatement(tx, req.params.id, from, to);
    }));
  app.get("/ledger/trial-balance", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requirePermission(actor, "ledger.view");
      const rows = await trialBalance(tx);
      return { accounts: rows.map((r) => ({ accountId: r.accountId, kind: r.kind, balance: r.balance.toString() })), sum: rows.reduce((a, r) => a + r.balance, 0n).toString() };
    }));
  const read = <T>(path: string, fn: (tx: Tx, req: any) => Promise<T>) =>
    app.get(path, async (req) => withActor(deps, req, async (tx, actor) => {
      requirePermission(actor, "ledger.view");
      return fn(tx, req);
    }));
  const qs = (req: { query: unknown }) => req.query as Record<string, unknown>;
  read("/ledger/accounts", (tx, req) => q.listAccounts(tx, parsePage(qs(req))));
  read("/ledger/entries", (tx, req) => q.listEntries(tx, { kind: optFilter(qs(req), "kind"), account: optFilter(qs(req), "account"), party: optFilter(qs(req), "party") }, parsePage(qs(req))));
  read("/ledger/entries/:id", (tx, req) => q.getEntry(tx, req.params.id));
}

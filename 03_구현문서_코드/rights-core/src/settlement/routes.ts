import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import { batchView, confirmBatch, createBatch } from "./service.ts";

export function settlementRoutes(app: FastifyInstance, deps: Deps): void {
  const d = () => ({ db: deps.db, ctx: deps.ctx, clock: deps.clock, jobs: deps.jobs });
  app.post<{ Body: { batchId: string; periodStart: string; periodEnd: string } }>("/batches", async (req, reply) => {
    // 신원 확인(401)이 본문 검증(400)보다 먼저다.
    const actor = await withActor(deps, req, async (_tx, a) => a);
    const b: any = req.body;
    for (const k of ["batchId", "periodStart", "periodEnd"]) {
      if (typeof b?.[k] !== "string") throw new DomainError("BAD_REQUEST", 400, `${k} must be a string`);
    }
    return reply.status(201).send(await createBatch(d(), actor, req.body));
  });
  app.get<{ Params: { id: string } }>("/batches/:id", async (req) => deps.db.tx((tx) => batchView(tx, req.params.id)));
  app.post<{ Params: { id: string } }>("/batches/:id/confirm", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    return confirmBatch(d(), actor, req.params.id);
  });
  app.get<{ Params: { id: string } }>("/runs/:id", async (req) => deps.db.tx(async (tx) => {
    const r = (await tx.query("SELECT run_id, status, events_digest, result_digest FROM settlement_run WHERE run_id = $1", [req.params.id])).rows[0];
    if (r === undefined) throw notFound("run", req.params.id);
    const sums = async (table: string) => (await tx.query(
      `SELECT COALESCE(SUM(amount_krw) FILTER (WHERE line_seq = 1), 0)::text AS settle,
              COALESCE(SUM(amount_krw) FILTER (WHERE line_seq > 1), 0)::text AS reversal,
              COALESCE(SUM(amount_krw), 0)::text AS net FROM ${table} WHERE run_id = $1`, [req.params.id],
    )).rows[0];
    return { runId: r.run_id, status: r.status, eventsDigest: r.events_digest, resultDigest: r.result_digest, lines: await sums("allocation_line"), holdings: await sums("unallocated_holding") };
  }));
}

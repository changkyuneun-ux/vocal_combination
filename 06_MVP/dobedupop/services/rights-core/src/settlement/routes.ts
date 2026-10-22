import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import { suggestFraudRelease } from "../engine-bridge/fraud-release.ts";
import { releaseHold } from "./holds.ts";
import { invariants } from "./invariants.ts";
import { MAX_VOID_REASON, requeueRun, voidRun } from "./operator.ts";
import { releaseQuarantine } from "./quarantine.ts";
import * as q from "./queries.ts";
import { batchView, confirmBatch, createBatch } from "./service.ts";
import { requirePermission } from "../platform/permissions.ts";

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
  app.get<{ Params: { id: string } }>("/batches/:id", async (req) => withActor(deps, req, async (tx, actor) => {
    requirePermission(actor, "settlement.view");
    return batchView(tx, req.params.id);
  }));
  app.post<{ Params: { id: string } }>("/batches/:id/confirm", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    return confirmBatch(d(), actor, req.params.id);
  });
  app.get<{ Params: { id: string } }>("/runs/:id", async (req) => withActor(deps, req, async (tx, actor) => {
    requirePermission(actor, "settlement.view");
    const r = (await tx.query("SELECT run_id, status, events_digest, result_digest FROM settlement_run WHERE run_id = $1", [req.params.id])).rows[0];
    if (r === undefined) throw notFound("run", req.params.id);
    const sums = async (table: string) => (await tx.query(
      `SELECT COALESCE(SUM(amount_krw) FILTER (WHERE line_seq = 1), 0)::text AS settle,
              COALESCE(SUM(amount_krw) FILTER (WHERE line_seq > 1), 0)::text AS reversal,
              COALESCE(SUM(amount_krw), 0)::text AS net FROM ${table} WHERE run_id = $1`, [req.params.id],
    )).rows[0];
    return { runId: r.run_id, status: r.status, eventsDigest: r.events_digest, resultDigest: r.result_digest, lines: await sums("allocation_line"), holdings: await sums("unallocated_holding") };
  }));
  // 운영자 라우트(권한 settlement.operate는 서비스가 검사). 신원(401)이 본문 검증(400)보다 먼저다.
  app.post<{ Params: { id: string } }>("/holds/:id/release", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    requirePermission(actor, "settlement.operate");
    const allocation: any = (req.body as any)?.allocation;
    if (allocation === null || typeof allocation !== "object" || Array.isArray(allocation)) throw new DomainError("BAD_REQUEST", 400, "allocation must be an object of party -> amount string");
    return releaseHold(d(), actor, { holdingId: req.params.id, allocation });
  });
  app.get<{ Params: { id: string } }>("/holds/:id/suggestion", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requirePermission(actor, "settlement.operate");
      return suggestFraudRelease(deps.ctx, tx, req.params.id);
    }));
  app.post<{ Params: { id: string } }>("/runs/:id/void", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    requirePermission(actor, "settlement.operate");
    const reason = (req.body as any)?.reason;
    if (typeof reason !== "string" || reason === "" || reason.length > MAX_VOID_REASON) throw new DomainError("BAD_REQUEST", 400, `reason must be a non-empty string of at most ${MAX_VOID_REASON} characters`);
    return voidRun(d(), actor, req.params.id, reason);
  });
  app.post<{ Params: { id: string } }>("/runs/:id/requeue", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    return requeueRun(d(), actor, req.params.id);
  });
  app.post<{ Params: { snapshotId: string } }>("/quarantine/:snapshotId/release", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    return releaseQuarantine(d(), actor, req.params.snapshotId);
  });
  app.get("/settlement/invariants", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    requirePermission(actor, "settlement.operate");
    return invariants(deps.db, deps.clock);
  });
  // 조회(settlement.view). 권한 검사가 필터·커서 검증보다 먼저다.
  const read = <T>(path: string, fn: (tx: Tx, req: any) => Promise<T>) =>
    app.get(path, async (req) => withActor(deps, req, async (tx, actor) => {
      requirePermission(actor, "settlement.view");
      return fn(tx, req);
    }));
  const qs = (req: { query: unknown }) => req.query as Record<string, unknown>;
  read("/revenue-events/:id/settlement", (tx, req) => q.revenueEventSettlement(tx, req.params.id));
  read("/batches", (tx, req) => q.listBatches(tx, { status: optFilter(qs(req), "status") }, parsePage(qs(req))));
  read("/batches/:id/runs", (tx, req) => q.listBatchRuns(tx, req.params.id, { status: optFilter(qs(req), "status") }, parsePage(qs(req))));
  read("/quarantine", (tx, req) => {
    const open = optFilter(qs(req), "open");
    if (open !== undefined && open !== "true" && open !== "false") throw new DomainError("BAD_REQUEST", 400, "open must be true or false");
    return q.listQuarantine(tx, open === undefined ? {} : { open: open === "true" }, parsePage(qs(req)));
  });
  read("/holds", (tx, req) => q.listHolds(tx, { status: optFilter(qs(req), "status"), reason: optFilter(qs(req), "reason") }, parsePage(qs(req))));
  read("/reversals", (tx, req) => q.listReversals(tx, parsePage(qs(req))));
}

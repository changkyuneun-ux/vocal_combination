import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { requireAnyRole } from "../platform/actor.ts";
import { DomainError } from "../platform/errors.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import { listRevenueEvents } from "./queries.ts";
import { ingestRevenue, type RefundHook, type RevenueInput, type RevisionHook } from "./service.ts";
import { allocatePool, createPool, getPool, listPools, type PoolInput } from "./traffic.ts";

/** 환불·대체 후속 처리(onRefund·onRevision)는 조립하는 쪽(http/server.ts)이 넘긴다 — revenue는 settlement를 import하지 않는다. */
export function revenueRoutes(app: FastifyInstance, deps: Deps, onRefund: RefundHook, onRevision: RevisionHook): void {
  app.post<{ Body: RevenueInput }>("/revenue-events", async (req, reply) => {
    // 감상 매출은 기간 수익 풀의 배정이나 연동 허브(파트너 리포트)로만 생긴다. 둘 다 조합의 정책이 TRAFFIC을 받는지 확인한다.
    if ((req.body as { eventType?: unknown } | undefined)?.eventType === "TRAFFIC") throw new DomainError("TRAFFIC_VIA_POOL", 422, "TRAFFIC revenue comes from traffic pool allocation or partner reports via the integration hub");
    const r = await withActor(deps, req, (tx, actor) => ingestRevenue(tx, deps.clock, actor, req.body, onRefund, onRevision));
    return reply.status(r.created ? 201 : 200).send(r);
  });
  // 매출 조회: 운영·정산 담당과 수집 담당(SYSTEM)이 본다.
  app.get("/revenue-events", async (req) => withActor(deps, req, async (tx, actor) => {
    requireAnyRole(actor, ["SPACE_OPS", "SPACE_SETTLE", "SYSTEM"]);
    const q = req.query as Record<string, unknown>;
    return listRevenueEvents(tx, { type: optFilter(q, "type"), vc: optFilter(q, "vc") }, parsePage(q));
  }));
  // 감상 매출(다음 작업 13): 기간 수익 풀(구독·광고) 등록과 조합별 재생 비중 배정. 정산 담당이 한다.
  app.post<{ Body: PoolInput }>("/traffic-pools", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => createPool(tx, deps.clock, actor, req.body ?? {}))));
  app.post<{ Params: { id: string } }>("/traffic-pools/:id/allocate", async (req) =>
    withActor(deps, req, (tx, actor) => allocatePool(deps.ctx, tx, deps.clock, actor, req.params.id, onRefund, onRevision)));
  app.get("/traffic-pools", async (req) => withActor(deps, req, async (tx, actor) => { requireAnyRole(actor, ["SPACE_OPS", "SPACE_SETTLE"]); return listPools(tx); }));
  app.get<{ Params: { id: string } }>("/traffic-pools/:id", async (req) =>
    withActor(deps, req, async (tx, actor) => { requireAnyRole(actor, ["SPACE_OPS", "SPACE_SETTLE"]); return getPool(tx, req.params.id); }));
}

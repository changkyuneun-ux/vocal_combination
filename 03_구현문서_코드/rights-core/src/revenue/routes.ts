import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { ingestRevenue, type RefundHook, type RevenueInput } from "./service.ts";

/** 환불 후속 처리(onRefund)는 조립하는 쪽(http/server.ts)이 넘긴다 — revenue는 settlement를 import하지 않는다. */
export function revenueRoutes(app: FastifyInstance, deps: Deps, onRefund: RefundHook): void {
  app.post<{ Body: RevenueInput }>("/revenue-events", async (req, reply) => {
    const r = await withActor(deps, req, (tx, actor) => ingestRevenue(tx, deps.clock, actor, req.body, onRefund));
    return reply.status(r.created ? 201 : 200).send(r);
  });
}

import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { ingestRevenue, type RevenueInput } from "./service.ts";
import { refundHook } from "../settlement/service.ts";

export function revenueRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: RevenueInput }>("/revenue-events", async (req, reply) => {
    const r = await withActor(deps, req, (tx, actor) => ingestRevenue(tx, deps.clock, actor, req.body, refundHook(deps.jobs)));
    return reply.status(r.created ? 201 : 200).send(r);
  });
}

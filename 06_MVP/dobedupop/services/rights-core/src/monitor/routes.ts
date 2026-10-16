import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError } from "../platform/errors.ts";
import { impactOf } from "./impact.ts";
import { pipelineSignals } from "./signals.ts";
import { traceCombination, traceEvent, traceParty } from "./trace.ts";

/** ⑧ 권리 파이프라인 관제(운영 채널): 단계별 신호, 한 건 추적, 영향 분석. 전부 읽기 전용이다. */
export function monitorRoutes(app: FastifyInstance, deps: Deps): void {
  const q = (req: { query: unknown }) => req.query as Record<string, string | undefined>;
  app.get("/pipeline/signals", async (req) => withActor(deps, req, (tx) => pipelineSignals(tx, deps.clock.now())));
  app.get("/trace", async (req) => withActor(deps, req, async (tx) => {
    const { vc, event, party } = q(req);
    if (vc) return { start: { vcId: vc }, ...(await traceCombination(tx, vc)) };
    if (event) return traceEvent(tx, event);
    if (party) return traceParty(tx, party);
    throw new DomainError("BAD_REQUEST", 400, "one of vc, event or party is required");
  }));
  app.get("/impact", async (req) => withActor(deps, req, (tx) => {
    const { consent, dispute, claim } = q(req);
    return impactOf(tx, { ...(consent && { consent }), ...(dispute && { dispute }), ...(claim && { claim }) });
  }));
}

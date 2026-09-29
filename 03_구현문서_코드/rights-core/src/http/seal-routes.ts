import type { FastifyInstance } from "fastify";
import { loadSealed } from "../engine-bridge/seal-store.ts";
import { rederiveIssue } from "../engine-bridge/issue.ts";
import type { Deps } from "./server.ts";

/** 봉인 조회와 발행 봉인 재도출. 조회 전용이라 신원을 요구하지 않는다(PoC). */
export function sealRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { digest: string } }>("/seals/:digest", async (req) => deps.db.tx((tx) => loadSealed(deps.ctx, tx, req.params.digest)));
  app.get<{ Params: { snapshotId: string } }>("/issues/:snapshotId/audit", async (req) => deps.db.tx((tx) => rederiveIssue(deps.ctx, tx, req.params.snapshotId)));
}

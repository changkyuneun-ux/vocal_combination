import type { FastifyInstance } from "fastify";
import { loadSealed } from "../engine-bridge/seal-store.ts";
import { rederiveIssue } from "../engine-bridge/issue.ts";
import type { Deps } from "./server.ts";

/**
 * 봉인 조회와 발행 봉인 재도출.
 * PoC 전용: 신원 없이 읽는다. 서버는 127.0.0.1에만 바인딩하며, 봉인된 facts에는 PRIVATE claim도 들어 있으므로
 * 이 경로는 그대로 외부에 열면 안 된다(I-2에서 인증·가시성 필터를 붙인다 — 통합 설계 9.6).
 */
export function sealRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { digest: string } }>("/seals/:digest", async (req) => deps.db.tx((tx) => loadSealed(deps.ctx, tx, req.params.digest)));
  app.get<{ Params: { snapshotId: string } }>("/issues/:snapshotId/audit", async (req) => deps.db.tx((tx) => rederiveIssue(deps.ctx, tx, req.params.snapshotId)));
}

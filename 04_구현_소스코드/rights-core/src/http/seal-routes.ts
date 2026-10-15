import type { FastifyInstance } from "fastify";
import { loadSealed } from "../engine-bridge/seal-store.ts";
import { rederiveIssue } from "../engine-bridge/issue.ts";
import { withSystemScope } from "../platform/actor.ts";
import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { withActor, type Deps } from "./server.ts";

/**
 * 봉인은 내용 주소라 여러 테넌트가 같은 봉인을 가리킬 수 있다. 그래서 봉인 자체에는 소유자가 없고,
 * 요청자 범위에서 보이는 행(정책 버전·발행 봉인·정산 run·역분개·배치)이 그 digest를 가리킬 때만 내용을 돌려준다.
 */
async function sealVisible(tx: Tx, digest: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM policy_version WHERE policy_digest = $1 OR facts_digest = $1
     UNION ALL SELECT 1 FROM issue_seal WHERE $1 IN (facts_digest, policy_digest, projection_digest, members_digest)
     UNION ALL SELECT 1 FROM settlement_run WHERE $1 IN (events_digest, result_digest)
     UNION ALL SELECT 1 FROM reversal_run WHERE result_digest = $1
     UNION ALL SELECT 1 FROM settlement_batch WHERE batch_manifest_digest = $1
     LIMIT 1`, [digest],
  );
  return r.rowCount !== 0;
}

/** 봉인 조회와 발행 봉인 재도출. 둘 다 요청자 범위에서 보이는 대상만 다룬다. */
export function sealRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { digest: string } }>("/seals/:digest", async (req) => withActor(deps, req, async (tx) => {
    if (!(await sealVisible(tx, req.params.digest))) throw notFound("sealed document", req.params.digest);
    return loadSealed(deps.ctx, tx, req.params.digest);
  }));
  app.get<{ Params: { snapshotId: string } }>("/issues/:snapshotId/audit", async (req) => withActor(deps, req, async (tx) => {
    if ((await tx.query("SELECT 1 FROM rights_snapshot WHERE snapshot_id = $1", [req.params.snapshotId])).rowCount === 0) throw notFound("issue seal", req.params.snapshotId);
    return withSystemScope(tx, () => rederiveIssue(deps.ctx, tx, req.params.snapshotId));
  }));
}

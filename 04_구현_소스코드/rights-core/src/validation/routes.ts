import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { optFilter } from "../platform/paging.ts";
import { notFound } from "../platform/errors.ts";
import { acceptIssue, dismissIssue, listIssues, requestAcceptance, revalidate, setEnforcement } from "./service.ts";

/** 정합성 검증(원천 문서 설계 S3a): 곡 단위 점검, 이슈 큐, 위험 수용·오탐 처리, 적용 범위. 권리자 포털·운영 백오피스. */
export function validationRoutes(app: FastifyInstance, deps: Deps): void {
  const q0 = (req: { query: unknown }) => req.query as Record<string, unknown>;
  // 범위는 요청자에게 보여야 한다(RLS). 점검은 그때 다시 검사한다.
  app.get<{ Params: { id: string } }>("/scopes/:id/validation", async (req) => withActor(deps, req, async (tx) => {
    if ((await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [req.params.id])).rowCount === 0) throw notFound("facts scope", req.params.id);
    return revalidate(tx, deps.clock, req.params.id);
  }));
  app.get("/validation-issues", async (req) => withActor(deps, req, (tx) => listIssues(tx, {
    ...(optFilter(q0(req), "status") !== undefined && { status: optFilter(q0(req), "status") }),
    ...(optFilter(q0(req), "severity") !== undefined && { severity: optFilter(q0(req), "severity") }),
    ...(optFilter(q0(req), "scope") !== undefined && { scope: optFilter(q0(req), "scope") }),
  })));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/validation-issues/:id/acceptance-request", async (req) =>
    withActor(deps, req, (tx, actor) => requestAcceptance(tx, deps.clock, actor, Number(req.params.id), req.body?.reason)));
  app.post<{ Params: { id: string } }>("/validation-issues/:id/accept", async (req) => withActor(deps, req, (tx, actor) => acceptIssue(tx, deps.clock, actor, Number(req.params.id))));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/validation-issues/:id/dismiss", async (req) =>
    withActor(deps, req, (tx, actor) => dismissIssue(tx, deps.clock, actor, Number(req.params.id), req.body?.reason)));
  app.put<{ Params: { id: string }; Body: { enforced?: boolean } }>("/tenants/:id/validation", async (req) =>
    withActor(deps, req, (tx, actor) => setEnforcement(tx, deps.clock, actor, req.params.id, req.body?.enforced)));
}

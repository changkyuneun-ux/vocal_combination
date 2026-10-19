import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import { withSystemScope } from "../platform/actor.ts";
import { listParties } from "../registry/queries.ts";
import { tenantTerminateHooks } from "../platform/routes.ts";
import { decideAsset, decideLink, endLink, endLinksOfTenant, getLink, listAssetMappings, listLinks, proposeAsset, proposeLink, trustWorks } from "./links.ts";
import { DomainError } from "../platform/errors.ts";

/** 연결(신탁·유통): 권리자 포털·참여 기관 화면·운영 백오피스에 같은 표면을 둔다. 누가 무엇을 할지는 links.ts가 정한다. */
export function linkRoutes(app: FastifyInstance, deps: Deps): void {
  if (!tenantTerminateHooks.includes(endLinksOfTenant)) tenantTerminateHooks.push(endLinksOfTenant);
  const q = (req: { query: unknown }) => req.query as Record<string, unknown>;
  app.get("/links", async (req) => withActor(deps, req, (tx, actor) => listLinks(tx, actor, {
    ...(optFilter(q(req), "type") !== undefined && { type: optFilter(q(req), "type") }), ...(optFilter(q(req), "status") !== undefined && { status: optFilter(q(req), "status") }),
  })));
  app.get<{ Params: { id: string } }>("/links/:id", async (req) => withActor(deps, req, async (tx, actor) => {
    const visible = (await listLinks(tx, actor)).some((l) => l.linkId === req.params.id);
    if (!visible) throw new DomainError("NOT_FOUND", 404, `link not found: ${req.params.id}`);
    return getLink(tx, req.params.id);
  }));
  app.post("/links", async (req, reply) => reply.status(201).send(await withActor(deps, req, (tx, actor) => proposeLink(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));
  app.post<{ Params: { id: string } }>("/links/:id/confirm", async (req) => withActor(deps, req, (tx, actor) => decideLink(tx, deps.clock, actor, req.params.id, true)));
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>("/links/:id/decline", async (req) =>
    withActor(deps, req, (tx, actor) => decideLink(tx, deps.clock, actor, req.params.id, false, req.body?.reason)));
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>("/links/:id/end", async (req) =>
    withActor(deps, req, (tx, actor) => endLink(tx, deps.clock, actor, req.params.id, req.body?.reason)));
  /** 참여 기관 명부(활성): 연결을 제안할 상대를 고른다. 이름·유형만. */
  app.get("/participants", async (req) => withActor(deps, req, (tx) => withSystemScope(tx, async () => (await tx.query(
    "SELECT tenant_id, name, tenant_type FROM tenant WHERE org_class = 'PARTICIPANT' AND status = 'ACTIVE' ORDER BY name")).rows
    .map((r) => ({ tenantId: r.tenant_id as string, name: r.name as string, tenantType: r.tenant_type as string })))));
  /** 권리 테넌트 명부(활성): 유통 파트너가 유통 연결을 제안할 상대를 고른다. */
  app.get("/rights-tenants", async (req) => withActor(deps, req, (tx) => withSystemScope(tx, async () => (await tx.query(
    "SELECT tenant_id, name, tenant_type FROM tenant WHERE org_class = 'RIGHTS' AND status = 'ACTIVE' ORDER BY name")).rows
    .map((r) => ({ tenantId: r.tenant_id as string, name: r.name as string, tenantType: r.tenant_type as string })))));
  // 상품 대응(유통): 파트너 제안 → 권리 테넌트 확인.
  app.get("/asset-mappings", async (req) => withActor(deps, req, (tx, actor) => listAssetMappings(tx, actor)));
  app.post<{ Params: { partner: string; ext: string } }>("/asset-mappings/:partner/:ext/confirm", async (req) =>
    withActor(deps, req, (tx, actor) => decideAsset(tx, deps.clock, actor, req.params.partner, req.params.ext, true)));
  app.post<{ Params: { partner: string; ext: string } }>("/asset-mappings/:partner/:ext/decline", async (req) =>
    withActor(deps, req, (tx, actor) => decideAsset(tx, deps.clock, actor, req.params.partner, req.params.ext, false)));
}

/** 참여 기관 화면 전용: 신탁 작품(신탁단체), 상품 대응 제안(유통 파트너). */
export function participantRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/trust/works", async (req) => withActor(deps, req, (tx, actor) => trustWorks(tx, actor)));
  /** 공용 명부(결정 TD8): 신탁 연결을 요청할 작가를 찾는다. */
  app.get("/parties", async (req) => withActor(deps, req, (tx) => listParties(tx, {
    ...(optFilter(req.query as Record<string, unknown>, "type") !== undefined && { type: optFilter(req.query as Record<string, unknown>, "type") }), restrict: true,
  }, parsePage(req.query as Record<string, unknown>))));
  app.post("/asset-mappings", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => proposeAsset(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));
}

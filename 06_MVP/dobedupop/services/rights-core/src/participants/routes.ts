import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { optFilter } from "../platform/paging.ts";
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
  app.post("/asset-mappings", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => proposeAsset(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));
}

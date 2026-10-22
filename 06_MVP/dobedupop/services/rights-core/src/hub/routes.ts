import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import type { Actor } from "../platform/actor.ts";
import { optFilter } from "../platform/paging.ts";
import { getFile, listAssets, listFiles, mapAsset, receiveFile, retryFile, type HubHooks } from "./service.ts";
import { requirePermission } from "../platform/permissions.ts";

/** 파트너 채널: 리포트 파일 전송, 내 파일·줄별 결과(거부 사유), 내 자산 대응. 환불·대체 후속 처리는 조립하는 쪽이 넘긴다. */
export function partnerHubRoutes(app: FastifyInstance, deps: Deps, hooks: HubHooks): void {
  app.post("/inbound", async (req, reply) => {
    const out = await withActor(deps, req, (tx, actor) => receiveFile(deps.ctx, tx, deps.clock, hooks, actor, (req.body ?? {}) as Record<string, unknown>));
    return reply.status(out.created ? 201 : 200).send(out.file);
  });
  app.get("/inbound", async (req) => withActor(deps, req, (tx) => listFiles(tx)));
  app.get<{ Params: { id: string } }>("/inbound/:id", async (req) => withActor(deps, req, (tx) => getFile(tx, req.params.id)));
  app.get("/assets", async (req) => withActor(deps, req, (tx, actor) => listAssets(tx, actor.tenantId)));
}

/** 운영 채널: 연동 허브 파일·거부 큐 조회, 자산 대응 등록, 거부 줄 재처리. */
export function opsHubRoutes(app: FastifyInstance, deps: Deps, hooks: HubHooks): void {
  const viewer = (actor: Actor) => requirePermission(actor, "hub.view");
  app.get("/hub/files", async (req) => withActor(deps, req, (tx, actor) => { viewer(actor); return listFiles(tx); }));
  app.get<{ Params: { id: string } }>("/hub/files/:id", async (req) => withActor(deps, req, (tx, actor) => { viewer(actor); return getFile(tx, req.params.id); }));
  app.post<{ Params: { id: string } }>("/hub/files/:id/retry", async (req) =>
    withActor(deps, req, (tx, actor) => retryFile(deps.ctx, tx, deps.clock, hooks, actor, req.params.id)));
  app.get("/hub/assets", async (req) => withActor(deps, req, (tx, actor) => { viewer(actor); return listAssets(tx, optFilter(req.query as Record<string, unknown>, "tenant")); }));
  app.post("/hub/assets", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => mapAsset(tx, deps.clock, actor, (req.body ?? {}) as Record<string, unknown>))));
}

import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import type { Declared } from "../engine-bridge/activation.ts";
import { DomainError } from "../platform/errors.ts";
import * as issuance from "./service.ts";

export function issuanceRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: { packId: string; packCode: string; title: string; factsScopeId: string } }>("/packs", async (req, reply) => {
    await withActor(deps, req, (tx, actor) => issuance.createPack(tx, deps.clock, actor, req.body));
    return reply.status(201).send({});
  });
  app.put<{ Params: { id: string }; Body: Declared[] }>("/packs/:id/claimants", async (req) =>
    withActor(deps, req, async (tx, actor) => { if (!Array.isArray(req.body)) throw new DomainError("BAD_REQUEST", 400, "body must be an array"); await issuance.setPackClaimants(tx, deps.clock, actor, req.params.id, req.body); return {}; }));
  app.post<{ Params: { id: string } }>("/packs/:id/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await issuance.activatePack(deps.ctx, tx, deps.clock, actor, req.params.id); return {}; }));
  app.post<{ Body: issuance.IssueInput }>("/issues", async (req, reply) => {
    const seal = await withActor(deps, req, (tx, actor) => issuance.issue(deps.ctx, tx, deps.clock, actor, req.body));
    return reply.status(201).send(seal);
  });
}

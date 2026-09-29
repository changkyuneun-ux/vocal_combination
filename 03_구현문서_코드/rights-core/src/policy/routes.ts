import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError } from "../platform/errors.ts";
import * as policy from "./service.ts";

export function policyRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { policyId: string }; Body: { packId: string; sourceText: string } }>("/policies/:policyId/compile", async (req, reply) => {
    const { packId, sourceText } = req.body;
    if (typeof packId !== "string" || typeof sourceText !== "string") throw new DomainError("BAD_REQUEST", 400, "packId and sourceText are required strings");
    const out = await withActor(deps, req, (tx, actor) =>
      policy.compilePolicy(deps.ctx, tx, deps.clock, actor, { policyId: req.params.policyId, packId: req.body.packId, sourceText: req.body.sourceText }));
    return reply.status(201).send(out);
  });
  const ref = (p: { policyId: string; version: string }) => ({ policyId: p.policyId, version: Number(p.version) });
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/approve", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.approvePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.activatePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string } }>("/policies/:policyId/rebind", async (req) =>
    withActor(deps, req, (tx, actor) => policy.rebindPolicy(deps.ctx, tx, deps.clock, actor, req.params.policyId)));
}

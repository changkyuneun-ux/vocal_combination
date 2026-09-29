import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError } from "../platform/errors.ts";
import * as policy from "./service.ts";

export function policyRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { policyId: string }; Body: { packId: string; sourceText: string } }>("/policies/:policyId/compile", async (req, reply) => {
    const out = await withActor(deps, req, (tx, actor) => {
      const { packId, sourceText } = req.body ?? ({} as Partial<typeof req.body>);
      if (typeof packId !== "string" || typeof sourceText !== "string") throw new DomainError("BAD_REQUEST", 400, "packId and sourceText are required strings");
      return policy.compilePolicy(deps.ctx, tx, deps.clock, actor, { policyId: req.params.policyId, packId, sourceText });
    });
    return reply.status(201).send(out);
  });
  const ref = (p: { policyId: string; version: string }) => {
    const version = Number(p.version);
    if (!/^[0-9]+$/.test(p.version) || !Number.isSafeInteger(version) || version < 1) throw new DomainError("BAD_REQUEST", 400, `invalid policy version: ${p.version}`);
    return { policyId: p.policyId, version };
  };
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/approve", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.approvePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.activatePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string } }>("/policies/:policyId/rebind", async (req) =>
    withActor(deps, req, (tx, actor) => policy.rebindPolicy(deps.ctx, tx, deps.clock, actor, req.params.policyId)));
}

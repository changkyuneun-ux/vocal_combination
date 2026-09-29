import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import { requireRole } from "../platform/actor.ts";
import { withActor, type Deps } from "../http/server.ts";
import * as reg from "./service.ts";
import { closeDispute, openDispute } from "./disputes.ts";

export function registryRoutes(app: FastifyInstance, deps: Deps): void {
  const created = <B>(path: string, fn: (tx: any, body: B) => Promise<unknown>, required: readonly string[] = []) =>
    app.post(path, async (req, reply) => {
      const out = await withActor(deps, req, async (tx, actor) => {
        requireRole(actor, "RIGHTS_EDITOR");
        const body = req.body as Record<string, unknown>;
        const missing = required.filter((k) => body?.[k] === undefined);
        if (missing.length > 0) throw new DomainError("BAD_REQUEST", 400, `missing required fields: ${missing.join(", ")}`);
        return fn(tx, body as B);
      });
      return reply.status(201).send(out ?? {});
    });
  created<any>("/parties", (tx, b) => reg.registerParty(tx, deps.clock, b));
  created<any>("/works", (tx, b) => reg.registerWork(tx, deps.clock, b));
  created<any>("/scopes", (tx, b) => reg.createScope(tx, deps.clock, b));
  created<any>("/recordings", (tx, b) => reg.registerRecording(tx, deps.clock, b));
  created<any>("/slots", (tx, b) => reg.registerSlot(tx, b));
  created<any>("/stems", (tx, b) => reg.registerStem(tx, deps.clock, b));
  created<any>("/voices", (tx, b) => reg.registerVoice(tx, deps.clock, b));
  created<reg.ClaimDraft>("/claims", (tx, b) => reg.recordClaim(tx, deps.clock, b), ["claimId", "factsScopeId", "sourceId", "edge", "targetId", "shareBps", "status", "validFrom"]);
  created<reg.MandateDraft>("/mandates", (tx, b) => reg.recordMandate(tx, deps.clock, b), ["mandateId", "factsScopeId", "fromPartyId", "toPartyId", "rightKind", "shareBps", "status", "validFrom"]);
  created<any>("/disputes", (tx, b) => openDispute(tx, deps.clock, b));
  app.post<{ Params: { id: string }; Body: { resolution?: { shareBps?: number; targetId?: string } } }>("/disputes/:id/close", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "RIGHTS_EDITOR");
      await closeDispute(tx, deps.clock, { disputeId: req.params.id, ...(req.body?.resolution && { resolution: req.body.resolution }) });
      return {};
    }));
}

import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import { requireRole } from "../platform/actor.ts";
import { withActor, type Deps } from "../http/server.ts";
import * as reg from "./service.ts";
import { closeDispute, openDispute } from "./disputes.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import * as q from "./queries.ts";

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
  // 조회(로그인한 누구나)
  const q0 = (req: { query: unknown }) => req.query as Record<string, unknown>;
  app.get("/parties", async (req) => withActor(deps, req, (tx) => q.listParties(tx, { type: optFilter(q0(req), "type") }, parsePage(q0(req)))));
  app.get("/works", async (req) => withActor(deps, req, (tx) => q.listWorks(tx, {}, parsePage(q0(req)))));
  app.get<{ Params: { id: string } }>("/scopes/:id", async (req) => withActor(deps, req, (tx) => q.getScope(tx, req.params.id)));
  app.get<{ Params: { id: string } }>("/scopes/:id/facts", async (req) => withActor(deps, req, (tx) => q.getScopeFacts(tx, req.params.id)));
  app.get("/disputes", async (req) =>
    withActor(deps, req, (tx) => q.listDisputes(tx, { status: optFilter(q0(req), "status"), scope: optFilter(q0(req), "scope") }, parsePage(q0(req)))));
}

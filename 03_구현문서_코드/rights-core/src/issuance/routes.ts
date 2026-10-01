import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import type { Declared } from "../engine-bridge/activation.ts";
import { DomainError } from "../platform/errors.ts";
import * as issuance from "./service.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import * as q from "./queries.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** POST /issues 본문 모양 검사: 업무 규칙(슬롯·스템·합계)은 서비스가 본다. 모양이 틀리면 400. */
function parseIssueBody(body: unknown): issuance.IssueInput {
  const fail = (m: string) => new DomainError("BAD_REQUEST", 400, m);
  if (!isObject(body)) throw fail("body must be an object");
  const { packId, vcId, assignments, members } = body;
  if (typeof packId !== "string" || typeof vcId !== "string") throw fail("packId and vcId must be strings");
  if (!Array.isArray(assignments) || !assignments.every((a) => isObject(a) && typeof a.slotId === "string" && typeof a.stemId === "string")) {
    throw fail("assignments must be an array of {slotId, stemId} strings");
  }
  if (!isObject(members) || !Object.values(members).every((v) => Number.isInteger(v))) throw fail("members must be an object of integer bps");
  return {
    packId, vcId,
    assignments: assignments.map((a) => ({ slotId: a.slotId as string, stemId: a.stemId as string })),
    members: members as Record<string, number>,
  };
}

export function issuanceRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: { packId: string; packCode: string; title: string; factsScopeId: string } }>("/packs", async (req, reply) => {
    await withActor(deps, req, (tx, actor) => issuance.createPack(tx, deps.clock, actor, req.body));
    return reply.status(201).send({});
  });
  app.put<{ Params: { id: string }; Body: Declared[] }>("/packs/:id/claimants", async (req) =>
    withActor(deps, req, async (tx, actor) => { if (!Array.isArray(req.body)) throw new DomainError("BAD_REQUEST", 400, "body must be an array"); await issuance.setPackClaimants(tx, deps.clock, actor, req.params.id, req.body); return {}; }));
  app.post<{ Params: { id: string } }>("/packs/:id/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await issuance.activatePack(deps.ctx, tx, deps.clock, actor, req.params.id); return {}; }));
  app.post("/issues", async (req, reply) => {
    const seal = await withActor(deps, req, (tx, actor) => issuance.issue(deps.ctx, tx, deps.clock, actor, parseIssueBody(req.body)));
    return reply.status(201).send(seal);
  });
  // 조회(로그인한 누구나)
  const q0 = (req: { query: unknown }) => req.query as Record<string, unknown>;
  app.get("/packs", async (req) => withActor(deps, req, (tx) => q.listPacks(tx, {}, parsePage(q0(req)))));
  app.get<{ Params: { id: string } }>("/packs/:id", async (req) => withActor(deps, req, (tx) => q.getPack(tx, req.params.id)));
  app.get("/issues", async (req) =>
    withActor(deps, req, (tx) => q.listIssues(tx, { pack: optFilter(q0(req), "pack"), vc: optFilter(q0(req), "vc") }, parsePage(q0(req)))));
}

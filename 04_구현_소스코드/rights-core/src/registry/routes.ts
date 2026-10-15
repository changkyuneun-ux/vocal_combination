import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import { requireRole, type Actor } from "../platform/actor.ts";
import { withActor, type Deps } from "../http/server.ts";
import * as reg from "./service.ts";
import { closeDispute, openDispute } from "./disputes.ts";
import { getConsent, listConsents, recordContractConsents, revokeConsent, signConsent, type ConsentDraft } from "./consents.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import * as q from "./queries.ts";
import { parseRefs } from "../documents/service.ts";
import { rightsSummary } from "./summary.ts";

export function registryRoutes(app: FastifyInstance, deps: Deps): void {
  const q0 = (req: { query: unknown }) => req.query as Record<string, unknown>;
  const created = <B>(path: string, fn: (tx: any, body: B, actor: Actor) => Promise<unknown>, required: readonly string[] = []) =>
    app.post(path, async (req, reply) => {
      const out = await withActor(deps, req, async (tx, actor) => {
        requireRole(actor, "RIGHTS_EDITOR");
        const body = req.body as Record<string, unknown>;
        const missing = required.filter((k) => body?.[k] === undefined);
        if (missing.length > 0) throw new DomainError("BAD_REQUEST", 400, `missing required fields: ${missing.join(", ")}`);
        return fn(tx, body as B, actor);
      });
      return reply.status(201).send(out ?? {});
    });
  created<any>("/parties", (tx, b, actor) => {
    // 다른 테넌트 소속으로 파티를 만드는 것은 플랫폼 운영만 할 수 있다(권리자 온보딩 대행).
    if (b.tenantId !== undefined && b.tenantId !== actor.tenantId && actor.scope !== "platform") {
      throw new DomainError("TENANT_FORBIDDEN", 403, `${actor.userId} cannot register a party in tenant ${b.tenantId}`);
    }
    return reg.registerParty(tx, deps.clock, b);
  });
  created<any>("/works", (tx, b) => reg.registerWork(tx, deps.clock, b));
  created<any>("/scopes", (tx, b) => reg.createScope(tx, deps.clock, b));
  created<any>("/recordings", (tx, b) => reg.registerRecording(tx, deps.clock, b));
  created<any>("/slots", (tx, b) => reg.registerSlot(tx, b));
  created<any>("/stems", (tx, b) => reg.registerStem(tx, deps.clock, b));
  created<any>("/voices", (tx, b) => reg.registerVoice(tx, deps.clock, b));
  // 근거 문서(원천 문서 설계 S1): evidenceDocuments를 주면 증빙 digest를 시스템이 채우고, 연결한 사람은 요청자다.
  const withEvidence = <T extends { evidenceDocuments?: unknown; linkedBy?: string }>(b: T, actor: Actor): T => {
    const { linkedBy: _ignored, ...rest } = b;
    return (b.evidenceDocuments === undefined ? rest : { ...rest, evidenceDocuments: parseRefs(b.evidenceDocuments), linkedBy: actor.userId }) as T;
  };
  created<reg.ClaimDraft>("/claims", (tx, b, actor) => reg.recordClaim(tx, deps.clock, withEvidence(b, actor)), ["claimId", "factsScopeId", "sourceId", "edge", "targetId", "shareBps", "status", "validFrom"]);
  created<reg.MandateDraft>("/mandates", (tx, b, actor) => reg.recordMandate(tx, deps.clock, withEvidence(b, actor)), ["mandateId", "factsScopeId", "fromPartyId", "toPartyId", "rightKind", "shareBps", "status", "validFrom"]);
  created<any>("/disputes", (tx, b) => openDispute(tx, deps.clock, b));
  app.post<{ Params: { id: string }; Body: { resolution?: { shareBps?: number; targetId?: string } } }>("/disputes/:id/close", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "RIGHTS_EDITOR");
      await closeDispute(tx, deps.clock, { disputeId: req.params.id, ...(req.body?.resolution && { resolution: req.body.resolution }) });
      return {};
    }));
  // 이용허락 동의(다음 작업 2): 서명 권한은 signConsent가 정한다(실연 = 본인, 녹음·작품 = 파티 테넌트의 RIGHTS_EDITOR).
  app.post("/consents", async (req, reply) => {
    const b = req.body as ConsentDraft;
    const missing = ["consentId", "factsScopeId", "partyId", "rightType", "assetId", "scope", "validFrom", "validTo"].filter((k) => (b as any)?.[k] === undefined);
    if (missing.length > 0) throw new DomainError("BAD_REQUEST", 400, `missing required fields: ${missing.join(", ")}`);
    return reply.status(201).send(await withActor(deps, req, (tx, actor) => signConsent(tx, deps.clock, actor, b)));
  });
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/consents/:id/revoke", async (req) =>
    withActor(deps, req, (tx, actor) => revokeConsent(tx, deps.clock, actor, req.params.id, req.body?.reason ?? "")));
  app.post<{ Params: { id: string }; Body: { scope: ConsentDraft["scope"]; validFrom: string; validTo: string; contractUri: string } }>("/scopes/:id/contract-consents", async (req, reply) => {
    const b = req.body;
    if (!b?.scope || !b.validFrom || !b.validTo || !b.contractUri) throw new DomainError("BAD_REQUEST", 400, "missing required fields: scope, validFrom, validTo, contractUri");
    return reply.status(201).send({ recorded: await withActor(deps, req, (tx, actor) => recordContractConsents(tx, deps.clock, actor, { factsScopeId: req.params.id, ...b })) });
  });
  app.get<{ Params: { id: string } }>("/consents/:id", async (req) => withActor(deps, req, (tx) => getConsent(tx, req.params.id)));
  app.get("/consents", async (req) =>
    withActor(deps, req, (tx) => listConsents(tx, { ...(optFilter(q0(req), "scope") && { scope: optFilter(q0(req), "scope")! }), ...(optFilter(q0(req), "party") && { party: optFilter(q0(req), "party")! }) })));
  // 조회(로그인한 누구나)
  app.get("/parties", async (req) => withActor(deps, req, (tx) => q.listParties(tx, { type: optFilter(q0(req), "type") }, parsePage(q0(req)))));
  app.get("/works", async (req) => withActor(deps, req, (tx) => q.listWorks(tx, {}, parsePage(q0(req)))));
  app.get<{ Params: { id: string } }>("/scopes/:id", async (req) => withActor(deps, req, (tx) => q.getScope(tx, req.params.id)));
  app.get<{ Params: { id: string } }>("/scopes/:id/facts", async (req) => withActor(deps, req, (tx) => q.getScopeFacts(tx, req.params.id)));
  // 권리 요약(원천 문서 설계 S1): 사람이 읽는 문장 + 근거 문서 + 봉인 배지.
  app.get<{ Params: { id: string } }>("/scopes/:id/summary", async (req) => withActor(deps, req, (tx) => rightsSummary(tx, req.params.id)));
  app.get("/disputes", async (req) =>
    withActor(deps, req, (tx) => q.listDisputes(tx, { status: optFilter(q0(req), "status"), scope: optFilter(q0(req), "scope") }, parsePage(q0(req)))));
}

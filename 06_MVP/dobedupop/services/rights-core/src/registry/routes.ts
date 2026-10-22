import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import type { Actor } from "../platform/actor.ts";
import { withActor, type Deps } from "../http/server.ts";
import * as reg from "./service.ts";
import { closeDispute, openDispute } from "./disputes.ts";
import { getConsent, listConsents, recordContractConsents, revokeConsent, signConsent, type ConsentDraft } from "./consents.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import * as q from "./queries.ts";
import { parseRefs } from "../documents/service.ts";
import { rightsSummary } from "./summary.ts";
import { worksOverview } from "./overview.ts";
import { scopeReadiness } from "./readiness.ts";
import { linkClause } from "./evidence-links.ts";
import { revalidate } from "../validation/service.ts";
import { applyTrustOnClaim } from "../participants/links.ts";
import { assertMayRecordVerified, confirmRequest, counterpartyOf, declineRequest, listConfirmations, needsConfirmation, platformVerify, requestConfirmation } from "./confirmations.ts";
import { requirePermission } from "../platform/permissions.ts";
import { deleteCatalogRow, updateCatalogRow, type CatalogKind } from "./catalog.ts";

export function registryRoutes(app: FastifyInstance, deps: Deps): void {
  /** 기록이 속한 곡을 다시 검사한다(조항 연결 뒤). */
  const revalidateRecord = async (tx: any, type: string, id: string) => {
    const table = type === "CLAIM" ? "right_claim WHERE claim_id" : type === "MANDATE" ? "mandate WHERE mandate_id" : "consent_agreement WHERE consent_id";
    const s = (await tx.query(`SELECT facts_scope_id FROM ${table} = $1 LIMIT 1`, [id])).rows[0];
    if (s !== undefined) await revalidate(tx, deps.clock, s.facts_scope_id);
  };
  const q0 = (req: { query: unknown }) => req.query as Record<string, unknown>;
  /**
   * 등록 권한: 권리 테넌트는 rights.edit. 플랫폼 운영은 권리를 등록하지 않고(결정 TD3) 당사자 등록만 party.register_platform(온보딩)으로 한다.
   * (플랫폼 RIGHTS_EDITOR는 이제 발급할 수 없다. 기존 개발·시험 계정만 남아 있다.)
   */
  const created = <B>(path: string, fn: (tx: any, body: B, actor: Actor) => Promise<unknown>, required: readonly string[] = []) =>
    app.post(path, async (req, reply) => {
      const out = await withActor(deps, req, async (tx, actor) => {
        if (actor.scope === "platform" && path === "/parties") requirePermission(actor, "party.register_platform");
        else requirePermission(actor, "rights.edit");
        const body = req.body as Record<string, unknown>;
        const missing = required.filter((k) => body?.[k] === undefined);
        if (missing.length > 0) throw new DomainError("BAD_REQUEST", 400, `missing required fields: ${missing.join(", ")}`);
        return fn(tx, body as B, actor);
      });
      return reply.status(201).send(out ?? {});
    });
  created<any>("/parties", async (tx, b, actor) => {
    // 다른 테넌트 소속으로 파티를 만드는 것은 플랫폼 운영만 할 수 있다(권리자 온보딩 대행).
    if (b.tenantId !== undefined && b.tenantId !== actor.tenantId && actor.scope !== "platform") {
      throw new DomainError("TENANT_FORBIDDEN", 403, `${actor.userId} cannot register a party in tenant ${b.tenantId}`);
    }
    await reg.assertPartyAdmissible(tx, b.tenantId ?? actor.tenantId, b);
    return reg.registerParty(tx, deps.clock, b);
  });
  created<any>("/works", (tx, b) => reg.registerWork(tx, deps.clock, b));
  created<any>("/scopes", (tx, b) => reg.createScope(tx, deps.clock, b));
  created<any>("/recordings", async (tx, b, actor) => {
    await reg.registerRecording(tx, deps.clock, b);
    if (b.masterClaim !== undefined) await recordMasterClaim(tx, actor, b);
  });
  created<any>("/slots", (tx, b) => reg.registerSlot(tx, deps.clock, b));
  created<any>("/slot-parts", (tx, b) => reg.registerSlotPart(tx, deps.clock, b.slotId, b), ["slotId", "partNo", "kind", "startMs", "endMs"]);
  created<any>("/stems", async (tx, b, actor) => {
    await reg.registerStem(tx, deps.clock, b);
    if (b.withClaims === true && b.rightsBearing === true && typeof b.performerPartyId === "string") await recordPerformerClaims(tx, actor, b);
  });
  created<any>("/voices", (tx, b) => reg.registerVoice(tx, deps.clock, b));
  // IR 생성 전 수정·삭제(결정 ID1): 봉인된 적이 있으면 409 CATALOG_SEALED, 다른 행이 가리키면 409 CATALOG_IN_USE.
  const catalogPaths: [CatalogKind, string][] = [
    ["work", "/works/:id"], ["recording", "/recordings/:id"], ["slot", "/slots/:id"], ["slot-part", "/slot-parts/:id/:partNo"], ["stem", "/stems/:id"], ["voice", "/voices/:id"],
  ];
  const catalogKey = (p: { id: string; partNo?: string }) => (p.partNo === undefined ? [p.id] : [p.id, p.partNo]);
  for (const [kind, path] of catalogPaths) {
    if (kind !== "voice") {
      app.put<{ Params: { id: string; partNo?: string } }>(path, async (req) => withActor(deps, req, async (tx, actor) => {
        requirePermission(actor, "rights.edit");
        const out = await updateCatalogRow(tx, deps.clock, actor, kind, catalogKey(req.params), (req.body ?? {}) as Record<string, unknown>);
        if (out.scopeId !== undefined) await revalidate(tx, deps.clock, out.scopeId);
        return out.row;
      }));
    }
    app.delete<{ Params: { id: string; partNo?: string } }>(path, async (req, reply) => {
      await withActor(deps, req, async (tx, actor) => {
        requirePermission(actor, "rights.edit");
        const out = await deleteCatalogRow(tx, deps.clock, actor, kind, catalogKey(req.params));
        if (out.scopeId !== undefined) await revalidate(tx, deps.clock, out.scopeId);
      });
      return reply.status(204).send();
    });
  }
  // 근거 문서(원천 문서 설계 S1): evidenceDocuments를 주면 증빙 digest를 시스템이 채우고, 연결한 사람은 요청자다.
  const withEvidence = <T extends { evidenceDocuments?: unknown; linkedBy?: string }>(b: T, actor: Actor): T => {
    const { linkedBy: _ignored, ...rest } = b;
    return (b.evidenceDocuments === undefined ? rest : { ...rest, evidenceDocuments: parseRefs(b.evidenceDocuments), linkedBy: actor.userId }) as T;
  };
  // 상대 당사자 확인(원천 문서 설계 S3, 결정 D5): 확인 대상 기록을 VERIFIED로 바로 쓰는 것은 플랫폼과 상대 본인만.
  // ASSERTED로 쓰면 상대에게 확인 요청이 자동으로 간다.
  const recordWithConfirmation = async (tx: any, actor: Actor, type: "CLAIM" | "MANDATE", b: any, write: () => Promise<reg.Recorded>) => {
    await assertMayRecordVerified(tx, actor, type, b);
    const rec = await write();
    // 신탁 연결(결정 TD11): 신탁한 작가의 작품 몫 주장이 새 곡에 생기면 그 곡에도 신탁단체 수령 위임을 단다.
    if (type === "CLAIM" && b.edge === "WRITTEN_BY") await applyTrustOnClaim(tx, deps.clock, b.factsScopeId, b.targetId, actor.userId);
    if (b.status === "ASSERTED" && needsConfirmation(type, b.edge)) {
      const cp = await counterpartyOf(tx, type, b);
      if (!(actor.partyId === cp)) await requestConfirmation(tx, deps.clock, actor, type, rec.id);
    }
    await revalidate(tx, deps.clock, b.factsScopeId); // 정합성 검증(원천 문서 설계 S3a): 기록이 바뀌면 곡을 다시 검사한다
    return rec;
  };
  // 녹음·스템 등록 때 권리 주장 함께 만들기(결정 ID2·ID3, SL3). 확인 요청·신탁·정합성 재검사는 /claims와 같은 경로를 탄다.
  const scopeOfWork = async (tx: any, workId: string): Promise<string> => {
    const s = (await tx.query("SELECT facts_scope_id FROM facts_scope WHERE work_id = $1", [workId])).rows[0];
    if (s === undefined) throw new DomainError("INVALID_REFERENCE", 422, `work ${workId} has no facts scope; create the scope before recording claims`);
    return s.facts_scope_id as string;
  };
  /** 녹음 권리: 녹음 → 마스터 보유 당사자 100%. 요청자가 바로 VERIFIED로 쓸 수 있으면 VERIFIED, 아니면 ASSERTED(상대 확인 요청). */
  const recordMasterClaim = async (tx: any, actor: Actor, b: any) => {
    const draft: any = {
      claimId: `c_master_${b.recordingId}`, factsScopeId: await scopeOfWork(tx, b.workId), sourceId: b.recordingId, edge: "CONTROLLED_BY",
      targetId: b.masterOwnerPartyId, shareBps: 10000, status: "VERIFIED", validFrom: deps.clock.now(),
      ...(b.masterClaim?.evidenceDocuments !== undefined && { evidenceDocuments: b.masterClaim.evidenceDocuments }),
    };
    try { await assertMayRecordVerified(tx, actor, "CLAIM", draft); } catch (e) {
      if (!(e instanceof DomainError && e.code === "CONFIRMATION_REQUIRED")) throw e;
      draft.status = "ASSERTED";
    }
    return recordWithConfirmation(tx, actor, "CLAIM", draft, () => reg.recordClaim(tx, deps.clock, withEvidence(draft, actor)));
  };
  /** 실연: 실연자의 범위 보이스(없으면 보이스 + 소유 주장)와 스템 → 보이스 실연 주장. 둘 다 ASSERTED(본인 확인 요청). */
  const recordPerformerClaims = async (tx: any, actor: Actor, b: any) => {
    const scopeId = await scopeOfWork(tx, (await tx.query("SELECT work_id FROM recording_version WHERE recording_id = $1", [b.recordingId])).rows[0].work_id);
    const voiceId = reg.voiceIdFor(b.performerPartyId);
    const validFrom = deps.clock.now();
    if ((await tx.query("SELECT 1 FROM voice WHERE voice_id = $1", [voiceId])).rows.length === 0) {
      await reg.registerVoice(tx, deps.clock, { voiceId, factsScopeId: scopeId, kind: "HUMAN" });
      const own = { claimId: `c_own_${voiceId}`, factsScopeId: scopeId, sourceId: voiceId, edge: "OWNED_BY", targetId: b.performerPartyId, shareBps: 10000, status: "ASSERTED", validFrom };
      await recordWithConfirmation(tx, actor, "CLAIM", own, () => reg.recordClaim(tx, deps.clock, own as reg.ClaimDraft));
    }
    const perf = { claimId: `c_perf_${b.stemId}`, factsScopeId: scopeId, sourceId: b.stemId, edge: "PERFORMED_BY", targetId: voiceId, shareBps: 10000, performerRole: "FEATURED", status: "ASSERTED", validFrom };
    await recordWithConfirmation(tx, actor, "CLAIM", perf, () => reg.recordClaim(tx, deps.clock, perf as reg.ClaimDraft));
  };
  created<reg.ClaimDraft>("/claims", (tx, b, actor) => recordWithConfirmation(tx, actor, "CLAIM", b, () => reg.recordClaim(tx, deps.clock, withEvidence(b, actor))), ["claimId", "factsScopeId", "sourceId", "edge", "targetId", "shareBps", "status", "validFrom"]);
  created<reg.MandateDraft>("/mandates", (tx, b, actor) => recordWithConfirmation(tx, actor, "MANDATE", b, () => reg.recordMandate(tx, deps.clock, withEvidence(b, actor))), ["mandateId", "factsScopeId", "fromPartyId", "toPartyId", "rightKind", "shareBps", "status", "validFrom"]);
  created<any>("/disputes", (tx, b) => openDispute(tx, deps.clock, b));
  app.post<{ Params: { id: string }; Body: { resolution?: { shareBps?: number; targetId?: string } } }>("/disputes/:id/close", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requirePermission(actor, "rights.edit");
      await closeDispute(tx, deps.clock, { disputeId: req.params.id, ...(req.body?.resolution && { resolution: req.body.resolution }) });
      return {};
    }));
  // 이용허락 동의(다음 작업 2): 서명 권한은 signConsent가 정한다(실연 = 본인, 녹음·작품 = 파티 테넌트의 RIGHTS_EDITOR).
  app.post("/consents", async (req, reply) => {
    const b = req.body as ConsentDraft;
    const missing = ["consentId", "factsScopeId", "partyId", "rightType", "assetId", "scope", "validFrom", "validTo"].filter((k) => (b as any)?.[k] === undefined);
    if (missing.length > 0) throw new DomainError("BAD_REQUEST", 400, `missing required fields: ${missing.join(", ")}`);
    return reply.status(201).send(await withActor(deps, req, async (tx, actor) => {
      const c = await signConsent(tx, deps.clock, actor, b);
      await revalidate(tx, deps.clock, c.factsScopeId);
      return c;
    }));
  });
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/consents/:id/revoke", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      const c = await revokeConsent(tx, deps.clock, actor, req.params.id, req.body?.reason ?? "");
      await revalidate(tx, deps.clock, c.factsScopeId);
      return c;
    }));
  app.post<{ Params: { id: string }; Body: { scope: ConsentDraft["scope"]; validFrom: string; validTo: string; contractUri: string } }>("/scopes/:id/contract-consents", async (req, reply) => {
    const b = req.body;
    if (!b?.scope || !b.validFrom || !b.validTo || !b.contractUri) throw new DomainError("BAD_REQUEST", 400, "missing required fields: scope, validFrom, validTo, contractUri");
    return reply.status(201).send({ recorded: await withActor(deps, req, (tx, actor) => recordContractConsents(tx, deps.clock, actor, { factsScopeId: req.params.id, ...b })) });
  });
  app.get<{ Params: { id: string } }>("/consents/:id", async (req) => withActor(deps, req, (tx) => getConsent(tx, req.params.id)));
  app.get("/consents", async (req) =>
    withActor(deps, req, (tx) => listConsents(tx, { ...(optFilter(q0(req), "scope") && { scope: optFilter(q0(req), "scope")! }), ...(optFilter(q0(req), "party") && { party: optFilter(q0(req), "party")! }) })));
  // 조회(로그인한 누구나)
  app.get("/parties", async (req) => withActor(deps, req, (tx, actor) => q.listParties(tx, {
    type: optFilter(q0(req), "type"), ...(optFilter(q0(req), "tenant") !== undefined && { tenant: optFilter(q0(req), "tenant") }),
    ...(optFilter(q0(req), "id") !== undefined && { id: optFilter(q0(req), "id") }), restrict: actor.scope !== "platform",
  }, parsePage(q0(req)))));
  app.get("/works", async (req) => withActor(deps, req, (tx) => q.listWorks(tx, {}, parsePage(q0(req)))));
  /** 보이는 곡(facts 범위) 목록: 화면의 곡 선택에 쓴다. 테넌트는 자기 곡만(RLS). */
  app.get("/scopes", async (req) => withActor(deps, req, async (tx) => (await tx.query(
    "SELECT s.facts_scope_id, s.work_id, w.title FROM facts_scope s JOIN work w ON w.work_id = s.work_id ORDER BY w.title, s.facts_scope_id LIMIT 500")).rows
    .map((r) => ({ factsScopeId: r.facts_scope_id as string, workId: r.work_id as string, title: r.title as string }))));
  app.get<{ Params: { id: string } }>("/scopes/:id", async (req) => withActor(deps, req, (tx) => q.getScope(tx, req.params.id)));
  app.get<{ Params: { id: string } }>("/scopes/:id/facts", async (req) => withActor(deps, req, (tx) => q.getScopeFacts(tx, req.params.id)));
  // 조항 → 기록 근거 연결, 확인 요청(원천 문서 설계 S3).
  app.post<{ Params: { cid: string } }>("/clauses/:cid/links", async (req, reply) => reply.status(201).send(await withActor(deps, req, async (tx, actor) => {
    if (actor.scope !== "platform") requirePermission(actor, "rights.edit");
    const out = await linkClause(tx, deps.clock, actor, req.params.cid, (req.body ?? {}) as Record<string, unknown>);
    await revalidateRecord(tx, out.recordType, out.recordId);
    return out;
  })));
  app.get("/confirmations", async (req) => withActor(deps, req, (tx) => listConfirmations(tx, {
    ...(optFilter(q0(req), "status") !== undefined && { status: optFilter(q0(req), "status") }), ...(optFilter(q0(req), "party") !== undefined && { party: optFilter(q0(req), "party") }),
  })));
  app.post<{ Body: { recordType?: string; recordId?: string } }>("/confirmations", async (req, reply) => reply.status(201).send(await withActor(deps, req, (tx, actor) => {
    const b = req.body ?? {};
    if ((b.recordType !== "CLAIM" && b.recordType !== "MANDATE") || typeof b.recordId !== "string") throw new DomainError("BAD_REQUEST", 400, "recordType (CLAIM | MANDATE) and recordId are required");
    return requestConfirmation(tx, deps.clock, actor, b.recordType, b.recordId);
  })));
  const decided = async (tx: any, r: { factsScopeId: string }) => { await revalidate(tx, deps.clock, r.factsScopeId); return r; };
  app.post<{ Params: { id: string } }>("/confirmations/:id/confirm", async (req) => withActor(deps, req, async (tx, actor) => decided(tx, await confirmRequest(tx, deps.clock, actor, Number(req.params.id)))));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/confirmations/:id/decline", async (req) =>
    withActor(deps, req, async (tx, actor) => decided(tx, await declineRequest(tx, deps.clock, actor, Number(req.params.id), req.body?.reason))));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/confirmations/:id/platform-verify", async (req) =>
    withActor(deps, req, async (tx, actor) => decided(tx, await platformVerify(tx, deps.clock, actor, Number(req.params.id), req.body?.reason))));
  // 권리 요약(원천 문서 설계 S1): 사람이 읽는 문장 + 근거 문서 + 봉인 배지.
  app.get<{ Params: { id: string } }>("/scopes/:id/summary", async (req) => withActor(deps, req, (tx) => rightsSummary(tx, req.params.id)));
  // 포털 작품 목록·곡 워크스페이스(2부-B): 작품 개요(진행 단계)와 IR 생성 준비. 조회라 보이는 곡이면 된다(RLS).
  app.get("/works/overview", async (req) => withActor(deps, req, (tx) => worksOverview(tx)));
  app.get<{ Params: { id: string } }>("/scopes/:id/readiness", async (req) => withActor(deps, req, (tx) => scopeReadiness(tx, req.params.id, deps.clock.now())));
  app.get("/disputes", async (req) =>
    withActor(deps, req, (tx) => q.listDisputes(tx, { status: optFilter(q0(req), "status"), scope: optFilter(q0(req), "scope") }, parsePage(q0(req)))));
}

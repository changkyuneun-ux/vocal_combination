import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { withSystemScope } from "../platform/actor.ts";
import { DomainError } from "../platform/errors.ts";
import { optFilter, pagedOr } from "../platform/paging.ts";
import type { SignatureProvider } from "./esign.ts";
import {
  approveTemplateVersion, authorTemplateVersion, cancelContract, completeContract, createContract, getContract, getTemplate, listContracts, listTemplates,
  previewContract, providerSigned, signContract,
} from "./service.ts";
import { approveFrame, listFrames, registerFrame } from "./frames.ts";
import { getImport, listClaimConfirmations, listImports, previewConfirmation, sendConfirmation, setGaps, setValue, startImport } from "./imports.ts";

export function esignOf(deps: Deps): SignatureProvider {
  if (deps.esign === undefined) throw new DomainError("ESIGN_NOT_CONFIGURED", 503, "e-signature provider is not configured");
  return deps.esign;
}

type P = { Params: { id: string; v: string } };
const body = (req: { body: unknown }) => (req.body ?? {}) as Record<string, unknown>;

/** 표준 계약(원천 문서 설계 S4): 템플릿 조회·법무 개정, 마법사 미리보기·서명 요청·서명·기록 반영. 권리자 포털·운영 백오피스. */
export function contractRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/contract-templates", async (req) => withActor(deps, req, (tx) => listTemplates(tx)));
  app.get<P>("/contract-templates/:id", async (req) => withActor(deps, req, (tx) => getTemplate(tx, req.params.id)));
  app.post<P>("/contract-templates/:id/versions", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => authorTemplateVersion(tx, deps.clock, actor, req.params.id, body(req)))));
  app.post<P>("/contract-templates/:id/versions/:v/approve", async (req) =>
    withActor(deps, req, (tx, actor) => approveTemplateVersion(tx, deps.clock, actor, req.params.id, Number(req.params.v))));
  app.post("/contracts/preview", async (req) => withActor(deps, req, (tx, actor) => previewContract(tx, actor, body(req))));
  app.post("/contracts", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => createContract(tx, deps.clock, actor, esignOf(deps), body(req)))));
  signerRoutes(app, deps);
  app.post<P>("/contracts/:id/complete", async (req) => withActor(deps, req, (tx, actor) => {
    if (deps.documents === undefined) throw new DomainError("DOCUMENTS_NOT_CONFIGURED", 503, "source document storage is not configured");
    return completeContract(tx, deps.clock, actor, deps.documents, esignOf(deps), req.params.id);
  }));
  app.post<P>("/contracts/:id/cancel", async (req) => withActor(deps, req, (tx, actor) => cancelContract(tx, deps.clock, actor, req.params.id)));
  importRoutes(app, deps);
}

type K = { Params: { id: string; key: string; v: string } };
/** 계약서 불러오기(3부-B, 결정 CT1~CT5): 읽기 틀, 불러오기 세션, 권리 확인서. */
export function importRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/reading-frames", async (req) => withActor(deps, req, async (tx) => pagedOr(req.query as Record<string, unknown>, await listFrames(tx))));
  app.post("/reading-frames", async (req, reply) => reply.status(201).send(await withActor(deps, req, (tx, actor) => registerFrame(tx, deps.clock, actor, body(req)))));
  app.post<K>("/reading-frames/:id/versions/:v/approve", async (req) => withActor(deps, req, (tx, actor) => approveFrame(tx, deps.clock, actor, req.params.id, Number(req.params.v))));
  app.get<K>("/scopes/:id/imports", async (req) => withActor(deps, req, (tx) => listImports(tx, deps.clock, req.params.id)));
  app.post<K>("/scopes/:id/imports", async (req, reply) => reply.status(201).send(await withActor(deps, req, (tx, actor) => startImport(tx, deps.clock, actor, req.params.id, body(req)))));
  app.get<K>("/scopes/:id/claim-confirmations", async (req) => withActor(deps, req, (tx) => listClaimConfirmations(tx, req.params.id)));
  app.get<K>("/imports/:id", async (req) => withActor(deps, req, (tx) => getImport(tx, deps.clock, req.params.id)));
  app.post<K>("/imports/:id/values/:key", async (req) => withActor(deps, req, (tx, actor) => setValue(tx, deps.clock, actor, req.params.id, req.params.key, body(req))));
  app.post<K>("/imports/:id/gaps", async (req) => withActor(deps, req, (tx, actor) => setGaps(tx, deps.clock, actor, req.params.id, body(req))));
  app.get<K>("/imports/:id/confirmation", async (req) => withActor(deps, req, (tx, actor) => previewConfirmation(tx, deps.clock, actor, req.params.id, (req.query as Record<string, unknown>).kind)));
  app.post<K>("/imports/:id/confirmation", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => sendConfirmation(tx, deps.clock, actor, esignOf(deps), req.params.id, body(req).kind))));
}

/** 서명 당사자 표면(포털·운영·실연자 앱): 나에게 온 계약 보기와 서명. 보이는 범위는 RLS(만든 테넌트·서명 당사자)가 정한다. */
export function signerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/contracts", async (req) => withActor(deps, req, (tx) => {
    const q = req.query as Record<string, unknown>;
    const template = optFilter(q, "template");
    return listContracts(tx, { ...(optFilter(q, "scope") !== undefined && { scope: optFilter(q, "scope") }), ...(optFilter(q, "status") !== undefined && { status: optFilter(q, "status") }) })
      .then((rows) => pagedOr(q, template === undefined ? rows : rows.filter((c) => c.templateId === template)));
  }));
  app.get<P>("/contracts/:id", async (req) => withActor(deps, req, (tx) => getContract(tx, req.params.id)));
  app.post<P & { Body: { partyId?: string } }>("/contracts/:id/sign", async (req) =>
    withActor(deps, req, (tx, actor) => signContract(tx, deps.clock, actor, esignOf(deps), req.params.id, req.body?.partyId)));
}

/** 개발 도구: 개발용 공급자의 "플랫폼 밖 당사자가 공급자 화면에서 서명했다" 통지를 흉내 낸다(RC_DEV에서만). */
export function devEsignRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { id: string }; Body: { partyId?: string } }>("/dev/esign/:id/sign", async (req) => {
    const partyId = req.body?.partyId;
    if (typeof partyId !== "string") throw new DomainError("BAD_REQUEST", 400, "partyId is required");
    await deps.db.tx((tx) => withSystemScope(tx, () => providerSigned(tx, deps.clock, esignOf(deps), req.params.id, partyId)));
    return deps.db.tx((tx) => withSystemScope(tx, () => getContract(tx, req.params.id)));
  });
}

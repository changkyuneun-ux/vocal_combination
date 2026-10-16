import type { FastifyInstance, FastifyRequest } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError } from "../platform/errors.ts";
import { optFilter } from "../platform/paging.ts";
import { addClause, disposeDocument, getDocument, listDocuments, readDocumentFile, rejectDocument, uploadDocument, uploadVersion, type DocumentMeta } from "./service.ts";
import type { DocumentStore } from "./store.ts";
import { revalidateForDocument } from "../validation/service.ts";

function storeOf(deps: Deps): DocumentStore {
  if (deps.documents === undefined) throw new DomainError("DOCUMENTS_NOT_CONFIGURED", 503, "source document storage is not configured");
  return deps.documents;
}

/** 원문은 요청 본문(원시 바이트, Content-Type = 파일 형식), 메타데이터는 쿼리로 받는다(스템 오디오 올리기와 같은 방식). */
function upload(req: FastifyRequest): DocumentMeta & { documentId?: string; mime: string; bytes: Uint8Array } {
  if (!Buffer.isBuffer(req.body)) throw new DomainError("BAD_REQUEST", 400, "body must be the file bytes (Content-Type: application/pdf, image/png or image/jpeg)");
  const q = req.query as Record<string, string | undefined>;
  return {
    ...(q.documentId !== undefined && { documentId: q.documentId }),
    ...(q.kind !== undefined && { kind: q.kind }), ...(q.title !== undefined && { title: q.title }),
    ...(q.parties !== undefined && { parties: q.parties === "" ? [] : q.parties.split(",").map((p) => p.trim()) }),
    ...(q.effectiveFrom !== undefined && { effectiveFrom: q.effectiveFrom }), ...(q.effectiveTo !== undefined && { effectiveTo: q.effectiveTo }),
    ...(q.confidentiality !== undefined && { confidentiality: q.confidentiality }),
    mime: String(req.headers["content-type"] ?? "").split(";")[0]!.trim(), bytes: new Uint8Array(req.body),
  };
}

const ref = (p: { id: string; v: string }) => ({ documentId: p.id, version: Number(p.v) });

/** 원천 문서(원천 문서 설계 S1): 권리자 포털·운영 백오피스. 보이는 범위는 RLS(소유 테넌트·문서 당사자·플랫폼)가 정한다. */
export function documentRoutes(app: FastifyInstance, deps: Deps): void {
  // 연관성 재검사(S3b): 개정(해지는 종료일을 담은 새 버전)·거부·폐기 뒤 그 문서가 닿는 곡을 같은 트랜잭션에서 다시 검사한다.
  const recheck = async <T>(tx: Parameters<typeof revalidateForDocument>[0], documentId: string, done: Promise<T>): Promise<T> => {
    const out = await done;
    await revalidateForDocument(tx, deps.clock, documentId);
    return out;
  };
  app.post("/documents", async (req, reply) => {
    const out = await withActor(deps, req, async (tx, actor) => {
      const r = await uploadDocument(tx, deps.clock, storeOf(deps), actor, upload(req));
      if (r.created) await revalidateForDocument(tx, deps.clock, r.document.documentId); // 새 문서가 빠진 문서 이슈를 닫을 수 있다(S3b)
      return r;
    });
    return reply.status(out.created ? 201 : 200).send(out.document);
  });
  app.post<{ Params: { id: string } }>("/documents/:id/versions", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => recheck(tx, req.params.id, uploadVersion(tx, deps.clock, storeOf(deps), actor, req.params.id, upload(req))))));
  app.get("/documents", async (req) => withActor(deps, req, (tx) => {
    const q = req.query as Record<string, unknown>;
    return listDocuments(tx, { ...(optFilter(q, "kind") !== undefined && { kind: optFilter(q, "kind") }), ...(optFilter(q, "party") !== undefined && { party: optFilter(q, "party") }) });
  }));
  app.get<{ Params: { id: string } }>("/documents/:id", async (req) => withActor(deps, req, (tx) => getDocument(tx, req.params.id)));
  app.get<{ Params: { id: string; v: string } }>("/documents/:id/versions/:v/file", async (req, reply) => {
    const f = await withActor(deps, req, (tx) => readDocumentFile(tx, storeOf(deps), ref(req.params)));
    // 생성 문서(HTML)는 스크립트 없이 보여 준다(값은 이스케이프하지만 한 겹 더 막는다).
    if (f.mime === "text/html") reply.header("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    return reply.type(f.mime === "text/html" ? "text/html; charset=utf-8" : f.mime).header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.title)}`).send(Buffer.from(f.bytes));
  });
  app.post<{ Params: { id: string; v: string } }>("/documents/:id/versions/:v/clauses", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => addClause(tx, deps.clock, actor, ref(req.params), (req.body ?? {}) as Record<string, unknown>))));
  app.post<{ Params: { id: string; v: string }; Body: { reason?: string } }>("/documents/:id/versions/:v/reject", async (req) =>
    withActor(deps, req, (tx, actor) => recheck(tx, req.params.id, rejectDocument(tx, deps.clock, actor, ref(req.params), req.body?.reason))));
  app.post<{ Params: { id: string; v: string } }>("/documents/:id/versions/:v/dispose", async (req) =>
    withActor(deps, req, (tx, actor) => recheck(tx, req.params.id, disposeDocument(tx, deps.clock, storeOf(deps), actor, ref(req.params)))));
}

import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError } from "../platform/errors.ts";
import { getStemAudio, listAudioQueue, registerReference, reviewStemAudio, uploadStemAudio } from "./service.ts";

function audioOf(deps: Deps) {
  if (deps.audio === undefined) throw new DomainError("AUDIO_NOT_CONFIGURED", 503, "audio processing is not configured");
  return deps.audio;
}
function bytesOf(body: unknown): Uint8Array {
  if (!(body instanceof Uint8Array)) throw new DomainError("BAD_REQUEST", 400, "send the audio as the raw request body (audio/* or application/octet-stream)");
  return body;
}

/** 스템 오디오 올리기·상태(권리자 포털·운영). 원본 파일은 내려주지 않는다(반출 금지). */
export function stemAudioRoutes(app: FastifyInstance, deps: Deps): void {
  app.put<{ Params: { id: string } }>("/stems/:id/audio", async (req, reply) => {
    const audio = audioOf(deps);
    const bytes = bytesOf(req.body);
    const out = await withActor(deps, req, (tx, actor) =>
      uploadStemAudio(tx, deps.clock, deps.jobs, audio, actor, { stemId: req.params.id, bytes, contentType: String(req.headers["content-type"] ?? "application/octet-stream") }));
    return reply.status(202).send(out);
  });
  app.get<{ Params: { id: string } }>("/stems/:id/audio", async (req) => withActor(deps, req, (tx) => getStemAudio(tx, req.params.id)));
}

/** 운영 백오피스 ⑤: 오디오 검수 큐, 검토 판단, 상용 참조 음원 등록. */
export function audioOpsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/audio/queue", async (req) => withActor(deps, req, (tx) => listAudioQueue(tx, (req.query as Record<string, string | undefined>).status)));
  app.post<{ Params: { id: string }; Body: { decision?: string; reason?: string } }>("/stems/:id/audio/review", async (req) =>
    withActor(deps, req, (tx, actor) => reviewStemAudio(tx, deps.clock, actor, { stemId: req.params.id, ...req.body })));
  app.post("/reference-audio", async (req, reply) => {
    const audio = audioOf(deps);
    const q = req.query as Record<string, string | undefined>;
    if (!q.referenceId || !q.title) throw new DomainError("BAD_REQUEST", 400, "referenceId and title query parameters are required");
    const bytes = bytesOf(req.body);
    const out = await withActor(deps, req, (tx, actor) => registerReference(tx, deps.clock, audio, actor, {
      referenceId: q.referenceId!, title: q.title!, bytes, ...(q.ownerPartyId && { ownerPartyId: q.ownerPartyId }), ...(q.recordingId && { recordingId: q.recordingId }),
    }));
    return reply.status(201).send(out);
  });
}

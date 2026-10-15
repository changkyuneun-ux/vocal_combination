import type { Clock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import type { JobHandler, JobName } from "../platform/jobs.ts";
import type { AudioDeps } from "./deps.ts";
import { checkStemAudio } from "./service.ts";

/** 오디오 검사 작업 처리기. 오디오 연동이 없으면(audio 미설정) 작업을 건너뛴다(스템은 PENDING으로 남아 발행되지 않는다). */
export function audioJobHandlers(d: { db: Db; clock: Clock; audio?: AudioDeps | undefined }): Partial<Record<JobName, JobHandler>> {
  return { "audio-check": async (data) => { if (d.audio !== undefined) await checkStemAudio({ db: d.db, clock: d.clock, audio: d.audio }, data.stemId!); } };
}

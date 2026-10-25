import type { Clock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import type { JobHandler, JobName } from "../platform/jobs.ts";
import type { AudioDeps } from "./deps.ts";
import { checkStemAudio } from "./service.ts";
import { renderMaster } from "./render.ts";

/**
 * 오디오 작업 처리기: 스템 검사(audio-check)와 마스터 렌더(render-master). 오디오 연동이 없으면(audio 미설정) 작업을 건너뛴다
 * (검사 대기 스템은 PENDING으로 남아 발행되지 않고, 렌더는 PENDING으로 남는다).
 */
export function audioJobHandlers(d: { db: Db; clock: Clock; audio?: AudioDeps | undefined }): Partial<Record<JobName, JobHandler>> {
  return {
    "audio-check": async (data) => { if (d.audio !== undefined) await checkStemAudio({ db: d.db, clock: d.clock, audio: d.audio }, data.stemId!, data.next === "1"); },
    "render-master": async (data) => { if (d.audio?.renderer !== undefined) await renderMaster({ db: d.db, clock: d.clock, audio: d.audio }, data.snapshotId!); },
  };
}

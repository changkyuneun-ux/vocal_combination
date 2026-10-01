import { JOB_NAMES, type BossJobs, type JobName } from "../platform/jobs.ts";
import type { DevJobs } from "./routes.ts";

/** 작업 일시정지 상태를 들고 BossJobs.pause/resume에 위임한다(거부 경로 ACCOUNT_CHANGED 재현용 — 통합 설계 12.2-5). */
export function createDevJobs(boss: Pick<BossJobs, "pause" | "resume">): DevJobs {
  const paused = new Set<JobName>();
  return {
    async pause(name) {
      await boss.pause(name);
      paused.add(name);
    },
    async resume(name) {
      await boss.resume(name);
      paused.delete(name);
    },
    paused: () => JOB_NAMES.filter((n) => paused.has(n)),
  };
}

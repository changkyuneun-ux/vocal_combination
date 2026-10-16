import { JOB_NAMES, type BossJobs, type JobName } from "../platform/jobs.ts";
import type { DevJobs } from "./routes.ts";

/** 작업 일시정지 상태를 들고 BossJobs.pause/resume에 위임한다(거부 경로 ACCOUNT_CHANGED 재현용 — 통합 설계 12.2-5). */
/** 역할을 나눠 띄우면 이 프로세스가 처리하는 큐만 멈춘다(handles). 다른 프로세스의 큐는 초기화가 진행 중 작업이 끝나기를 기다린다. */
export function createDevJobs(boss: Pick<BossJobs, "pause" | "resume"> & Partial<Pick<BossJobs, "handles">>): DevJobs {
  const local = (name: JobName) => boss.handles === undefined || boss.handles(name);
  const paused = new Set<JobName>();
  return {
    async pause(name) {
      if (!local(name)) return;
      await boss.pause(name);
      paused.add(name);
    },
    async resume(name) {
      if (!local(name)) return;
      await boss.resume(name);
      paused.delete(name);
    },
    paused: () => JOB_NAMES.filter((n) => paused.has(n)),
  };
}

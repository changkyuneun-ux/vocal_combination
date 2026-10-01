import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import { ensureDevUsers } from "./users.ts";
import { loadActor } from "../platform/actor.ts";
import { JOB_NAMES, type JobName } from "../platform/jobs.ts";
import { SONG, seedSyntheticSong } from "../scenario/synthetic-song.ts";
import type { Deps } from "../http/server.ts";
import { DEV_CLOCK_START, type DevClock } from "./clock.ts";
import { DEV_OUTCOMES, type DevOutcome, type DevPsp } from "./psp.ts";
import { resetDevDatabase } from "./reset.ts";

/** 작업 일시정지(거부 경로 ACCOUNT_CHANGED 재현용). */
export type DevJobs = { pause(name: JobName): Promise<void>; resume(name: JobName): Promise<void>; paused(): JobName[] };
export type DevDeps = {
  clock: DevClock; psp: DevPsp; jobs: DevJobs; adminUrl: string; blobDir: string;
  /** 테스트가 이름 검사 없는 초기화를 끼울 때만 쓴다. 기본은 이름 검사가 있는 resetDevDatabase. */
  resetDb?: (adminUrl: string) => Promise<{ truncated: string[] }>;
};

const bad = (message: string) => new DomainError("BAD_REQUEST", 400, message);
const outcomeOf = (body: unknown): DevOutcome => {
  const o = (body as { outcome?: unknown } | null)?.outcome;
  if (typeof o !== "string" || !(DEV_OUTCOMES as readonly string[]).includes(o)) throw bad(`outcome must be one of ${DEV_OUTCOMES.join(", ")}`);
  return o as DevOutcome;
};
const jobNameOf = (body: unknown): JobName => {
  const n = (body as { name?: unknown } | null)?.name;
  if (typeof n !== "string" || !(JOB_NAMES as readonly string[]).includes(n)) throw bad(`name must be one of ${JOB_NAMES.join(", ")}`);
  return n as JobName;
};

/** 개발 도구 라우트(x-actor 불필요). RC_DEV=1일 때만 buildServer가 등록한다. */
export function devRoutes(app: FastifyInstance, deps: Deps & { dev: DevDeps }): void {
  const { clock, psp, jobs } = deps.dev;
  app.get("/dev/clock", async () => clock.state());
  app.post("/dev/clock/advance", async (req) => {
    const ms = (req.body as { ms?: unknown } | null)?.ms;
    return { now: await deps.db.tx((tx) => clock.advance(tx, ms as number)) };
  });
  app.post("/dev/clock/set", async (req) => {
    const at = (req.body as { at?: unknown } | null)?.at;
    return { now: await deps.db.tx((tx) => clock.set(tx, at as string)) };
  });

  app.get("/dev/psp/requests", async () => ({ items: psp.requests().reverse() }));
  app.get("/dev/psp/outcomes", async () => psp.outcomes());
  app.put<{ Params: { id: string } }>("/dev/psp/outcomes/:id", async (req) => {
    psp.setOutcome(req.params.id, outcomeOf(req.body));
    return psp.outcomes();
  });
  app.put<{ Params: { id: string } }>("/dev/psp/outcomes/party/:id", async (req) => {
    psp.setPartyOutcome(req.params.id, outcomeOf(req.body));
    return psp.outcomes();
  });
  app.post("/dev/psp/webhook", async (req) => {
    const b = req.body as { instructionId?: unknown; repeat?: unknown } | null;
    if (typeof b?.instructionId !== "string" || b.instructionId === "") throw bad("instructionId is required");
    const repeat = b.repeat ?? 1;
    if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw bad("repeat must be an integer from 1 to 5");
    const payload = psp.webhookFor(b.instructionId);
    const responses: { statusCode: number; body: unknown }[] = [];
    // 운영과 같은 /psp/webhook 라우트(공유 비밀 헤더 포함)를 그대로 거친다.
    for (let n = 0; n < repeat; n++) {
      const r = await app.inject({ method: "POST", url: "/psp/webhook", headers: { "x-psp-secret": deps.pspSecret ?? "" }, payload });
      responses.push({ statusCode: r.statusCode, body: r.json() });
    }
    return { responses };
  });

  app.get("/dev/jobs", async () => ({ paused: jobs.paused() }));
  app.post("/dev/jobs/pause", async (req) => {
    await jobs.pause(jobNameOf(req.body));
    return { paused: jobs.paused() };
  });
  app.post("/dev/jobs/resume", async (req) => {
    await jobs.resume(jobNameOf(req.body));
    return { paused: jobs.paused() };
  });

  app.post("/dev/seed/synthetic-song", async (_req, reply) => {
    await deps.db.tx(async (tx) => {
      if ((await tx.query("SELECT 1 FROM party WHERE party_id = 'pty_label'")).rowCount !== 0) {
        throw new DomainError("ALREADY_SEEDED", 409, "the synthetic song is already seeded (POST /dev/reset first)");
      }
      await seedSyntheticSong(tx, clock, await loadActor(tx, "usr_editor"));
    });
    return reply.status(201).send({ packId: SONG.pack, factsScopeId: SONG.scope, policyId: "pol_nova_summer", policyText: SONG.policyText });
  });

  app.post("/dev/reset", async () => {
    await (deps.dev.resetDb ?? resetDevDatabase)(deps.dev.adminUrl);
    // 초기화는 시계가 뒤로 가는 유일한 경로다(set·advance는 앞으로만 간다).
    await deps.db.tx((tx) => clock.resetTo(tx, DEV_CLOCK_START));
    psp.reset();
    for (const n of jobs.paused()) await jobs.resume(n);
    await deps.db.tx((tx) => ensureDevUsers(tx, clock));
    return { ok: true, clock: clock.state() };
  });
}

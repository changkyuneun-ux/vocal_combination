import type { FastifyInstance } from "fastify";
import { DomainError } from "../platform/errors.ts";
import { ensureDevUsers } from "./users.ts";
import { loadActor, createUser } from "../platform/actor.ts";
import { JOB_NAMES, type JobName } from "../platform/jobs.ts";
import { SONG, seedSyntheticSong } from "../scenario/synthetic-song.ts";
import type { Deps } from "../http/server.ts";
import { DEV_CLOCK_START, type DevClock } from "./clock.ts";
import { DEV_OUTCOMES, type DevOutcome, type DevPsp } from "./psp.ts";
import { assertDevDbName, resetDevDatabase } from "./reset.ts";

/** 작업 일시정지(거부 경로 ACCOUNT_CHANGED 재현용). */
export type DevJobs = { pause(name: JobName): Promise<void>; resume(name: JobName): Promise<void>; paused(): JobName[] };
export type DevDeps = {
  clock: DevClock; psp: DevPsp; jobs: DevJobs; adminUrl: string; blobDir: string;
  /** 초기화가 허용하는 DB 이름(기본 rights_core_dev). 테스트만 테스트 DB 이름을 넘긴다 — StartOpts.dev에서는 제외된다. */
  devDbName?: string;
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
    const b = req.body as { instructionId?: unknown; repeat?: unknown; status?: unknown } | null;
    if (typeof b?.instructionId !== "string" || b.instructionId === "") throw bad("instructionId is required");
    const repeat = b.repeat ?? 1;
    if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw bad("repeat must be an integer from 1 to 5");
    const st = b.status;
    if (st !== undefined && st !== "PAID" && st !== "FAILED") throw bad("status must be PAID or FAILED");
    // status를 주면 그 결과로 webhook을 만들고 가짜 PSP의 이후 status()도 같은 결과로 맞춘다. 없으면 첫 submit에 정해진 결과.
    const payload = psp.webhookFor(b.instructionId, st);
    const responses: { statusCode: number; body: unknown }[] = [];
    // 운영과 같은 /psp/webhook 라우트(공유 비밀 헤더 포함)를 그대로 거친다.
    for (let n = 0; n < repeat; n++) {
      const r = await app.inject({ method: "POST", url: "/psp/webhook", headers: { "x-psp-secret": deps.pspSecret ?? "" }, payload });
      responses.push({ statusCode: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() });
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

  const seedPayload = { packId: SONG.pack, factsScopeId: SONG.scope, policyId: "pol_nova_summer", policyText: SONG.policyText };
  /** 읽기 전용: 시드가 만들 식별자와 정책 원문만 돌려준다(아무것도 쓰지 않는다). */
  app.get("/dev/seed/synthetic-song", async () => seedPayload);

  app.post("/dev/seed/synthetic-song", async (_req, reply) => {
    await deps.db.tx(async (tx) => {
      if ((await tx.query("SELECT 1 FROM party WHERE party_id = 'pty_label'")).rowCount !== 0) {
        throw new DomainError("ALREADY_SEEDED", 409, "the synthetic song is already seeded (POST /dev/reset first)");
      }
      await seedSyntheticSong(tx, clock, await loadActor(tx, "usr_editor"));
      // 실연자 앱 확인용: 합성 곡 멤버마다 실연자 계정(본인 인증 전, 소속 없는 개인)을 만든다.
      for (const m of SONG.members) {
        await createUser(tx, clock, { userId: `usr_singer_${m}`, displayName: `멤버 ${m}`, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_member_${m}` });
      }
    });
    return reply.status(201).send(seedPayload);
  });

  app.post("/dev/reset", async () => {
    // 순서: 먼저 모든 큐를 멈춰 워커가 TRUNCATE와 시계·사용자 복원 사이에 쓰지 못하게 하고, 끝나면(실패해도) 다시 연다.
    // 초기화가 pgboss.job과 일시정지 상태를 모두 비우므로 결과적으로 전부 resume한다. 이름 검사는 항상 거친다.
    assertDevDbName(decodeURIComponent(new URL(deps.dev.adminUrl).pathname.replace(/^\//, "")), deps.dev.devDbName);
    for (const n of JOB_NAMES) await jobs.pause(n);
    let failure: unknown;
    try {
      // 역할을 나눠 띄운 데모 환경: 다른 프로세스(워커·검증 워커)에서 진행 중인 작업이 끝나기를 기다린다(최대 30초).
      for (let i = 0; i < 300; i++) {
        const active = (await deps.db.tx((tx) => tx.query("SELECT count(*)::int AS n FROM pgboss.job WHERE state = 'active'"))).rows[0].n as number;
        if (active === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await resetDevDatabase(deps.dev.adminUrl, deps.dev.devDbName);
      // 초기화는 시계가 뒤로 가는 유일한 경로다(set·advance는 앞으로만 간다).
      await deps.db.tx((tx) => clock.resetTo(tx, DEV_CLOCK_START));
      psp.reset();
      await deps.db.tx((tx) => ensureDevUsers(tx, clock));
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      // resume 오류가 원래 오류를 가리지 않게 한다.
      for (const n of JOB_NAMES) {
        try { await jobs.resume(n); } catch (re) {
          if (failure === undefined) throw re;
          app.log.error({ err: re }, `dev reset: failed to resume ${n}`);
        }
      }
    }
    return { ok: true, clock: clock.state() };
  });
}

import type { FastifyInstance } from "fastify";
import type { PayoutProvider } from "../payout/provider.ts";
import type { Deps } from "../http/server.ts";
import type { DevClock } from "./clock.ts";

/** 개발용 PSP 가짜. Task 2에서 확장한다(지금은 어댑터만). */
export type DevPsp = { provider: PayoutProvider };
export type DevDeps = { clock: DevClock; psp: DevPsp; adminUrl: string; blobDir: string };

/** 개발 도구 라우트(x-actor 불필요). RC_DEV=1일 때만 buildServer가 등록한다. */
export function devRoutes(app: FastifyInstance, deps: Deps & { dev: DevDeps }): void {
  const { clock } = deps.dev;
  app.get("/dev/clock", async () => clock.state());
  app.post("/dev/clock/advance", async (req) => {
    const ms = (req.body as { ms?: unknown } | null)?.ms;
    return { now: await deps.db.tx((tx) => clock.advance(tx, ms as number)) };
  });
  app.post("/dev/clock/set", async (req) => {
    const at = (req.body as { at?: unknown } | null)?.at;
    return { now: await deps.db.tx((tx) => clock.set(tx, at as string)) };
  });
}

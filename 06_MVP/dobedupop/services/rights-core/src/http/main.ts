import { systemClock } from "../platform/clock.ts";
import { ensureSystemIdentities } from "../platform/actor.ts";
import { providerFromEnv } from "../payout/provider.ts";
import { startServer } from "./assemble.ts";

const url = process.env.DATABASE_URL ?? "postgres://rc_app:rc_app@localhost:54329/rights_core";
// PSP 어댑터: 이 단계에는 가짜 어댑터만 있다(RC_PSP가 "fake"나 빈 값이 아니면 시작을 거부한다).
const provider = providerFromEnv(process.env);
await startServer({
  url,
  clock: systemClock,
  provider,
  pspSecret: process.env.RC_PSP_SECRET,
  port: Number(process.env.PORT ?? 8080),
  // 워커가 쓰는 시스템 신원(sys_ingest·sys_settler·sys_verifier)을 먼저 보장한다.
  prepare: (db) => db.tx((tx) => ensureSystemIdentities(tx, systemClock)),
});

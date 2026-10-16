import { systemClock } from "../platform/clock.ts";
import { ensureSystemIdentities } from "../platform/actor.ts";
import { productionProviderFromEnv } from "../payout/provider.ts";
import { startServer } from "./assemble.ts";

const url = process.env.DATABASE_URL ?? "postgres://rc_app:rc_app@localhost:54329/rights_core";
// 운영(production) 진입점: 가상 공급자로는 시작하지 않는다(MVP 진행계획 M2). 실제 PSP 어댑터가 아직 없으므로 지금은 시작을 거부하고,
// 데모 환경은 개발 진입점(dev/main.ts, RC_DEV=1: 가상 시계·가상 공급자)을 역할별로 띄운다. 역할은 RC_ROLE(api·worker·verifier·all).
const provider = productionProviderFromEnv(process.env);
await startServer({
  url,
  clock: systemClock,
  provider,
  pspSecret: process.env.RC_PSP_SECRET,
  port: Number(process.env.PORT ?? 8080),
  // 워커가 쓰는 시스템 신원(sys_ingest·sys_settler·sys_verifier)을 먼저 보장한다.
  prepare: (db) => db.tx((tx) => ensureSystemIdentities(tx, systemClock)),
});

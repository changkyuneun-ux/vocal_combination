import type { Actor } from "../src/platform/actor.ts";
import { createUser, loadActor } from "../src/platform/actor.ts";
import { fixedClock, type Clock } from "../src/platform/clock.ts";
import type { Db } from "../src/platform/db.ts";
import type { BridgeCtx } from "../src/engine-bridge/context.ts";
import type { IssueSeal } from "../src/engine-bridge/issue.ts";
import * as policy from "../src/policy/service.ts";
import * as issuance from "../src/issuance/service.ts";
import { ingestRevenue } from "../src/revenue/service.ts";
import { freshDb } from "./helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "./fixtures.ts";

export type SettlementWorld = {
  db: Db; ctx: BridgeCtx; clock: Clock;
  users: Record<"rights" | "editor" | "approver" | "activator" | "issuer" | "ops" | "settle" | "ingest", Actor>;
  drop(): Promise<void>;
};

/** 정산 가능한 세계: 곡·정책·팩이 활성이고, 정산 역할 사용자와 시스템 신원이 있다. 정책 events는 [PRIMARY]. */
export async function settlementWorld(): Promise<SettlementWorld> {
  const { db, drop } = await freshDb();
  const { ctx, cleanup } = tempBridge();
  const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
  const base = fixedClock(T0, 0);
  const users = await db.tx(async (tx) => {
    await seedSong(tx, base);
    const u = await seedUsers(tx, base);
    for (const [id, role] of [["usr_ops", "SPACE_OPS"], ["usr_settle", "SPACE_SETTLE"], ["sys_ingest", "SYSTEM"], ["sys_settler", "SYSTEM"], ["sys_verifier", "SYSTEM"]] as const) {
      await createUser(tx, base, { userId: id, displayName: id, roles: [role] });
    }
    await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
    await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
    return { ...u, ops: await loadActor(tx, "usr_ops"), settle: await loadActor(tx, "usr_settle"), ingest: await loadActor(tx, "sys_ingest") };
  });
  await db.tx(async (tx) => {
    const r = await policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT });
    await policy.approvePolicy(ctx, tx, clock, users.approver, r);
    await policy.activatePolicy(ctx, tx, clock, users.activator, r);
    await issuance.activatePack(ctx, tx, clock, users.activator, PACK);
  });
  return { db, ctx, clock, users, async drop() { await drop(); cleanup(); } };
}

export async function issueCombo(w: SettlementWorld, vcId: string, a: "a" | "b" = "a", b: "a" | "b" = "b"): Promise<IssueSeal> {
  return w.db.tx((tx) => issuance.issue(w.ctx, tx, w.clock, w.users.issuer, {
    packId: PACK, vcId,
    assignments: [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }],
    members: a === b ? { [`pty_member_${a}`]: 10000 } : { [`pty_member_${a}`]: 5000, [`pty_member_${b}`]: 5000 },
  }));
}

export async function purchase(
  w: SettlementWorld, eventId: string, vcId: string, amountKrw: string, occurredAt = "2026-03-01T10:00:00.000Z", integrity: "CLEAR" | "FLAGGED" = "CLEAR",
): Promise<void> {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId, sourceSystem: "app", sourceEventId: eventId, eventType: "PURCHASE", vcId, amountKrw, currency: "KRW", occurredAt, integrity,
  }));
}

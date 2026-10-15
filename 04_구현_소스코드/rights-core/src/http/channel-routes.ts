import type { FastifyInstance } from "fastify";
import { partyStatement } from "../ledger/statements.ts";
import { withSystemScope, type Actor } from "../platform/actor.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import { iso, type Tx } from "../platform/db.ts";
import * as issuance from "../issuance/service.ts";
import { listConsents, revokeConsent, signConsent, type ConsentDraft } from "../registry/consents.ts";
import { fanRenderFile, queueRender, renderPreview } from "../audio/render.ts";
import { confirmVerification, startVerification } from "../performer/identity.ts";
import { listNotifications, markRead, subscribePush } from "../performer/notifications.ts";
import { myClaims, myObjections, myVoices, openObjection } from "../performer/service.ts";
import { checkCombination, defaultMembers } from "../fan/decision.ts";
import { recordPlay } from "../revenue/traffic.ts";
import { withActor, type Deps } from "./server.ts";

/** 행위자 공통 정보(모든 채널의 /me). */
function me(actor: Actor) {
  return { userId: actor.userId, tenantId: actor.tenantId, tenantType: actor.tenantType, scope: actor.scope, roles: [...actor.roles].sort(), ...(actor.partyId && { partyId: actor.partyId }) };
}

function period(q: Record<string, unknown>): { from: string; to: string } {
  if (typeof q.from !== "string" || typeof q.to !== "string") throw new DomainError("BAD_REQUEST", 400, "from and to query parameters are required");
  return { from: q.from, to: q.to };
}

/** 권리자 포털 전용: 자기 테넌트 파티 목록과 명세(역할 없이, 소속 파티만 — RLS가 다른 테넌트 파티를 거른다). */
export function portalRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/my/parties", async (req) => withActor(deps, req, async (tx, actor) => {
    const rows = (await tx.query("SELECT party_id, party_type, display_name FROM party WHERE tenant_id = $1 ORDER BY party_id", [actor.tenantId])).rows;
    return rows.map((r) => ({ partyId: r.party_id as string, partyType: r.party_type as string, displayName: r.display_name as string }));
  }));
  app.get<{ Params: { id: string } }>("/parties/:id/statements", async (req) => withActor(deps, req, async (tx) => {
    const { from, to } = period(req.query as Record<string, unknown>);
    if (!(await tx.query("SELECT rc_party_visible($1) AS v", [req.params.id])).rows[0].v) throw notFound("party", req.params.id);
    return partyStatement(tx, req.params.id, from, to);
  }));
}

/** 내 스템이 쓰인 발행 조합. 발행 데이터는 팩 소유 테넌트만 보므로, 본인 파티로 거른 조회만 system 범위로 한다. */
async function myUsages(tx: Tx, partyId: string) {
  return withSystemScope(tx, async () => (await tx.query(
    `SELECT s.snapshot_id, s.vc_id, s.pack_id, s.created_at, a.slot_id, a.stem_id, a.duration_ms
       FROM snapshot_stem_assignment a JOIN rights_snapshot s ON s.snapshot_id = a.snapshot_id
      WHERE a.party_id = $1 AND a.rights_bearing ORDER BY s.created_at, s.snapshot_id, a.slot_id`, [partyId],
  )).rows.map((r) => ({ snapshotId: r.snapshot_id as string, vcId: r.vc_id as string, packId: r.pack_id as string, issuedAt: iso(r.created_at)!, slotId: r.slot_id as string, stemId: r.stem_id as string, durationMs: r.duration_ms as number })));
}

/**
 * 실연자 앱(다음 작업 11): 본인 파티의 동의·명세·사용 이력·이의제기·알림만. 동의 서명은 언제나 본인 파티의 실연 동의이고,
 * 본인 인증을 마친 계정만 서명할 수 있다.
 */
export function performerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) => withActor(deps, req, async (tx, actor) => {
    const u = (await tx.query("SELECT display_name, identity_verified_at, identity_method FROM user_account WHERE user_id = $1", [actor.userId])).rows[0];
    return { ...me(actor), displayName: u.display_name as string, identityVerified: u.identity_verified_at !== null, ...(u.identity_method && { identityMethod: u.identity_method as string }) };
  }));
  app.post("/identity/start", async (req) => withActor(deps, req, (tx, actor) => startVerification(tx, deps.clock, deps.identity, actor)));
  app.post<{ Body: { challengeId?: number; code?: string } }>("/identity/confirm", async (req) =>
    withActor(deps, req, (tx, actor) => confirmVerification(tx, deps.clock, actor, req.body ?? {})));
  app.get("/voices", async (req) => withActor(deps, req, (tx, actor) => myVoices(tx, actor.partyId!)));
  app.post<{ Body: { claimId?: string; reason?: string } }>("/objections", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => openObjection(tx, deps.clock, actor, req.body ?? {}))));
  app.get("/objections", async (req) => withActor(deps, req, (tx, actor) => myObjections(tx, actor.userId)));
  app.get("/claims", async (req) => withActor(deps, req, (tx, actor) => myClaims(tx, actor.partyId!)));
  app.get("/notifications", async (req) => withActor(deps, req, (tx, actor) => listNotifications(tx, actor.userId)));
  app.post<{ Params: { id: string } }>("/notifications/:id/read", async (req) =>
    withActor(deps, req, async (tx, actor) => { await markRead(tx, deps.clock, actor.userId, Number(req.params.id)); return {}; }));
  app.get("/push/vapid-key", async (req) => withActor(deps, req, async () => {
    if (deps.push === undefined) throw new DomainError("PUSH_NOT_CONFIGURED", 503, "web push is not configured");
    return { publicKey: deps.push.publicKey };
  }));
  app.post("/push/subscriptions", async (req, reply) =>
    reply.status(201).send(await withActor(deps, req, (tx, actor) => subscribePush(tx, deps.clock, actor.userId, req.body as Record<string, any>))));
  app.get("/consents", async (req) => withActor(deps, req, (tx, actor) => listConsents(tx, { party: actor.partyId! })));
  app.post("/consents", async (req, reply) => {
    const b = req.body as Omit<ConsentDraft, "partyId" | "rightType" | "validFrom" | "validTo"> & { validFrom?: string; validTo?: string };
    // 기간을 주지 않으면 지금(코어 시계)부터 1년이다. 무기한 동의는 받지 않는다.
    const from = b.validFrom ?? deps.clock.now();
    const to = b.validTo ?? new Date(Date.parse(from) + 365 * 86_400_000).toISOString();
    const out = await withActor(deps, req, (tx, actor) => signConsent(tx, deps.clock, actor, { ...b, validFrom: from, validTo: to, partyId: actor.partyId!, rightType: "PERFORMER" }));
    return reply.status(201).send(out);
  });
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/consents/:id/revoke", async (req) =>
    withActor(deps, req, (tx, actor) => revokeConsent(tx, deps.clock, actor, req.params.id, req.body?.reason ?? "")));
  app.get("/statements", async (req) => withActor(deps, req, async (tx, actor) => {
    const { from, to } = period(req.query as Record<string, unknown>);
    return partyStatement(tx, actor.partyId!, from, to);
  }));
  app.get("/usages", async (req) => withActor(deps, req, (tx, actor) => myUsages(tx, actor.partyId!)));
}

/** 팬에게 보이는 팩 투영: 슬롯·스템·실연자 표시 이름(상세면 스템별 사용 가능 여부). 팬은 팩 원본 행을 볼 수 없어 system 범위에서 만든다. */
async function fanPack(tx: Tx, packId: string, detail = false) {
  const p = (await tx.query("SELECT pack_id, pack_code, title, facts_scope_id FROM vocal_pack WHERE pack_id = $1", [packId])).rows[0];
  const stems = (await tx.query(
    `SELECT sl.slot_id, sl.start_ms, sl.end_ms, st.stem_id, st.rights_bearing, pt.display_name, au.status AS audio_status
       FROM facts_scope f JOIN recording_version r ON r.work_id = f.work_id JOIN part_slot sl ON sl.recording_id = r.recording_id
       JOIN stem st ON st.slot_id = sl.slot_id LEFT JOIN party pt ON pt.party_id = st.performer_party_id
       LEFT JOIN stem_audio au ON au.stem_id = st.stem_id
      WHERE f.facts_scope_id = $1 ORDER BY sl.sort_order, st.stem_id`, [p.facts_scope_id],
  )).rows;
  type FanStem = { stemId: string; performer?: string; available?: boolean; audio?: string };
  const slots = new Map<string, { slotId: string; startMs: number; endMs: number; stems: FanStem[] }>();
  for (const s of stems) {
    const slot = slots.get(s.slot_id) ?? { slotId: s.slot_id as string, startMs: s.start_ms as number, endMs: s.end_ms as number, stems: [] as FanStem[] };
    slot.stems.push({
      stemId: s.stem_id, ...(s.display_name !== null && { performer: s.display_name }),
      ...(detail && { available: s.audio_status === null || s.audio_status === "READY", audio: (s.audio_status ?? "NONE") as string }),
    });
    slots.set(s.slot_id, slot);
  }
  return { packId: p.pack_id as string, packCode: p.pack_code as string, title: p.title as string, slots: [...slots.values()] };
}

/** 팬 앱: 활성 팩 카탈로그(공개용 투영)와 조합 발행. 팬은 팩 원본 행을 볼 수 없으므로 카탈로그는 system 범위의 고정 투영이다. */
export function fanRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) => withActor(deps, req, async (_tx, actor) => me(actor)));
  app.get("/packs", async (req) => withActor(deps, req, (tx) => withSystemScope(tx, async () => {
    const packs = (await tx.query("SELECT pack_id FROM vocal_pack WHERE status = 'ACTIVE' ORDER BY pack_id")).rows;
    const out = [];
    for (const p of packs) out.push(await fanPack(tx, p.pack_id as string));
    return out;
  })));
  /** 팩 상세: 슬롯별 스템과 각 스템을 지금 쓸 수 있는지(오디오 READY 또는 오디오 없는 메타데이터 스템). */
  app.get<{ Params: { packId: string } }>("/packs/:packId", async (req) => withActor(deps, req, (tx) => withSystemScope(tx, async () => {
    const p = (await tx.query("SELECT 1 FROM vocal_pack WHERE pack_id = $1 AND status = 'ACTIVE'", [req.params.packId])).rows[0];
    if (p === undefined) throw notFound("pack", req.params.packId);
    return fanPack(tx, req.params.packId, true);
  })));
  /**
   * 조합 판정(다음 작업 12): 고른 배치가 지금 발행될 수 있는지와 사유를 돌려준다. 실제 발행 경로를 되돌리는 방식이라 결과가 발행과 같고,
   * 같은 배치의 판정은 캐시한다(cached). 거부도 200으로 돌려준다(issuable=false, code, diagnostics).
   */
  app.post("/combinations/check", async (req) => {
    const b = req.body as { packId?: string; assignments?: { slotId: string; stemId: string }[]; members?: Record<string, number>; usage?: issuance.Usage };
    if (typeof b?.packId !== "string" || !Array.isArray(b.assignments) || !b.assignments.every((a) => typeof a?.slotId === "string" && typeof a?.stemId === "string")) {
      throw new DomainError("BAD_REQUEST", 400, "packId and assignments of {slotId, stemId} are required");
    }
    return withActor(deps, req, (tx, actor) => checkCombination(deps.ctx, tx, deps.clock, actor, {
      packId: b.packId!, assignments: b.assignments!, ...(b.members && { members: b.members }), ...(b.usage && { usage: b.usage }),
    }));
  });
  /** 재생 보고(다음 작업 13): 감상 매출 배정의 근거. 유효 재생(30초 이상)만 세고, 과다 반복 재생은 FLAGGED로 뺀다. */
  app.post("/plays", async (req, reply) => {
    const b = req.body as Record<string, unknown> | undefined;
    const out = await withActor(deps, req, (tx, actor) => recordPlay(tx, deps.clock, actor, { playId: b?.playId, vcId: b?.vcId, durationMs: b?.durationMs }));
    return reply.status(201).send(out);
  });
  /** 내가 발행한 조합과 렌더 상태. */
  app.get("/combinations", async (req) => withActor(deps, req, (tx, actor) => withSystemScope(tx, async () => (await tx.query(
    `SELECT s.snapshot_id, s.vc_id, s.pack_id, s.created_at, r.status AS render_status, r.duration_ms,
            (SELECT json_agg(json_build_object('slotId', a.slot_id, 'stemId', a.stem_id) ORDER BY a.slot_id) FROM snapshot_stem_assignment a WHERE a.snapshot_id = s.snapshot_id) AS assignments
       FROM rights_snapshot s LEFT JOIN combination_render r ON r.snapshot_id = s.snapshot_id
      WHERE s.issued_by = $1 ORDER BY s.created_at DESC, s.snapshot_id`, [actor.userId],
  )).rows.map((r) => ({
    vcId: r.vc_id as string, snapshotId: r.snapshot_id as string, packId: r.pack_id as string, issuedAt: iso(r.created_at)!,
    assignments: r.assignments as { slotId: string; stemId: string }[], render: r.render_status === null ? "NONE" : (r.render_status as string),
    ...(r.duration_ms !== null && { durationMs: r.duration_ms as number }),
  })))));
  /**
   * 조합 발행: 팬이 고른 배치를 팬 대신 발행한다. 멤버 비율은 주지 않으면 부른 슬롯 수에 비례한다.
   * 팬은 ISSUER 역할이 없다. 이 채널이 발행 권한의 주체이며, 감사 기록의 행위자는 팬 본인이다.
   */
  app.post("/combinations", async (req, reply) => {
    const b = req.body as { packId?: string; vcId?: string; assignments?: { slotId: string; stemId: string }[]; members?: Record<string, number>; usage?: issuance.Usage };
    if (typeof b?.packId !== "string" || typeof b.vcId !== "string" || !Array.isArray(b.assignments)) throw new DomainError("BAD_REQUEST", 400, "packId, vcId and assignments are required");
    const seal = await withActor(deps, req, (tx, actor) => withSystemScope(tx, async () => {
      let members = b.members;
      members ??= await defaultMembers(tx, b.assignments!);
      const onBehalf: Actor = { ...actor, roles: new Set([...actor.roles, "ISSUER"]) };
      const s = await issuance.issue(deps.ctx, tx, deps.clock, onBehalf, { packId: b.packId!, vcId: b.vcId!, assignments: b.assignments!, members, ...(b.usage && { usage: b.usage }) });
      if (deps.audio?.renderer !== undefined) await queueRender(tx, deps.clock, deps.jobs, s.snapshotId);
      return s;
    })).catch(async (e: unknown) => {
      await issuance.recordIssueRejection(deps.db, deps.clock, e, { channel: "fan", actorUserId: req.headers["x-actor"], packId: b.packId, vcId: b.vcId });
      throw e;
    });
    return reply.status(201).send(seal);
  });
}

/** 팬 앱 렌더: 발행 전 5초 미리듣기(MP3), 발행한 자기 조합의 마스터(WAV, 워터마크). 원본 스템은 나가지 않는다. */
export function fanRenderRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/previews", async (req, reply) => {
    const out = await withActor(deps, req, (tx) => renderPreview(tx, deps.audio, req.body as Record<string, unknown>));
    return reply.type(out.contentType).header("x-render-sha256", out.sha256).send(out.bytes);
  });
  app.get<{ Params: { vcId: string } }>("/combinations/:vcId/render", async (req, reply) => {
    const bytes = await withActor(deps, req, (tx, actor) => fanRenderFile(tx, deps.audio, actor.userId, req.params.vcId));
    return reply.type("audio/wav").send(Buffer.from(bytes));
  });
}

/** 파트너 연동: 신원 확인. 리포트 파일 전송(유통사 CSV·DDEX DSR)은 연동 허브(hub/routes.ts)가 이 채널에 붙인다. */
export function partnerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) => withActor(deps, req, async (_tx, actor) => me(actor)));
}

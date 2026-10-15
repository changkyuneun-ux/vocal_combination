import type { FastifyInstance } from "fastify";
import { partyStatement } from "../ledger/statements.ts";
import { withSystemScope, type Actor } from "../platform/actor.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import { iso, type Tx } from "../platform/db.ts";
import * as issuance from "../issuance/service.ts";
import { listConsents, revokeConsent, signConsent, type ConsentDraft } from "../registry/consents.ts";
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

/** 실연자 앱: 본인 파티의 동의·명세·사용 이력만. 동의 서명은 언제나 본인 파티의 실연 동의다. */
export function performerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) => withActor(deps, req, async (_tx, actor) => me(actor)));
  app.get("/consents", async (req) => withActor(deps, req, (tx, actor) => listConsents(tx, { party: actor.partyId! })));
  app.post("/consents", async (req, reply) => {
    const b = req.body as Omit<ConsentDraft, "partyId" | "rightType">;
    const out = await withActor(deps, req, (tx, actor) => signConsent(tx, deps.clock, actor, { ...b, partyId: actor.partyId!, rightType: "PERFORMER" }));
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

/** 팬 앱: 활성 팩 카탈로그(공개용 투영)와 조합 발행. 팬은 팩 원본 행을 볼 수 없으므로 카탈로그는 system 범위의 고정 투영이다. */
export function fanRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) => withActor(deps, req, async (_tx, actor) => me(actor)));
  app.get("/packs", async (req) => withActor(deps, req, (tx) => withSystemScope(tx, async () => {
    const packs = (await tx.query("SELECT pack_id, pack_code, title, facts_scope_id FROM vocal_pack WHERE status = 'ACTIVE' ORDER BY pack_id")).rows;
    const out = [];
    for (const p of packs) {
      const stems = (await tx.query(
        `SELECT sl.slot_id, sl.start_ms, sl.end_ms, st.stem_id, st.rights_bearing, pt.display_name
           FROM facts_scope f JOIN recording_version r ON r.work_id = f.work_id JOIN part_slot sl ON sl.recording_id = r.recording_id
           JOIN stem st ON st.slot_id = sl.slot_id LEFT JOIN party pt ON pt.party_id = st.performer_party_id
          WHERE f.facts_scope_id = $1 ORDER BY sl.sort_order, st.stem_id`, [p.facts_scope_id],
      )).rows;
      const slots = new Map<string, { slotId: string; startMs: number; endMs: number; stems: { stemId: string; performer?: string }[] }>();
      for (const s of stems) {
        const slot = slots.get(s.slot_id) ?? { slotId: s.slot_id as string, startMs: s.start_ms as number, endMs: s.end_ms as number, stems: [] as { stemId: string; performer?: string }[] };
        slot.stems.push({ stemId: s.stem_id, ...(s.display_name !== null && { performer: s.display_name }) });
        slots.set(s.slot_id, slot);
      }
      out.push({ packId: p.pack_id as string, packCode: p.pack_code as string, title: p.title as string, slots: [...slots.values()] });
    }
    return out;
  })));
  /**
   * 조합 발행: 팬이 고른 배치를 팬 대신 발행한다. 멤버 비율은 주지 않으면 부른 슬롯 수에 비례한다.
   * 팬은 ISSUER 역할이 없다. 이 채널이 발행 권한의 주체이며, 감사 기록의 행위자는 팬 본인이다.
   */
  app.post("/combinations", async (req, reply) => {
    const b = req.body as { packId?: string; vcId?: string; assignments?: { slotId: string; stemId: string }[]; members?: Record<string, number>; usage?: issuance.Usage };
    if (typeof b?.packId !== "string" || typeof b.vcId !== "string" || !Array.isArray(b.assignments)) throw new DomainError("BAD_REQUEST", 400, "packId, vcId and assignments are required");
    const seal = await withActor(deps, req, (tx, actor) => withSystemScope(tx, async () => {
      let members = b.members;
      if (members === undefined) {
        const performers = (await tx.query(
          "SELECT stem_id, performer_party_id FROM stem WHERE stem_id = ANY($1) AND rights_bearing AND performer_party_id IS NOT NULL", [b.assignments!.map((a) => a.stemId)],
        )).rows;
        const byStem = new Map(performers.map((r) => [r.stem_id as string, r.performer_party_id as string]));
        members = issuance.slotShareBps(b.assignments!.map((a) => byStem.get(a.stemId)).filter((p): p is string => p !== undefined));
      }
      const onBehalf: Actor = { ...actor, roles: new Set([...actor.roles, "ISSUER"]) };
      return issuance.issue(deps.ctx, tx, deps.clock, onBehalf, { packId: b.packId!, vcId: b.vcId!, assignments: b.assignments!, members, ...(b.usage && { usage: b.usage }) });
    }));
    return reply.status(201).send(seal);
  });
}

/** 파트너 연동: 지금은 신원 확인만. 정산 수익 수집·DDEX 등은 연동 허브(다음 작업 14)가 이 채널에 붙는다. */
export function partnerRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/me", async (req) => withActor(deps, req, async (_tx, actor) => me(actor)));
}

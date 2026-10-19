import { createHash } from "node:crypto";
import { FORMATS, translate, type Format, type Normalized } from "integration-hub";
import { requireRole, withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { policyEventTypes } from "../engine-bridge/settle.ts";
import { ingestRevenue, type RefundHook, type RevenueInput, type RevisionHook } from "../revenue/service.ts";

/** 한 번에 받는 파일 크기 한도(요청 본문 한도와 같다). 더 큰 리포트는 나눠 보낸다. */
export const MAX_FILE_BYTES = 1024 * 1024 - 4096;

/** 고친 뒤 다시 처리하면 통과할 수 있는 거부(자산 대응 등록, 원거래 도착, 발행 대기). */
export const RETRIABLE = new Set(["UNKNOWN_ASSET", "NOT_ISSUED", "UNKNOWN_ORIGINAL"]);

export type HubHooks = { onRefund: RefundHook; onRevision: RevisionHook };

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** 파트너 거래 id는 형식이 제각각이라 그대로 매출 id로 쓰지 않는다. 테넌트와 거래 id의 해시로 고정 id를 만든다(재전송·재처리에 같은 id). */
export const hubEventId = (tenantId: string, externalId: string) => `ev_hub_${sha256(`${tenantId}\u0000${externalId}`).slice(0, 24)}`;

/**
 * 파일 수신(파트너 채널): 원본을 그대로 보관하고(해시·바이트), integration-hub로 번역한 뒤 줄마다 적용한다.
 * 같은 파일(같은 해시)을 다시 보내면 처음 결과를 돌려준다. 파일 단위 오류가 있으면 아무 줄도 적용하지 않는다.
 */
export async function receiveFile(
  ctx: BridgeCtx, tx: Tx, clock: Clock, hooks: HubHooks, actor: Actor, input: { format?: unknown; fileName?: unknown; content?: unknown },
): Promise<{ created: boolean; file: Awaited<ReturnType<typeof getFile>> }> {
  if (actor.tenantType !== "B2B_PARTNER") throw new DomainError("PARTNER_ONLY", 403, "only partner tenants send integration files");
  if (typeof input.format !== "string" || !FORMATS.includes(input.format as Format)) throw invalid("INVALID_FILE", `format must be one of ${FORMATS.join(", ")}`);
  if (typeof input.content !== "string" || input.content.length === 0) throw invalid("INVALID_FILE", "content must be the file text");
  const fileName = typeof input.fileName === "string" && input.fileName.trim() !== "" ? input.fileName.trim().slice(0, 200) : "upload";
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > MAX_FILE_BYTES) throw invalid("FILE_TOO_LARGE", `file must be at most ${MAX_FILE_BYTES} bytes; split the report`);
  const digest = sha256(bytes);
  const prev = (await tx.query("SELECT file_id FROM inbound_file WHERE tenant_id = $1 AND file_sha256 = $2", [actor.tenantId, digest])).rows[0];
  if (prev !== undefined) return { created: false, file: await getFile(tx, prev.file_id as string) };

  const fileId = `inb_${digest.slice(0, 20)}`;
  const t = translate(input.format as Format, bytes);
  const now = clock.now();
  await tx.query(
    `INSERT INTO inbound_file (file_id, tenant_id, format, file_name, file_sha256, byte_size, raw_bytes, status, file_errors, received_by, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [fileId, actor.tenantId, input.format, fileName, digest, bytes.byteLength, Buffer.from(bytes), t.fileErrors.length > 0 ? "REJECTED" : "APPLIED",
      JSON.stringify(t.fileErrors), actor.userId, now],
  );
  for (const l of t.lines) {
    const res = "record" in l ? await applyRecord(ctx, tx, clock, hooks, actor, actor.tenantId, l.record) : { status: "REJECTED" as const, code: l.reject.code, message: l.reject.message };
    await tx.query(
      `INSERT INTO inbound_record (file_id, line_no, raw, record, status, reject_code, reject_message, event_id, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [fileId, l.line, l.raw, "record" in l ? JSON.stringify(l.record) : null, res.status, res.status === "REJECTED" ? res.code : null,
        res.status === "REJECTED" ? res.message : null, res.status === "REJECTED" ? null : res.eventId, now],
    );
  }
  const file = await getFile(tx, fileId);
  await audit(tx, clock, { actor: actor.userId, action: "INBOUND_FILE_RECEIVED", entityType: "inbound_file", entityId: fileId, after: { format: input.format, sha256: digest, status: file.status, counts: file.counts } });
  return { created: true, file };
}

type Applied = { status: "ACCEPTED" | "DUPLICATE"; eventId: string } | { status: "REJECTED"; code: string; message: string };

/**
 * 정규화 레코드 하나를 매출 이벤트로 넣는다. SALE → PURCHASE, REFUND → REFUND(원거래의 이벤트), STREAM_REVENUE → TRAFFIC.
 * 감상 매출은 조합의 봉인 정책이 TRAFFIC을 받을 때만 넣는다(아니면 엔진이 run을 거부해 조합이 격리된다).
 * 매출 수집의 거부(멱등 충돌, 환불 초과 등)는 SAVEPOINT로 되돌리고 그 줄의 거부 사유로 남긴다.
 */
async function applyRecord(ctx: BridgeCtx, tx: Tx, clock: Clock, hooks: HubHooks, actor: Actor, tenantId: string, r: Normalized): Promise<Applied> {
  return withSystemScope(tx, async () => {
    const eventId = hubEventId(tenantId, r.externalId);
    const base = { eventId, sourceSystem: `partner:${tenantId}`, sourceEventId: r.externalId, amountKrw: r.amountKrw, currency: "KRW" as const, occurredAt: r.occurredAt };
    let input: RevenueInput;
    if (r.kind === "REFUND") {
      const original = hubEventId(tenantId, r.originalExternalId);
      if ((await tx.query("SELECT 1 FROM revenue_event WHERE event_id = $1", [original])).rowCount === 0) {
        return { status: "REJECTED", code: "UNKNOWN_ORIGINAL", message: `original transaction ${r.originalExternalId} has not been received` };
      }
      input = { ...base, eventType: "REFUND", relatedEventId: original };
    } else {
      const asset = (await tx.query("SELECT vc_id FROM partner_asset WHERE tenant_id = $1 AND external_id = $2 AND status = 'CONFIRMED'", [tenantId, r.assetId])).rows[0];
      if (asset === undefined) return { status: "REJECTED", code: "UNKNOWN_ASSET", message: `asset ${r.assetId} is not mapped to a combination` };
      const seal = (await tx.query(
        "SELECT i.policy_digest FROM rights_snapshot s JOIN issue_seal i ON i.snapshot_id = s.snapshot_id WHERE s.vc_id = $1", [asset.vc_id],
      )).rows[0];
      if (seal === undefined) return { status: "REJECTED", code: "NOT_ISSUED", message: `combination ${asset.vc_id} has no issue seal` };
      if (r.kind === "STREAM_REVENUE" && !(await policyEventTypes(ctx, tx, seal.policy_digest)).includes("TRAFFIC")) {
        return { status: "REJECTED", code: "POLICY_NO_TRAFFIC", message: `the policy sealed for ${asset.vc_id} does not accept TRAFFIC revenue` };
      }
      input = { ...base, eventType: r.kind === "SALE" ? "PURCHASE" : "TRAFFIC", vcId: asset.vc_id as string };
    }
    // 매출 수집은 수집 신원(SYSTEM)의 일이다. 파일을 보낸 파트너 사용자가 감사 행위자로 남는다.
    const ingester: Actor = { ...actor, roles: new Set([...actor.roles, "SYSTEM"]) };
    await tx.query("SAVEPOINT hub_record");
    try {
      const out = await ingestRevenue(tx, clock, ingester, input, hooks.onRefund, hooks.onRevision);
      await tx.query("RELEASE SAVEPOINT hub_record");
      return { status: out.created ? "ACCEPTED" : "DUPLICATE", eventId: out.eventId };
    } catch (e) {
      await tx.query("ROLLBACK TO SAVEPOINT hub_record");
      if (!(e instanceof DomainError) || e.status >= 500) throw e;
      return { status: "REJECTED", code: e.code, message: e.message };
    }
  });
}

/**
 * 거부 큐 재처리(운영): 고칠 수 있는 사유(자산 대응 없음, 원거래 미도착, 미발행)로 거부된 줄을 저장된 정규화 레코드로 다시 적용한다.
 * 원본 파일은 바뀌지 않는다. 줄마다 시도 횟수를 센다.
 */
export async function retryFile(ctx: BridgeCtx, tx: Tx, clock: Clock, hooks: HubHooks, actor: Actor, fileId: string) {
  requireRole(actor, "SPACE_OPS");
  const file = (await tx.query("SELECT tenant_id, status FROM inbound_file WHERE file_id = $1", [fileId])).rows[0];
  if (file === undefined) throw notFound("inbound file", fileId);
  const rows = (await tx.query(
    "SELECT line_no, record FROM inbound_record WHERE file_id = $1 AND status = 'REJECTED' AND reject_code = ANY($2) ORDER BY line_no FOR UPDATE", [fileId, [...RETRIABLE]],
  )).rows;
  const now = clock.now();
  let fixed = 0;
  for (const r of rows) {
    const res = await applyRecord(ctx, tx, clock, hooks, actor, file.tenant_id as string, r.record as Normalized);
    if (res.status !== "REJECTED") fixed++;
    await tx.query(
      "UPDATE inbound_record SET status = $3, reject_code = $4, reject_message = $5, event_id = $6, attempts = attempts + 1, updated_at = $7 WHERE file_id = $1 AND line_no = $2",
      [fileId, r.line_no, res.status, res.status === "REJECTED" ? res.code : null, res.status === "REJECTED" ? res.message : null, res.status === "REJECTED" ? null : res.eventId, now],
    );
  }
  await audit(tx, clock, { actor: actor.userId, action: "INBOUND_RETRIED", entityType: "inbound_file", entityId: fileId, after: { retried: rows.length, fixed } });
  return { retried: rows.length, fixed, file: await getFile(tx, fileId) };
}

/** 자산 대응 등록(운영): 파트너의 자산 id → 조합. 발행된 조합만. */
export async function mapAsset(tx: Tx, clock: Clock, actor: Actor, input: { tenantId?: unknown; externalId?: unknown; vcId?: unknown }) {
  requireRole(actor, "SPACE_OPS");
  if (typeof input.tenantId !== "string" || typeof input.externalId !== "string" || input.externalId.trim() === "" || typeof input.vcId !== "string") {
    throw new DomainError("BAD_REQUEST", 400, "tenantId, externalId and vcId are required");
  }
  const tenant = (await tx.query("SELECT tenant_type FROM tenant WHERE tenant_id = $1", [input.tenantId])).rows[0];
  if (tenant?.tenant_type !== "B2B_PARTNER") throw invalid("NOT_A_PARTNER", `${input.tenantId} is not a partner tenant`);
  if ((await tx.query("SELECT 1 FROM rights_snapshot WHERE vc_id = $1", [input.vcId])).rowCount === 0) throw notFound("combination", input.vcId);
  await tx.query("INSERT INTO partner_asset (tenant_id, external_id, vc_id, created_by, created_at) VALUES ($1,$2,$3,$4,$5)",
    [input.tenantId, input.externalId.trim(), input.vcId, actor.userId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "PARTNER_ASSET_MAPPED", entityType: "partner_asset", entityId: `${input.tenantId}/${input.externalId.trim()}`, after: { vcId: input.vcId } });
  return { tenantId: input.tenantId, externalId: input.externalId.trim(), vcId: input.vcId };
}

export async function listAssets(tx: Tx, tenantId?: string) {
  const rows = (await tx.query(
    `SELECT tenant_id, external_id, vc_id, created_at FROM partner_asset ${tenantId === undefined ? "" : "WHERE tenant_id = $1"} ORDER BY tenant_id, external_id`,
    tenantId === undefined ? [] : [tenantId],
  )).rows;
  return rows.map((r) => ({ tenantId: r.tenant_id as string, externalId: r.external_id as string, vcId: r.vc_id as string, createdAt: iso(r.created_at)! }));
}

export async function getFile(tx: Tx, fileId: string) {
  const f = (await tx.query("SELECT file_id, tenant_id, format, file_name, file_sha256, byte_size, status, file_errors, received_by, received_at FROM inbound_file WHERE file_id = $1", [fileId])).rows[0];
  if (f === undefined) throw notFound("inbound file", fileId);
  const records = (await tx.query("SELECT line_no, raw, status, reject_code, reject_message, event_id, attempts FROM inbound_record WHERE file_id = $1 ORDER BY line_no", [fileId])).rows;
  const counts = { ACCEPTED: 0, DUPLICATE: 0, REJECTED: 0 } as Record<string, number>;
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    fileId: f.file_id as string, tenantId: f.tenant_id as string, format: f.format as string, fileName: f.file_name as string, sha256: f.file_sha256 as string,
    byteSize: f.byte_size as number, status: f.status as string, fileErrors: f.file_errors as { code: string; message: string }[],
    receivedBy: f.received_by as string, receivedAt: iso(f.received_at)!, counts,
    records: records.map((r) => ({
      line: r.line_no as number, raw: r.raw as string, status: r.status as string, attempts: r.attempts as number,
      ...(r.reject_code !== null && { rejectCode: r.reject_code as string, rejectMessage: r.reject_message as string, retriable: RETRIABLE.has(r.reject_code as string) }),
      ...(r.event_id !== null && { eventId: r.event_id as string }),
    })),
  };
}

/** 파일 목록(최근 순). 파트너는 RLS로 자기 테넌트 것만 본다. */
export async function listFiles(tx: Tx) {
  const ids = (await tx.query("SELECT file_id FROM inbound_file ORDER BY received_at DESC, file_id LIMIT 200")).rows;
  const out = [];
  for (const r of ids) {
    const { records: _records, ...summary } = await getFile(tx, r.file_id as string);
    out.push(summary);
  }
  return out;
}

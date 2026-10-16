import { canonicalize, digestOf } from "mdrl/core";
import { createHash } from "node:crypto";
import type { Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";

export type SealKind = "facts" | "allocation" | "projection" | "members" | "events" | "allocation_result" | "reversal_result" | "manifest";
export type Sealed = { digest: string; kind: SealKind; docId?: string; docVersion?: string; format?: string };

const INLINE_LIMIT = 64 * 1024;

/**
 * 자기 digest를 품는 엔진 출력. 봉인 본문은 그 필드와 설명 자료 trace를 뺀 값이고, 본문의 digest가 곧 봉인 digest다
 * (데이터모델 v2.8 3.11, 코어 규격 12.48·12.50). 그래서 run이 가리키는 digest와 IR 안의 result_digest가 같다.
 */
const SELF_DIGEST: Partial<Record<SealKind, string>> = { projection: "digest", allocation_result: "result_digest", reversal_result: "result_digest" };

/** 봉인 본문: 자기 digest 필드와 trace를 뺀다. trace는 재계산으로만 확인하는 자료라 봉인하지 않는다. */
export function sealBody(kind: SealKind, value: unknown): unknown {
  const field = SELF_DIGEST[kind];
  if (field === undefined) return value;
  const { [field]: _self, trace: _trace, ...body } = value as Record<string, unknown>;
  return body;
}

/**
 * 값을 JCS로 정규화해 blob에 쓰고 sealed_document에 기록한다. 같은 digest는 한 번만 저장된다(멱등).
 * 캐시는 채우지 않는다: 트랜잭션이 롤백되면 봉인되지 않은 값이 캐시에 남기 때문이다(캐시는 loadSealed만 채운다).
 */
export async function sealDocument(
  ctx: BridgeCtx, tx: Tx, input: { kind: SealKind; value: unknown; docId?: string; docVersion?: string; format?: string },
): Promise<Sealed> {
  const body = sealBody(input.kind, input.value);
  const text = canonicalize(body);
  const digest = digestOf(body);
  const field = SELF_DIGEST[input.kind];
  if (field !== undefined && (input.value as Record<string, unknown>)[field] !== digest) {
    throw new DomainError("SEAL_SELF_DIGEST_MISMATCH", 500, `${input.kind} ${field} does not match its sealed body ${digest}`);
  }
  const bytes = new TextEncoder().encode(text);
  const uri = await ctx.blobs.put(digest, bytes);
  await tx.query(
    `INSERT INTO sealed_document (digest, kind, doc_id, doc_version, format, byte_size, storage_uri, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (digest) DO NOTHING`,
    [digest, input.kind, input.docId ?? null, input.docVersion ?? null, input.format ?? null, bytes.length, uri,
      bytes.length <= INLINE_LIMIT ? text : null],
  );
  return { digest, kind: input.kind, ...(input.docId && { docId: input.docId }), ...(input.docVersion && { docVersion: input.docVersion }), ...(input.format && { format: input.format }) };
}

/** 봉인 문서를 읽는다. 캐시에 없으면 JSONB 사본 또는 blob에서 읽고 digest를 다시 계산해 대조한다. 자기 digest 필드는 봉인 digest로 다시 붙인다(trace는 없다). */
export async function loadSealed(ctx: BridgeCtx, tx: Tx, digest: string): Promise<unknown> {
  if (ctx.cache.has(digest)) return ctx.cache.get(digest);
  const value = await readSealedUncached(ctx, tx, digest);
  deepFreeze(value);
  ctx.cache.set(digest, value);
  return value;
}

/**
 * 캐시를 채우지 않고 읽는다(캐시에 있으면 그 값). 같은 트랜잭션에서 방금 봉인한 문서를 읽을 때 쓴다:
 * 트랜잭션이 롤백되면 봉인되지 않은 값이 캐시에 남기 때문이다(sealDocument와 같은 이유).
 */
export async function readSealedUncached(ctx: BridgeCtx, tx: Tx, digest: string): Promise<unknown> {
  if (ctx.cache.has(digest)) return ctx.cache.get(digest);
  const row = (await tx.query("SELECT kind, content, storage_uri FROM sealed_document WHERE digest = $1", [digest])).rows[0];
  if (row === undefined) throw notFound("sealed document", digest);
  const value: unknown = row.content ?? JSON.parse(new TextDecoder().decode(await ctx.blobs.get(row.storage_uri)));
  if (digestOf(value) !== digest) throw new DomainError("SEAL_CORRUPT", 500, `sealed document ${digest} does not match its digest`);
  const field = SELF_DIGEST[row.kind as SealKind];
  // 필드가 이미 있으면 이 규칙 이전에 통째로 봉인된 문서다. 그대로 돌려준다.
  if (field === undefined || Object.hasOwn(value as object, field)) return value;
  return { ...(value as Record<string, unknown>), [field]: digest };
}

/** 캐시 값은 프로세스 전체가 공유하므로 깊게 동결한다. */
function deepFreeze(v: unknown): void {
  if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
  for (const x of Object.values(v)) deepFreeze(x);
  Object.freeze(v);
}

/** 봉인하지 않는 값의 정규화 해시(JCS, hex). 판정 캐시 키처럼 같은 값이면 같은 키가 필요할 때 쓴다. 숫자는 문자열로 넘긴다. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

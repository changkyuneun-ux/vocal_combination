import { canonicalize, digestOf } from "mdrl/core";
import type { Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";

export type SealKind = "facts" | "allocation" | "projection" | "members" | "events" | "allocation_result" | "reversal_result" | "manifest";
export type Sealed = { digest: string; kind: SealKind; docId?: string; docVersion?: string; format?: string };

const INLINE_LIMIT = 64 * 1024;

/**
 * 값을 JCS로 정규화해 blob에 쓰고 sealed_document에 기록한다. 같은 digest는 한 번만 저장된다(멱등).
 * 캐시는 채우지 않는다: 트랜잭션이 롤백되면 봉인되지 않은 값이 캐시에 남기 때문이다(캐시는 loadSealed만 채운다).
 */
export async function sealDocument(
  ctx: BridgeCtx, tx: Tx, input: { kind: SealKind; value: unknown; docId?: string; docVersion?: string; format?: string },
): Promise<Sealed> {
  const text = canonicalize(input.value);
  const digest = digestOf(input.value);
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

/** 봉인 문서를 읽는다. 캐시에 없으면 JSONB 사본 또는 blob에서 읽고 digest를 다시 계산해 대조한다. */
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
  const row = (await tx.query("SELECT content, storage_uri FROM sealed_document WHERE digest = $1", [digest])).rows[0];
  if (row === undefined) throw notFound("sealed document", digest);
  const value: unknown = row.content ?? JSON.parse(new TextDecoder().decode(await ctx.blobs.get(row.storage_uri)));
  if (digestOf(value) !== digest) throw new DomainError("SEAL_CORRUPT", 500, `sealed document ${digest} does not match its digest`);
  return value;
}

/** 캐시 값은 프로세스 전체가 공유하므로 깊게 동결한다. */
function deepFreeze(v: unknown): void {
  if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
  for (const x of Object.values(v)) deepFreeze(x);
  Object.freeze(v);
}

import { withSystemScope } from "./actor.ts";
import type { Db } from "./db.ts";
import type { ObjectStore } from "./object-store.ts";

/**
 * 고아 객체 정리(아키텍처 다음 작업 15): 봉인 원문·원천 문서는 DB 행보다 먼저 쓰므로, 트랜잭션이 롤백되면 행 없는 객체가 남는다.
 * 내용 주소라 정합성에는 영향이 없지만 쌓이므로 치운다. 쓰는 중인 트랜잭션과 겹치지 않게 graceMs보다 오래된 객체만 본다.
 * 오디오는 치우지 않는다(바뀐 원본도 분쟁 때 근거가 될 수 있다).
 */
export type GcResult = { checked: number; removed: string[] };

/** 봉인 원문: 키 <2>/<2>/<hex>.json, sealed_document.digest = mdrl:sha256:<hex>. */
export async function sweepOrphanSeals(db: Db, os: ObjectStore, nowMs: number, graceMs: number): Promise<GcResult> {
  const out: GcResult = { checked: 0, removed: [] };
  for await (const o of os.list()) {
    const m = /^[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\.json$/.exec(o.key);
    if (m === null || Date.parse(o.modifiedAt) > nowMs - graceMs) continue;
    out.checked++;
    const live = await db.tx((tx) => withSystemScope(tx, async () => (await tx.query("SELECT 1 FROM sealed_document WHERE digest = $1", [`mdrl:sha256:${m[1]}`])).rowCount !== 0));
    if (!live) { await os.delete(o.key); out.removed.push(o.key); }
  }
  return out;
}

/** 원천 문서: 키 <테넌트>/<2>/<해시>, source_document(owner_tenant_id, file_sha256). */
export async function sweepOrphanDocuments(db: Db, os: ObjectStore, nowMs: number, graceMs: number): Promise<GcResult> {
  const out: GcResult = { checked: 0, removed: [] };
  for await (const o of os.list()) {
    const m = /^([A-Za-z0-9._-]+)\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(o.key);
    if (m === null || Date.parse(o.modifiedAt) > nowMs - graceMs) continue;
    out.checked++;
    const live = await db.tx((tx) => withSystemScope(tx, async () =>
      (await tx.query("SELECT 1 FROM source_document WHERE owner_tenant_id = $1 AND file_sha256 = $2", [m[1], m[2]])).rowCount !== 0));
    if (!live) { await os.delete(o.key); out.removed.push(o.key); }
  }
  return out;
}

/** RC_OBJECT_GC_MS(기본 6시간, 0이면 끔)마다 두 저장소를 정리한다. 유예는 RC_OBJECT_GC_GRACE_MS(기본 1시간). 워커 역할에서만 돈다. */
export function startObjectGc(db: Db, stores: { seal: ObjectStore; documents: ObjectStore }, env: Readonly<Record<string, string | undefined>>): () => void {
  const every = Number(env.RC_OBJECT_GC_MS ?? 6 * 3_600_000);
  const grace = Number(env.RC_OBJECT_GC_GRACE_MS ?? 3_600_000);
  if (!Number.isFinite(every) || every <= 0) return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    (async () => {
      const s = await sweepOrphanSeals(db, stores.seal, Date.now(), grace);
      const d = await sweepOrphanDocuments(db, stores.documents, Date.now(), grace);
      if (s.removed.length + d.removed.length > 0) console.log(`object gc: removed ${s.removed.length} seal(s), ${d.removed.length} document(s)`);
    })().catch((e) => console.error("object gc", e)).finally(() => { busy = false; });
  }, every);
  timer.unref();
  return () => clearInterval(timer);
}

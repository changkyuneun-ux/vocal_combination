import { withSystemScope } from "../platform/actor.ts";
import type { Tx } from "../platform/db.ts";

/**
 * 판정 캐시 무효화(다음 작업 12). 바뀐 것에 의존하는 항목만 지우고, 곡의 세대를 올려 계산 중이던 낡은 결과가 저장되지 않게 한다.
 * - voices: 이 보이스를 쓰는 항목(실연 동의가 바뀜)
 * - stems: 이 스템을 쓰는 항목(오디오 상태가 바뀜)
 * - all: 곡의 모든 항목(녹음·작품 동의, 분쟁, 팩 상태)
 * 바꾼 쪽 트랜잭션 안에서 부른다(같이 커밋·롤백). 캐시 표는 플랫폼 전용이라 system 범위로 쓴다.
 */
export async function invalidateDecisions(tx: Tx, factsScopeId: string, what: { voices?: string[]; stems?: string[]; all?: boolean }): Promise<number> {
  return withSystemScope(tx, async () => {
    await tx.query(
      "INSERT INTO decision_epoch (facts_scope_id, epoch) VALUES ($1, 1) ON CONFLICT (facts_scope_id) DO UPDATE SET epoch = decision_epoch.epoch + 1", [factsScopeId]);
    const r = what.all
      ? await tx.query("DELETE FROM decision_cache WHERE facts_scope_id = $1", [factsScopeId])
      : await tx.query("DELETE FROM decision_cache WHERE facts_scope_id = $1 AND (voices && $2::text[] OR stems && $3::text[])", [factsScopeId, what.voices ?? [], what.stems ?? []]);
    return r.rowCount ?? 0;
  });
}

/** 스템이 속한 곡(facts 범위)을 찾아 그 스템을 쓰는 항목을 지운다. */
export async function invalidateStem(tx: Tx, stemId: string): Promise<void> {
  const scope = await withSystemScope(tx, async () => (await tx.query(
    "SELECT f.facts_scope_id FROM stem s JOIN recording_version r ON r.recording_id = s.recording_id JOIN facts_scope f ON f.work_id = r.work_id WHERE s.stem_id = $1", [stemId])).rows[0]?.facts_scope_id as string | undefined);
  if (scope !== undefined) await invalidateDecisions(tx, scope, { stems: [stemId] });
}

/** 팩이 속한 곡의 항목을 모두 지운다(팩 활성화·일시정지). */
export async function invalidatePack(tx: Tx, packId: string): Promise<void> {
  const scope = await withSystemScope(tx, async () => (await tx.query("SELECT facts_scope_id FROM vocal_pack WHERE pack_id = $1", [packId])).rows[0]?.facts_scope_id as string | undefined);
  if (scope !== undefined) await invalidateDecisions(tx, scope, { all: true });
}

import { evidenceOf } from "../documents/service.ts";
import { withSystemScope } from "../platform/actor.ts";
import { iso, type Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";

type Evidence = { documentId: string; version: number; title: string; kind: string; status: string };
export type SummaryLine = {
  area: "MASTER" | "WORK" | "VOICE" | "MANDATE"; subject: string; text: string;
  records: { type: "CLAIM" | "MANDATE"; id: string; version: number; status: string }[]; evidence: Evidence[];
};

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const mark = (status: string) => (status === "ASSERTED" ? "(미확인)" : status === "DISPUTED" ? "(분쟁 중)" : "");

/**
 * 권리 요약(원천 문서 설계 S1, 5절): 곡의 현재 권리 주장·위임을 사람이 읽는 문장으로 보여 준다. 문장마다 근거 기록과 근거 원천 문서가 붙는다.
 * 봉인 IR은 보여 주지 않고, 활성 정책이 고정한 facts 봉인 이후 바뀐 기록 수와 정책 서명만 배지로 알린다.
 * 범위는 요청자에게 보여야 한다(RLS). 표시 이름과 봉인 정보는 곡 안에서만 system 범위로 읽는다.
 */
export async function rightsSummary(tx: Tx, scopeId: string) {
  const scope = (await tx.query("SELECT s.facts_scope_id, s.work_id, w.title FROM facts_scope s JOIN work w ON w.work_id = s.work_id WHERE s.facts_scope_id = $1", [scopeId])).rows[0];
  if (scope === undefined) throw notFound("facts scope", scopeId);
  return withSystemScope(tx, async () => {
    const claims = (await tx.query(
      "SELECT claim_id, version, source_id, edge, target_id, share_bps, status FROM right_claim WHERE facts_scope_id = $1 AND superseded_at IS NULL AND status <> 'SUPERSEDED' ORDER BY claim_id", [scopeId])).rows;
    const mandates = (await tx.query(
      "SELECT mandate_id, version, from_party_id, to_party_id, right_kind, share_bps, status FROM mandate WHERE facts_scope_id = $1 AND superseded_at IS NULL AND status <> 'SUPERSEDED' ORDER BY mandate_id", [scopeId])).rows;
    const recordings = (await tx.query("SELECT recording_id, version_title FROM recording_version WHERE work_id = $1 ORDER BY recording_id", [scope.work_id])).rows;
    const partyIds = [...new Set([...claims.filter((c) => c.edge !== "PERFORMED_BY").map((c) => c.target_id), ...mandates.flatMap((m) => [m.from_party_id, m.to_party_id])])];
    const names = new Map((await tx.query("SELECT party_id, display_name FROM party WHERE party_id = ANY($1)", [partyIds])).rows.map((r) => [r.party_id as string, r.display_name as string]));
    const name = (p: string) => names.get(p) ?? p;
    const claimEv = await evidenceOf(tx, "CLAIM", claims.map((c) => ({ id: c.claim_id, version: c.version })));
    const mandateEv = await evidenceOf(tx, "MANDATE", mandates.map((m) => ({ id: m.mandate_id, version: m.version })));
    const evOf = (rows: any[], key: string, ev: Map<string, Evidence[]>) => {
      const seen = new Map<string, Evidence>();
      for (const r of rows) for (const e of ev.get(`${r[key]}@${r.version}`) ?? []) seen.set(`${e.documentId}@${e.version}`, e);
      return [...seen.values()];
    };
    const claimRefs = (rows: any[]) => rows.map((c) => ({ type: "CLAIM" as const, id: c.claim_id as string, version: c.version as number, status: c.status as string }));
    const holders = (rows: any[]) => rows.map((c) => `${name(c.target_id)} ${pct(c.share_bps)}${mark(c.status)}`).join(", ");

    const lines: SummaryLine[] = [];
    for (const r of recordings) {
      const own = claims.filter((c) => c.edge === "CONTROLLED_BY" && c.source_id === r.recording_id);
      lines.push({ area: "MASTER", subject: r.recording_id, text: `녹음 "${r.version_title}": ${own.length === 0 ? "권리자 없음" : holders(own)}`, records: claimRefs(own), evidence: evOf(own, "claim_id", claimEv) });
    }
    const written = claims.filter((c) => c.edge === "WRITTEN_BY");
    lines.push({ area: "WORK", subject: scope.work_id, text: `작품 "${scope.title}": ${written.length === 0 ? "권리자 없음" : holders(written)}`, records: claimRefs(written), evidence: evOf(written, "claim_id", claimEv) });
    const voices = [...new Set(claims.filter((c) => c.edge === "OWNED_BY").map((c) => c.source_id as string))];
    for (const v of voices) {
      const owned = claims.filter((c) => c.edge === "OWNED_BY" && c.source_id === v);
      const sung = claims.filter((c) => c.edge === "PERFORMED_BY" && c.target_id === v);
      const owners = owned.map((c) => c.target_id as string);
      const routed = mandates.filter((m) => m.right_kind === "PERFORMER" && owners.includes(m.from_party_id));
      const via = routed.length === 0 ? "" : ` · 실연 몫 수령: ${routed.map((m) => `${name(m.to_party_id)}(위임 ${pct(m.share_bps)}${mark(m.status)})`).join(", ")}`;
      lines.push({
        area: "VOICE", subject: v, text: `보이스 ${v}: ${holders(owned)} 소유 · 스템 ${sung.length}개${via}`,
        records: [...claimRefs(owned), ...claimRefs(sung), ...routed.map((m) => ({ type: "MANDATE" as const, id: m.mandate_id as string, version: m.version as number, status: m.status as string }))],
        evidence: [...evOf([...owned, ...sung], "claim_id", claimEv), ...evOf(routed, "mandate_id", mandateEv)],
      });
    }
    for (const m of mandates.filter((x) => x.right_kind !== "PERFORMER")) {
      lines.push({
        area: "MANDATE", subject: m.mandate_id, text: `${m.right_kind === "WORK" ? "작품" : "녹음"} 몫 수령 위임: ${name(m.from_party_id)} → ${name(m.to_party_id)} ${pct(m.share_bps)}${mark(m.status)}`,
        records: [{ type: "MANDATE", id: m.mandate_id, version: m.version, status: m.status }], evidence: evOf([m], "mandate_id", mandateEv),
      });
    }

    const recs = [...claims.map((c) => claimEv.has(`${c.claim_id}@${c.version}`)), ...mandates.map((m) => mandateEv.has(`${m.mandate_id}@${m.version}`))];
    const active = (await tx.query(
      `SELECT v.policy_id, v.version, v.policy_digest, v.facts_digest, v.facts_known_at FROM policy_version v JOIN vocal_pack p ON p.pack_id = v.pack_id
        WHERE p.facts_scope_id = $1 AND v.status = 'ACTIVE' ORDER BY v.policy_id LIMIT 1`, [scopeId])).rows[0];
    let seal = null;
    if (active !== undefined) {
      const changed = Number((await tx.query(
        `SELECT (SELECT count(*) FROM right_claim WHERE facts_scope_id = $1 AND recorded_at > $2) + (SELECT count(*) FROM mandate WHERE facts_scope_id = $1 AND recorded_at > $2) AS n`,
        [scopeId, active.facts_known_at])).rows[0].n);
      const signatures = (await tx.query("SELECT role, signer_id FROM attestation WHERE digest = $1 ORDER BY signed_at, role", [active.policy_digest])).rows;
      seal = {
        policyId: active.policy_id as string, policyVersion: active.version as number, factsDigest: active.facts_digest as string, factsKnownAt: iso(active.facts_known_at)!,
        changedSinceSeal: changed, signatures: signatures.map((s) => ({ role: s.role as string, signerId: s.signer_id as string })),
      };
    }
    return {
      scopeId, workId: scope.work_id as string, title: scope.title as string, lines,
      evidenceCoverage: { records: recs.length, withEvidence: recs.filter(Boolean).length }, seal,
    };
  });
}

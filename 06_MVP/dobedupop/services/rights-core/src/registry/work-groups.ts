import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { optFilter, parsePageNo, slicePageNo } from "../platform/paging.ts";

/**
 * 작품 단위 묶음 목록(2026-10-24, 디자인 가이드 5절 '작품 묶음 표'): 운영 관리 목록을 작품마다 요약 한 줄로.
 * 쪽 번호(10개)와 필터는 작품 요약 목록 기준이다. 펼친 작품의 상세 행은 기존 목록 API에 scope를 주어 따로 쪽으로 읽는다.
 * 보이는 곡은 요청자 범위(RLS)를 따른다. 필터를 주면 그 필터에 걸리는 행이 있는 작품만 남는다.
 */
export const GROUP_KINDS = ["confirmations", "consents", "contracts", "documents", "validation", "issues"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
type Tone = "ok" | "warn" | "bad" | "muted";
export type WorkGroup = { scopeId: string | null; workId: string | null; title: string; sub: string; summary: Record<string, number>; status: [string, Tone] | null };

const CONFIRM_TEMPLATES = ["tpl_claim_confirm_label", "tpl_claim_confirm_author"];

export async function listWorkGroups(tx: Tx, kind: string, q: Record<string, unknown>, now: string) {
  if (!(GROUP_KINDS as readonly string[]).includes(kind)) throw new DomainError("NOT_FOUND", 404, `unknown group kind ${kind}; one of ${GROUP_KINDS.join(", ")}`);
  const f = (n: string) => optFilter(q, n);
  const rows = async (sql: string, p: unknown[] = []) => (await tx.query(sql, p)).rows;
  const works = await rows(
    `SELECT s.facts_scope_id, w.work_id, w.title, (SELECT r.version_title FROM recording_version r WHERE r.work_id = w.work_id ORDER BY r.created_at, r.recording_id LIMIT 1) AS recording
       FROM facts_scope s JOIN work w ON w.work_id = s.work_id ORDER BY w.created_at, w.work_id`);
  const by = <T extends { facts_scope_id: string | null }>(xs: T[]) => new Map(xs.map((x) => [x.facts_scope_id, x]));
  const base = (w: any, sub?: string): Omit<WorkGroup, "summary" | "status"> => ({ scopeId: w.facts_scope_id, workId: w.work_id, title: w.title, sub: sub ?? (w.recording ? `녹음 ${w.recording}` : "") });
  const filtered = Object.keys(q).some((k) => !["page", "size"].includes(k));
  let groups: WorkGroup[] = [];
  if (kind === "confirmations") {
    const cp = f("counterparty"), st = f("status");
    const agg = by(await rows(
      `SELECT r.facts_scope_id, count(*)::int AS n,
              count(*) FILTER (WHERE r.status = 'OPEN')::int AS open,
              count(*) FILTER (WHERE r.status = 'OPEN' AND r.due_at <= $1::timestamptz + interval '3 days')::int AS soon,
              count(*) FILTER (WHERE r.status IN ('CONFIRMED','PLATFORM_VERIFIED'))::int AS confirmed,
              count(*) FILTER (WHERE r.status = 'OPEN' AND p.party_type = 'AUTHOR')::int AS author_open,
              count(*) FILTER (WHERE r.status = 'OPEN' AND p.party_type = 'MEMBER')::int AS member_open
         FROM confirmation_request r JOIN party p ON p.party_id = r.counterparty_id
        WHERE ($2::text IS NULL OR p.party_type = $2) AND ($3::text IS NULL OR r.status = $3) GROUP BY r.facts_scope_id`, [now, cp ?? null, st ?? null]));
    groups = works.map((w) => {
      const a = agg.get(w.facts_scope_id);
      const status: [string, Tone] = !a ? ["요청 없음", "muted"] : a.author_open ? ["작가 서명 대기", "warn"] : a.member_open ? ["멤버 확인 중", "muted"] : a.open ? ["확인 대기", "warn"] : ["모두 확인", "ok"];
      return { ...base(w), summary: { rows: a?.n ?? 0, open: a?.open ?? 0, soon: a?.soon ?? 0, confirmed: a?.confirmed ?? 0 }, status };
    });
  } else if (kind === "consents") {
    const st = f("status"); // SIGNED | REVOKED
    const members = by(await rows("SELECT facts_scope_id, count(DISTINCT target_id)::int AS n FROM right_claim WHERE edge = 'OWNED_BY' AND superseded_at IS NULL GROUP BY facts_scope_id"));
    const agg = by(await rows(
      `SELECT facts_scope_id, count(*)::int AS n, count(DISTINCT party_id) FILTER (WHERE revoked_at IS NULL)::int AS signed, count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
         FROM consent_agreement WHERE right_type = 'PERFORMER' AND ($1::text IS NULL OR ($1 = 'SIGNED' AND revoked_at IS NULL) OR ($1 = 'REVOKED' AND revoked_at IS NOT NULL))
        GROUP BY facts_scope_id`, [st ?? null]));
    groups = works.map((w) => {
      const m = members.get(w.facts_scope_id)?.n ?? 0, a = agg.get(w.facts_scope_id);
      const signed = a?.signed ?? 0, pending = Math.max(m - signed, 0) + (a?.revoked ?? 0);
      return { ...base(w), summary: { rows: a?.n ?? 0, members: m, signed, pending }, status: m === 0 ? null : pending === 0 ? ["모두 동의", "ok"] : ["동의 대기", "warn"] };
    });
  } else if (kind === "contracts") {
    const kindF = f("kind"), st = f("status"); // kind: confirm | license
    const agg = by(await rows(
      `SELECT facts_scope_id, count(*)::int AS n, count(*) FILTER (WHERE status IN ('SENT','SIGNED'))::int AS pending, count(*) FILTER (WHERE status = 'COMPLETED')::int AS done
         FROM contract_envelope WHERE template_id <> 'tpl_platform_contract' AND status <> 'CANCELLED'
          AND ($1::text IS NULL OR ($1 = 'confirm' AND template_id = ANY($3)) OR ($1 = 'license' AND NOT (template_id = ANY($3))))
          AND ($2::text IS NULL OR status = $2) GROUP BY facts_scope_id`, [kindF ?? null, st ?? null, CONFIRM_TEMPLATES]));
    groups = works.map((w) => {
      const a = agg.get(w.facts_scope_id);
      return { ...base(w), summary: { rows: a?.n ?? 0, pending: a?.pending ?? 0, done: a?.done ?? 0 }, status: !a ? null : a.pending ? ["서명 대기", "warn"] : ["모두 반영", "ok"] };
    });
  } else if (kind === "documents") {
    const origin = f("origin"); // UPLOADED | TEMPLATE_SIGNED
    const agg = await rows(
      `SELECT d.facts_scope_id, count(*)::int AS n, count(*) FILTER (WHERE d.origin = 'UPLOADED')::int AS originals, count(*) FILTER (WHERE d.origin = 'TEMPLATE_SIGNED')::int AS signed,
              (SELECT count(DISTINCT (e.record_type, e.record_id)) FROM record_evidence e WHERE e.document_id = ANY(array_agg(d.document_id)))::int AS records
         FROM (SELECT DISTINCT ON (document_id) * FROM source_document ORDER BY document_id, version DESC) d
        WHERE ($1::text IS NULL OR d.origin = $1) GROUP BY d.facts_scope_id`, [origin ?? null]);
    const m = by(agg);
    groups = works.map((w) => {
      const a = m.get(w.facts_scope_id);
      return { ...base(w), summary: { rows: a?.n ?? 0, originals: a?.originals ?? 0, signed: a?.signed ?? 0, records: a?.records ?? 0 }, status: null };
    });
    const org = m.get(null);
    if (org) groups.push({ scopeId: null, workId: null, title: "조직 문서(작품 공통)", sub: "KYB · 플랫폼 이용계약", summary: { rows: org.n, originals: org.originals, signed: org.signed, records: org.records }, status: null });
  } else if (kind === "validation") {
    const sev = f("severity"); // BLOCK | WARN | BLOCK,WARN
    const sevs = sev?.split(",") ?? null;
    const agg = by(await rows(
      `SELECT facts_scope_id, count(*)::int AS n, count(*) FILTER (WHERE severity = 'BLOCK')::int AS block, count(*) FILTER (WHERE severity = 'WARN')::int AS warn,
              array_agg(DISTINCT rule_code) AS rules
         FROM validation_issue WHERE status = 'OPEN' AND ($1::text[] IS NULL OR severity = ANY($1)) GROUP BY facts_scope_id`, [sevs]));
    groups = works.map((w) => {
      const a = agg.get(w.facts_scope_id);
      return { ...base(w), summary: { rows: a?.n ?? 0, block: a?.block ?? 0, warn: a?.warn ?? 0 }, status: !a ? ["통과", "ok"] : a.block ? ["차단", "bad"] : a.warn ? ["경고", "warn"] : ["확인", "muted"], rules: (a?.rules ?? []) as string[] } as WorkGroup;
    });
  } else {
    const pack = f("pack");
    const agg = by(await rows(
      `SELECT p.facts_scope_id, count(s.snapshot_id)::int AS n, string_agg(DISTINCT p.pack_code, ', ') AS packs, max(s.created_at) AS last
         FROM vocal_pack p LEFT JOIN rights_snapshot s ON s.pack_id = p.pack_id WHERE ($1::text IS NULL OR p.pack_id = $1) GROUP BY p.facts_scope_id`, [pack ?? null]));
    groups = works.map((w) => {
      const a = agg.get(w.facts_scope_id);
      return { ...base(w, a?.packs ? `팩 ${a.packs}` : ""), summary: { rows: a?.n ?? 0, issued: a?.n ?? 0 }, status: null };
    });
  }
  // 필터를 주면 걸리는 행이 있는 작품만(필터 없음 = 모든 작품, 행이 없어도 요약 한 줄).
  const out = filtered ? groups.filter((g) => g.summary.rows! > 0) : groups;
  return slicePageNo(out, parsePageNo(q) ?? { page: 1, size: 10, offset: 0 });
}

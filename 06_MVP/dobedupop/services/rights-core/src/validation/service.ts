import { factsDiagnostics } from "../engine-bridge/facts-check.ts";
import { requireRole, withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";

/** WARN 기본 기한(결정 D8): 14일. 위험 수용은 한 번에 최대 30일, 연장은 한 번만. 만료 임박은 30일 전부터 알린다. */
export const WARN_DAYS = 14;
export const ACCEPT_DAYS = 30;
const SOON_DAYS = 30;
const DAY = 86_400_000;

type Severity = "BLOCK" | "WARN" | "INFO";
type SubjectType = "SCOPE" | "DOCUMENT" | "RECORD" | "PARTY" | "CONSENT" | "VOICE";
export type Violation = {
  rule: string; severity: Severity; subjectType: SubjectType; subjectId: string; message: string; hint: string;
  related?: unknown[]; dueAt?: string;
};

/**
 * 곡 하나의 규칙 검사(원천 문서 설계 6.1, 결정 D7·D8). 같은 행이면 같은 결과다(결정적). 저장된 기록만 본다.
 * 엔진 진단(facts 검증)은 그대로 옮기고, 문서 층 규칙(DOC_*)만 여기서 정한다.
 */
export async function checkScope(tx: Tx, scopeId: string, now: string): Promise<Violation[]> {
  const out: Violation[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await tx.query(sql, p)).rows;
  // 1. 엔진: 지분 합·경로·순환 등 facts 정적 검증.
  for (const d of await factsDiagnostics(tx, scopeId, now)) {
    out.push({ rule: d.code, severity: "BLOCK", subjectType: "SCOPE", subjectId: d.path, message: `권리 사실 검증 실패: ${d.message}`, hint: "권리 주장·위임의 지분·대상을 고친다" });
  }
  const claims = await q("SELECT claim_id, version, source_id, edge, target_id, status FROM right_claim WHERE facts_scope_id = $1 AND superseded_at IS NULL AND status <> 'SUPERSEDED'", [scopeId]);
  const mandates = await q("SELECT mandate_id, version, from_party_id, to_party_id, right_kind, share_bps, status FROM mandate WHERE facts_scope_id = $1 AND superseded_at IS NULL AND status <> 'SUPERSEDED'", [scopeId]);
  const evidence = await q(
    `SELECT e.record_type, e.record_id, e.record_version, d.document_id, d.version, d.title, d.parties, d.status, d.effective_to
       FROM record_evidence e JOIN source_document d ON d.document_id = e.document_id AND d.version = e.document_version
      WHERE (e.record_type = 'CLAIM' AND (e.record_id, e.record_version) IN (SELECT claim_id, version FROM right_claim WHERE facts_scope_id = $1 AND superseded_at IS NULL))
         OR (e.record_type = 'MANDATE' AND (e.record_id, e.record_version) IN (SELECT mandate_id, version FROM mandate WHERE facts_scope_id = $1 AND superseded_at IS NULL))`, [scopeId]);
  // 같은 문서의 최신(거부되지 않은) 버전: 개정·해지는 새 버전으로 올라오므로 효력 기간은 최신 버전이 정한다(S3b).
  const latest = new Map<string, any>((await q(
    `SELECT DISTINCT ON (document_id) document_id, version, title, effective_to FROM source_document
      WHERE document_id = ANY($1) AND status <> 'REJECTED' ORDER BY document_id, version DESC`, [[...new Set(evidence.map((e) => e.document_id as string))]])).map((d) => [d.document_id, d]));
  const evOf = (type: string, id: string, v: number) => evidence.filter((e) => e.record_type === type && e.record_id === id && e.record_version === v);
  const rec = (type: string, id: string) => `${type}:${id}`;

  // 2. 필수 근거 문서(D7): 녹음·작품 권리 주장, 실연 수령 위임은 BLOCK, 그 밖의 위임(신탁 등)은 WARN.
  for (const c of claims.filter((x) => x.edge === "CONTROLLED_BY" || x.edge === "WRITTEN_BY")) {
    if (evOf("CLAIM", c.claim_id, c.version).length === 0) {
      out.push({ rule: "DOC_EVIDENCE_MISSING", severity: "BLOCK", subjectType: "RECORD", subjectId: rec("CLAIM", c.claim_id),
        message: `${c.edge === "CONTROLLED_BY" ? "녹음" : "작품"} 권리 주장 ${c.claim_id}에 근거 문서가 없다`, hint: `${c.edge === "CONTROLLED_BY" ? "녹음 계약" : "퍼블리싱(작품) 계약"}을 올리고 근거로 연결한다` });
    }
  }
  for (const m of mandates) {
    if (evOf("MANDATE", m.mandate_id, m.version).length === 0) {
      out.push({ rule: "DOC_EVIDENCE_MISSING", severity: m.right_kind === "PERFORMER" ? "BLOCK" : "WARN", subjectType: "RECORD", subjectId: rec("MANDATE", m.mandate_id),
        message: `위임 ${m.mandate_id}(${m.from_party_id} → ${m.to_party_id})에 근거 문서가 없다`, hint: m.right_kind === "PERFORMER" ? "전속계약의 수익 수령 조항을 근거로 연결한다" : "신탁·위임 사실 증빙을 연결한다" });
    }
  }
  // 3. 근거 문서와 기록이 맞는가: 당사자, 거부된 문서, 효력 기간.
  const holderOf = (e: any): string | undefined => {
    if (e.record_type === "MANDATE") return mandates.find((m) => m.mandate_id === e.record_id)?.from_party_id;
    const c = claims.find((x) => x.claim_id === e.record_id);
    return c === undefined || c.edge === "PERFORMED_BY" ? undefined : c.target_id;
  };
  for (const e of evidence) {
    const subject = rec(e.record_type, e.record_id);
    const holder = holderOf(e);
    if (holder !== undefined && e.parties.length > 0 && !e.parties.includes(holder)) {
      out.push({ rule: "DOC_PARTY_MISMATCH", severity: "BLOCK", subjectType: "RECORD", subjectId: `${subject}@${e.document_id}`,
        related: [{ documentId: e.document_id, version: e.version }], message: `${subject}의 권리자 ${holder}가 근거 문서 "${e.title}"의 당사자가 아니다`, hint: "올바른 문서를 근거로 연결하거나 기록의 권리자를 고친다" });
    }
    if (e.status === "REJECTED") {
      out.push({ rule: "DOC_DOCUMENT_REJECTED", severity: "BLOCK", subjectType: "RECORD", subjectId: `${subject}@${e.document_id}`,
        related: [{ documentId: e.document_id, version: e.version }], message: `${subject}가 거부된 문서 "${e.title}" v${e.version}을 근거로 삼고 있다`, hint: "올바른 문서 버전을 근거로 다시 연결한다" });
    }
    const newest = latest.get(e.document_id);
    if (newest !== undefined && newest.version > e.version) {
      out.push({ rule: "DOC_NEWER_VERSION", severity: "WARN", subjectType: "RECORD", subjectId: `${subject}@${e.document_id}`,
        related: [{ documentId: e.document_id, version: e.version }, { documentId: e.document_id, version: newest.version }],
        message: `${subject}가 근거 문서 "${e.title}"의 v${e.version}을 가리키는데 v${newest.version}(개정·해지)이 올라왔다`, hint: "새 버전의 내용을 확인하고 기록의 근거를 새 버전으로 바꾼다(내용이 바뀌었으면 기록도 고친다)" });
    }
    // 효력 종료: 인용한 버전과 최신 버전 중 이른 쪽(해지는 최신 버전의 종료일로 들어온다).
    const ends = [e.effective_to, newest?.effective_to].filter((x) => x !== null && x !== undefined).map((x) => iso(x)!).sort();
    if (ends.length > 0) {
      const end = ends[0]!;
      if (end <= now) {
        out.push({ rule: "DOC_PERIOD_EXPIRED", severity: "BLOCK", subjectType: "DOCUMENT", subjectId: `${e.document_id}@${e.version}`,
          related: [{ type: e.record_type, id: e.record_id }], message: `근거 문서 "${e.title}"의 효력이 ${end.slice(0, 10)}에 끝났다`, hint: "갱신 계약을 새 버전으로 올리고 근거를 바꾼다" });
      } else if (Date.parse(end) - Date.parse(now) <= SOON_DAYS * DAY) {
        out.push({ rule: "DOC_PERIOD_EXPIRING", severity: "WARN", subjectType: "DOCUMENT", subjectId: `${e.document_id}@${e.version}`, dueAt: end,
          related: [{ type: e.record_type, id: e.record_id }], message: `근거 문서 "${e.title}"의 효력이 ${end.slice(0, 10)}에 끝난다`, hint: "당사자에게 갱신을 요청한다" });
      }
    }
  }
  // 4. 이용허락 동의(D7): 녹음·작품·쓰이는 보이스마다 지금 유효한 동의.
  const consents = await q(
    "SELECT consent_id, right_type, asset_id, valid_to FROM consent_agreement WHERE facts_scope_id = $1 AND revoked_at IS NULL AND valid_from <= $2 AND valid_to > $2", [scopeId, now]);
  const voices = await q("SELECT v.voice_id, v.kind FROM voice v WHERE v.facts_scope_id = $1 AND EXISTS (SELECT 1 FROM right_claim c WHERE c.source_id = v.voice_id AND c.edge = 'OWNED_BY' AND c.superseded_at IS NULL)", [scopeId]);
  const recordings = [...new Set(claims.filter((c) => c.edge === "CONTROLLED_BY").map((c) => c.source_id as string))];
  const works = [...new Set(claims.filter((c) => c.edge === "WRITTEN_BY").map((c) => c.source_id as string))];
  const need: [string, string, string][] = [
    ...recordings.map((r): [string, string, string] => ["MASTER", r, `녹음 ${r}`]), ...works.map((w): [string, string, string] => ["WORK", w, `작품 ${w}`]),
    ...voices.map((v): [string, string, string] => ["PERFORMER", v.voice_id, `보이스 ${v.voice_id}`]),
  ];
  for (const [type, asset, label] of need) {
    const ok = consents.filter((c) => c.right_type === type && c.asset_id === asset);
    if (ok.length === 0) {
      out.push({ rule: "DOC_CONSENT_MISSING", severity: "BLOCK", subjectType: "CONSENT", subjectId: `${type}:${asset}`, message: `${label}에 지금 유효한 이용허락 동의가 없다`, hint: type === "PERFORMER" ? "실연자에게 실연자 앱에서 동의를 요청한다" : "계약서로 동의를 기록한다" });
    } else {
      const last = ok.map((c) => iso(c.valid_to)!).sort().at(-1)!;
      if (Date.parse(last) - Date.parse(now) <= SOON_DAYS * DAY) {
        out.push({ rule: "DOC_CONSENT_EXPIRING", severity: "WARN", subjectType: "CONSENT", subjectId: `${type}:${asset}`, dueAt: last, message: `${label}의 동의가 ${last.slice(0, 10)}에 끝난다`, hint: "동의 갱신을 요청한다" });
      }
    }
  }
  // 5. 마스터 권리자의 플랫폼 계약(D7 공통)과 AI 보이스의 생성·이용 동의서(D7 AI 보이스).
  const docs = await q("SELECT document_id, version, kind, parties FROM source_document WHERE status <> 'REJECTED' AND disposed_at IS NULL AND (effective_to IS NULL OR effective_to > $1)", [now]);
  const hasDoc = (kind: string, party: string) => docs.some((d) => d.kind === kind && d.parties.includes(party));
  for (const p of [...new Set(claims.filter((c) => c.edge === "CONTROLLED_BY").map((c) => c.target_id as string))]) {
    if (!hasDoc("PLATFORM_CONTRACT", p)) out.push({ rule: "DOC_PLATFORM_CONTRACT_MISSING", severity: "BLOCK", subjectType: "PARTY", subjectId: p, message: `마스터 권리자 ${p}의 플랫폼 계약 문서가 없다`, hint: "플랫폼 계약서를 올린다(당사자에 그 권리자를 넣는다)" });
  }
  for (const v of voices.filter((x) => x.kind === "AI")) {
    const owners = claims.filter((c) => c.edge === "OWNED_BY" && c.source_id === v.voice_id).map((c) => c.target_id as string);
    if (!owners.some((o) => hasDoc("PERFORMER_CONSENT", o))) {
      out.push({ rule: "DOC_AI_CONSENT_MISSING", severity: "BLOCK", subjectType: "VOICE", subjectId: v.voice_id, message: `AI 보이스 ${v.voice_id}에 원래 목소리 주인의 생성·이용 동의서가 없다`, hint: "실연 동의서(AI 생성·이용 조항 포함)를 올린다" });
    }
  }
  // 6. 확인 대기와 지급 정보(WARN): 정산은 맞지만 운영 위험.
  for (const r of await q("SELECT request_id, record_type, record_id, counterparty_id, due_at FROM confirmation_request WHERE facts_scope_id = $1 AND status = 'OPEN'", [scopeId])) {
    out.push({ rule: "DOC_CONFIRMATION_PENDING", severity: "WARN", subjectType: "RECORD", subjectId: rec(r.record_type, r.record_id), dueAt: iso(r.due_at)!,
      related: [{ requestId: Number(r.request_id) }], message: `${rec(r.record_type, r.record_id)}가 ${r.counterparty_id}의 확인을 기다린다`, hint: "상대 당사자에게 확인을 독촉하거나, 플랫폼 밖이면 기한 뒤 원문 대조로 확인한다" });
  }
  // 실연 몫 전부를 확정된 위임(VERIFIED, 합 100%)으로 넘긴 실연자는 직접 받지 않는다(예: 소속사가 멤버 몫을 받는다) — 지급 정보가 필요 없다.
  const performerOnly = (p: string) => claims.every((c) => c.target_id !== p || c.edge === "OWNED_BY");
  const mandatedAway = (p: string) => mandates.filter((m) => m.from_party_id === p && m.right_kind === "PERFORMER" && m.status === "VERIFIED")
    .reduce((sum, m) => sum + Number(m.share_bps), 0) >= 10000;
  const payees = [...new Set([...claims.filter((c) => c.edge !== "PERFORMED_BY").map((c) => c.target_id as string), ...mandates.map((m) => m.to_party_id as string)])]
    .filter((p) => !(performerOnly(p) && mandatedAway(p)));
  const profiled = new Set((await q("SELECT party_id FROM party_payout_profile WHERE party_id = ANY($1)", [payees])).map((r) => r.party_id as string));
  for (const p of payees.filter((x) => !profiled.has(x))) {
    out.push({ rule: "DOC_PAYOUT_PROFILE_MISSING", severity: "WARN", subjectType: "PARTY", subjectId: p, message: `권리자 ${p}의 지급 정보(계좌·세무 유형)가 없다`, hint: "지급 프로필을 등록하게 한다(없으면 지급이 보류된다)" });
  }
  return out.sort((a, b) => (a.rule + a.subjectId < b.rule + b.subjectId ? -1 : 1));
}

function toIssue(r: any) {
  return {
    issueId: Number(r.issue_id), rule: r.rule_code as string, severity: r.severity as Severity, scopeId: r.facts_scope_id as string,
    subjectType: r.subject_type as SubjectType, subjectId: r.subject_id as string, related: r.related as unknown[], message: r.message as string, hint: r.fix_hint as string,
    status: r.status as string, openedAt: iso(r.opened_at)!, checkedAt: iso(r.checked_at)!, dueAt: iso(r.due_at), closedAt: iso(r.closed_at),
    ...(r.accept_requested_by !== null && { acceptRequestedBy: r.accept_requested_by as string, acceptReason: r.accept_reason as string }),
    ...(r.accepted_by !== null && { acceptedBy: r.accepted_by as string, acceptUntil: iso(r.accept_until)! }),
    acceptCount: r.accept_count as number, ...(r.dismissed_by !== null && { dismissedBy: r.dismissed_by as string, dismissReason: r.dismiss_reason as string }),
  };
}

/**
 * 재검사(원천 문서 설계 6.4): 위반을 이슈로 맞춘다. 새 위반은 OPEN, 그대로면 갱신, 사라지면 시스템이 RESOLVED로 닫는다.
 * WARN이 기한을 넘기거나 위험 수용 기한이 끝나면 BLOCK으로 오른다. 컴플라이언스가 오탐으로 닫은 이슈는 내용이 같으면 다시 열지 않는다.
 */
export async function revalidate(tx: Tx, clock: Clock, scopeId: string) {
  return withSystemScope(tx, async () => {
    const scope = (await tx.query("SELECT s.owner_tenant_id, t.validation_enforced FROM facts_scope s JOIN tenant t ON t.tenant_id = s.owner_tenant_id WHERE s.facts_scope_id = $1", [scopeId])).rows[0];
    if (scope === undefined) throw notFound("facts scope", scopeId);
    const now = clock.now();
    const found = await checkScope(tx, scopeId, now);
    const live = (await tx.query("SELECT * FROM validation_issue WHERE facts_scope_id = $1 AND status IN ('OPEN','ACCEPTED')", [scopeId])).rows;
    const dismissed = (await tx.query("SELECT rule_code, subject_type, subject_id, message FROM validation_issue WHERE facts_scope_id = $1 AND status = 'DISMISSED'", [scopeId])).rows;
    const key = (r: string, t: string, s: string) => `${r}|${t}|${s}`;
    const seen = new Set<string>();
    for (const v of found) {
      const k = key(v.rule, v.subjectType, v.subjectId);
      seen.add(k);
      const cur = live.find((l) => key(l.rule_code, l.subject_type, l.subject_id) === k);
      if (cur === undefined) {
        if (dismissed.some((d) => key(d.rule_code, d.subject_type, d.subject_id) === k && d.message === v.message)) continue;
        const due = v.severity === "WARN" ? (v.dueAt ?? new Date(Date.parse(now) + WARN_DAYS * DAY).toISOString()) : null;
        await tx.query(
          `INSERT INTO validation_issue (rule_code, severity, facts_scope_id, subject_type, subject_id, related, message, fix_hint, due_at, opened_at, checked_at, owner_tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
          [v.rule, v.severity, scopeId, v.subjectType, v.subjectId, JSON.stringify(v.related ?? []), v.message, v.hint, due, now, scope.owner_tenant_id]);
        continue;
      }
      let severity: Severity = v.severity;
      let status = cur.status as string;
      const due = iso(cur.due_at) ?? v.dueAt ?? null;
      if (v.severity === "WARN") {
        if (status === "ACCEPTED" && iso(cur.accept_until)! <= now) { status = "OPEN"; severity = "BLOCK"; }
        else if (status === "OPEN" && due !== null && due <= now) severity = "BLOCK";
        else if (cur.severity === "BLOCK" && status === "OPEN") severity = "BLOCK"; // 한 번 오른 등급은 고칠 때까지 유지
      }
      await tx.query("UPDATE validation_issue SET severity = $2, status = $3, related = $4, message = $5, fix_hint = $6, due_at = $7, checked_at = $8 WHERE issue_id = $1",
        [cur.issue_id, severity, status, JSON.stringify(v.related ?? []), v.message, v.hint, due, now]);
    }
    for (const l of live.filter((x) => !seen.has(key(x.rule_code, x.subject_type, x.subject_id)))) {
      await tx.query("UPDATE validation_issue SET status = 'RESOLVED', closed_at = $2, checked_at = $2 WHERE issue_id = $1", [l.issue_id, now]);
    }
    await tx.query(
      `INSERT INTO validation_check (facts_scope_id, checked_at, owner_tenant_id) VALUES ($1,$2,$3)
       ON CONFLICT (facts_scope_id) DO UPDATE SET checked_at = EXCLUDED.checked_at`, [scopeId, now, scope.owner_tenant_id]);
    const issues = (await tx.query("SELECT * FROM validation_issue WHERE facts_scope_id = $1 AND (status IN ('OPEN','ACCEPTED') OR closed_at >= $2) ORDER BY status, severity, rule_code, subject_id",
      [scopeId, new Date(Date.parse(now) - 30 * DAY).toISOString()])).rows.map(toIssue);
    const open = issues.filter((i) => i.status === "OPEN");
    return {
      scopeId, enforced: scope.validation_enforced as boolean, checkedAt: now,
      counts: { block: open.filter((i) => i.severity === "BLOCK").length, warn: open.filter((i) => i.severity === "WARN").length, accepted: issues.filter((i) => i.status === "ACCEPTED").length },
      issues,
    };
  });
}

/**
 * 활성화 차단(원천 문서 설계 6.2): 정책·팩 활성화 전에 다시 검사하고, 적용 테넌트의 곡에 열린 BLOCK 이슈가 있으면 거부한다.
 * 적용하지 않는 테넌트(플랫폼 대행 곡 기본값)는 이슈만 남긴다.
 */
export async function assertActivationAllowed(tx: Tx, clock: Clock, scopeId: string): Promise<void> {
  const r = await revalidate(tx, clock, scopeId);
  const blocking = r.issues.filter((i) => i.status === "OPEN" && i.severity === "BLOCK");
  if (r.enforced && blocking.length > 0) {
    throw invalid("VALIDATION_BLOCKED", `${scopeId} has ${blocking.length} blocking validation issue(s)`,
      blocking.map((i) => ({ code: i.rule, path: `$.validation.${i.subjectType}.${i.subjectId}`, message: i.message })));
  }
}

export async function listIssues(tx: Tx, f: { status?: string; severity?: string; scope?: string }) {
  return (await tx.query(
    `SELECT * FROM validation_issue WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR severity = $2) AND ($3::text IS NULL OR facts_scope_id = $3)
      ORDER BY CASE severity WHEN 'BLOCK' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, due_at NULLS LAST, issue_id`, [f.status ?? null, f.severity ?? null, f.scope ?? null])).rows.map(toIssue);
}

async function liveIssue(tx: Tx, id: number) {
  const r = (await withSystemScope(tx, async () => (await tx.query("SELECT * FROM validation_issue WHERE issue_id = $1 FOR UPDATE", [id])).rows[0]));
  if (r === undefined) throw notFound("validation issue", String(id));
  return r;
}
const reasonOf = (v: unknown) => { if (typeof v !== "string" || v.trim() === "") throw new DomainError("BAD_REQUEST", 400, "reason is required"); return v.trim(); };

/** 위험 수용 요청(운영, D8): WARN만, 연장 포함 두 번까지. */
export async function requestAcceptance(tx: Tx, clock: Clock, actor: Actor, id: number, reason: unknown) {
  requireRole(actor, "SPACE_OPS");
  const why = reasonOf(reason);
  const r = await liveIssue(tx, id);
  if (r.severity !== "WARN") throw conflict("NOT_ACCEPTABLE", `only WARN issues can be accepted; issue ${id} is ${r.severity}`);
  if (r.status !== "OPEN" && !(r.status === "ACCEPTED" && r.accept_count < 2)) throw conflict("NOT_ACCEPTABLE", `issue ${id} is ${r.status}`);
  if (r.accept_count >= 2) throw conflict("ACCEPT_LIMIT", `issue ${id} was already accepted and extended once`);
  await withSystemScope(tx, () => tx.query("UPDATE validation_issue SET accept_requested_by = $2, accept_reason = $3, accepted_by = NULL WHERE issue_id = $1", [id, actor.userId, why]));
  await audit(tx, clock, { actor: actor.userId, action: "VALIDATION_ACCEPT_REQUESTED", entityType: "validation_issue", entityId: String(id), after: { reason: why } });
  return toIssue((await withSystemScope(tx, async () => (await tx.query("SELECT * FROM validation_issue WHERE issue_id = $1", [id])).rows[0])));
}

/** 위험 수용 승인(컴플라이언스, 요청자 ≠ 승인자): 최대 30일. */
export async function acceptIssue(tx: Tx, clock: Clock, actor: Actor, id: number) {
  requireRole(actor, "COMPLIANCE");
  const r = await liveIssue(tx, id);
  if (r.accept_requested_by === null) throw conflict("NOT_REQUESTED", `issue ${id} has no acceptance request`);
  if (r.accept_requested_by === actor.userId) throw new DomainError("SOD_VIOLATION", 403, "the requester cannot approve the acceptance");
  if (r.severity !== "WARN") throw conflict("NOT_ACCEPTABLE", `issue ${id} is ${r.severity}`);
  const until = new Date(Date.parse(clock.now()) + ACCEPT_DAYS * DAY).toISOString();
  await withSystemScope(tx, () => tx.query("UPDATE validation_issue SET status = 'ACCEPTED', accepted_by = $2, accept_until = $3, accept_count = accept_count + 1 WHERE issue_id = $1", [id, actor.userId, until]));
  await audit(tx, clock, { actor: actor.userId, action: "VALIDATION_ACCEPTED", entityType: "validation_issue", entityId: String(id), after: { until } });
  return toIssue((await withSystemScope(tx, async () => (await tx.query("SELECT * FROM validation_issue WHERE issue_id = $1", [id])).rows[0])));
}

/** 오탐 표시(컴플라이언스, 사유 필수). 내용이 같은 위반은 다시 열지 않는다. */
export async function dismissIssue(tx: Tx, clock: Clock, actor: Actor, id: number, reason: unknown) {
  requireRole(actor, "COMPLIANCE");
  const why = reasonOf(reason);
  const r = await liveIssue(tx, id);
  if (r.status !== "OPEN" && r.status !== "ACCEPTED") throw conflict("ISSUE_CLOSED", `issue ${id} is ${r.status}`);
  await withSystemScope(tx, () => tx.query("UPDATE validation_issue SET status = 'DISMISSED', closed_at = $2, dismissed_by = $3, dismiss_reason = $4 WHERE issue_id = $1", [id, clock.now(), actor.userId, why]));
  await audit(tx, clock, { actor: actor.userId, action: "VALIDATION_DISMISSED", entityType: "validation_issue", entityId: String(id), after: { reason: why } });
  return toIssue((await withSystemScope(tx, async () => (await tx.query("SELECT * FROM validation_issue WHERE issue_id = $1", [id])).rows[0])));
}

/** 적용 범위 설정(운영): 테넌트의 BLOCK 이슈가 활성화를 막을지. */
export async function setEnforcement(tx: Tx, clock: Clock, actor: Actor, tenantId: string, enforced: unknown) {
  requireRole(actor, "SPACE_OPS");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators change validation enforcement");
  if (typeof enforced !== "boolean") throw new DomainError("BAD_REQUEST", 400, "enforced must be true or false");
  const r = await tx.query("UPDATE tenant SET validation_enforced = $2 WHERE tenant_id = $1", [tenantId, enforced]);
  if (r.rowCount === 0) throw notFound("tenant", tenantId);
  await audit(tx, clock, { actor: actor.userId, action: "VALIDATION_ENFORCEMENT", entityType: "tenant", entityId: tenantId, after: { enforced } });
  return { tenantId, enforced };
}

/**
 * 문서가 닿는 곡(원천 문서 설계 S3b): 그 문서(어느 버전이든)를 근거로 삼는 현재 기록·동의의 곡, 그리고 문서 당사자가
 * 권리자·위임 당사자로 나오는 곡(플랫폼 계약·AI 동의처럼 당사자 단위로 보는 규칙). 시스템 범위에서 찾는다.
 */
export async function scopesTouchedByDocument(tx: Tx, documentId: string): Promise<string[]> {
  return withSystemScope(tx, async () => (await tx.query(
    `WITH doc AS (SELECT DISTINCT unnest(parties) AS party FROM source_document WHERE document_id = $1)
     SELECT c.facts_scope_id FROM record_evidence e JOIN right_claim c ON e.record_type = 'CLAIM' AND c.claim_id = e.record_id AND c.version = e.record_version
      WHERE e.document_id = $1 AND c.superseded_at IS NULL
     UNION SELECT m.facts_scope_id FROM record_evidence e JOIN mandate m ON e.record_type = 'MANDATE' AND m.mandate_id = e.record_id AND m.version = e.record_version
      WHERE e.document_id = $1 AND m.superseded_at IS NULL
     UNION SELECT facts_scope_id FROM consent_agreement WHERE source_document_id = $1
     UNION SELECT facts_scope_id FROM right_claim WHERE superseded_at IS NULL AND (target_id IN (SELECT party FROM doc) OR source_id IN (SELECT party FROM doc))
     UNION SELECT facts_scope_id FROM mandate WHERE superseded_at IS NULL AND (from_party_id IN (SELECT party FROM doc) OR to_party_id IN (SELECT party FROM doc))
     ORDER BY 1`, [documentId])).rows.map((r) => r.facts_scope_id as string));
}

/** 문서가 바뀐 뒤(새 문서·개정·거부·폐기) 그 문서가 닿는 곡을 모두 다시 검사한다. 다시 검사한 곡 id를 돌려준다. */
export async function revalidateForDocument(tx: Tx, clock: Clock, documentId: string): Promise<string[]> {
  const scopes = await scopesTouchedByDocument(tx, documentId);
  for (const s of scopes) await revalidate(tx, clock, s);
  return scopes;
}

/** 정기 검사에서 다시 볼 곡: 검사한 지 하루가 지났거나 검사한 적이 없는 곡, 마지막 검사 뒤 기한·수용 만료가 지난 곡, 마지막 검사 뒤 근거 문서·동의의 효력이 끝났거나 만료 임박 구간(30일)에 새로 들어온 곡. */
export const SWEEP_STALE_HOURS = 24;

export async function dueForSweep(tx: Tx, now: string, limit: number): Promise<string[]> {
  return withSystemScope(tx, async () => (await tx.query(
    `WITH last AS (SELECT s.facts_scope_id, k.checked_at FROM facts_scope s LEFT JOIN validation_check k ON k.facts_scope_id = s.facts_scope_id)
     SELECT facts_scope_id FROM last l WHERE
       l.checked_at IS NULL OR l.checked_at <= $1::timestamptz - make_interval(hours => $2)
       OR EXISTS (SELECT 1 FROM validation_issue i WHERE i.facts_scope_id = l.facts_scope_id
                   AND ((i.status = 'OPEN' AND i.severity = 'WARN' AND i.due_at <= $1) OR (i.status = 'ACCEPTED' AND i.accept_until <= $1)))
       OR EXISTS (SELECT 1 FROM record_evidence e JOIN source_document d ON d.document_id = e.document_id
                   JOIN right_claim c ON e.record_type = 'CLAIM' AND c.claim_id = e.record_id AND c.version = e.record_version AND c.superseded_at IS NULL
                  WHERE c.facts_scope_id = l.facts_scope_id AND ((d.effective_to > l.checked_at + make_interval(days => $3) AND d.effective_to <= $1::timestamptz + make_interval(days => $3)) OR (d.effective_to > l.checked_at AND d.effective_to <= $1)))
       OR EXISTS (SELECT 1 FROM record_evidence e JOIN source_document d ON d.document_id = e.document_id
                   JOIN mandate m ON e.record_type = 'MANDATE' AND m.mandate_id = e.record_id AND m.version = e.record_version AND m.superseded_at IS NULL
                  WHERE m.facts_scope_id = l.facts_scope_id AND ((d.effective_to > l.checked_at + make_interval(days => $3) AND d.effective_to <= $1::timestamptz + make_interval(days => $3)) OR (d.effective_to > l.checked_at AND d.effective_to <= $1)))
       OR EXISTS (SELECT 1 FROM consent_agreement a WHERE a.facts_scope_id = l.facts_scope_id AND a.revoked_at IS NULL
                   AND ((a.valid_to > l.checked_at + make_interval(days => $3) AND a.valid_to <= $1::timestamptz + make_interval(days => $3)) OR (a.valid_to > l.checked_at AND a.valid_to <= $1)))
     ORDER BY l.checked_at NULLS FIRST, facts_scope_id LIMIT $4`, [now, SWEEP_STALE_HOURS, SOON_DAYS, limit])).rows.map((r) => r.facts_scope_id as string));
}

/** 정기 검사(원천 문서 설계 S3b): 다시 볼 곡을 골라 검사한다. 곡마다 따로 검사하므로 한 곡의 실패가 다른 곡을 막지 않게 호출자가 트랜잭션을 나눌 수 있다. */
export async function sweepValidation(tx: Tx, clock: Clock, limit = 200): Promise<{ checked: string[] }> {
  const scopes = await dueForSweep(tx, clock.now(), limit);
  for (const s of scopes) await revalidate(tx, clock, s);
  return { checked: scopes };
}

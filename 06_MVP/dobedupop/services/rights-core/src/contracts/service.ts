import { createHash } from "node:crypto";
import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { storeGeneratedDocument, type DocumentKind, type DocumentRef } from "../documents/service.ts";
import type { DocumentStore } from "../documents/store.ts";
import { signConsent, type RightType } from "../registry/consents.ts";
import { recordClaim, recordMandate } from "../registry/service.ts";
import { PERSON_PARTY_TYPES } from "../registry/confirmations.ts";
import { isIdentityVerified } from "../performer/identity.ts";
import { revalidate } from "../validation/service.ts";
import type { SignatureProvider } from "./esign.ts";
import { hasPermission, requirePermission } from "../platform/permissions.ts";
import { sodEnabled } from "../platform/sod.ts";

/**
 * 최초 작성(원천 문서 설계 S4, 결정 D6): 표준 계약 템플릿 → 마법사 답 → 사람이 읽는 계약서 → 전자서명 → 서명본 원천 문서 + 기록.
 * 조항과 값이 템플릿에서 이미 대응되므로 추출이 필요 없고, 모든 당사자가 서명했으므로 만들어지는 기록은 바로 VERIFIED다(D5의 두 번째 길).
 */
export type VarType = "party" | "recording" | "voice" | "date" | "multi" | "bps" | "text" | "shares";
export type TemplateVar = { name: string; label: string; type: VarType; options?: [string, string][]; optional?: boolean };
export type TemplateClause = { clauseId: string; heading: string; clauseType: string; fields: string[]; text: string };
export type RecordKind = "CONSENT_MASTER" | "CONSENT_WORK" | "CONSENT_PERFORMER" | "MANDATE_PERFORMER" | "CLAIM_CONFIRM" | "NONE";
export type Template = {
  templateId: string; version: number; kind: DocumentKind; recordKind: RecordKind; title: string; variables: TemplateVar[]; clauses: TemplateClause[];
  signerVars: string[]; status: string; seeded: boolean; authoredBy?: string; approvedBy?: string; createdAt: string; approvedAt?: string;
};
/** 권리 확인서 작가 지분 표(shares 변수) 한 줄. */
export type Share = { partyId: string; shareBps: number; roleDetail: string | null };
type Answers = Record<string, string | string[] | number | Share[]>;
export type PlannedRecord =
  | { type: "CONSENT"; consentId: string; partyId: string; rightType: RightType; assetId: string; scope: { actions: string[]; territories: string[]; media: string[]; audience: string[] }; validFrom: string; validTo: string }
  | { type: "MANDATE"; mandateId: string; fromPartyId: string; toPartyId: string; rightKind: "PERFORMER"; shareBps: number; validFrom: string; validTo: string }
  /** 권리 확인서(CLAIM_CONFIRM, 결정 CT5): 권리 주장을 VERIFIED로 만든다. 같은 주장(곡·근원·관계·대상)이 있으면 그 주장의 새 버전이다. */
  | { type: "CLAIM"; edge: "WRITTEN_BY" | "CONTROLLED_BY"; sourceId: string; targetId: string; shareBps: number; roleDetail: string | null; validFrom: string };

const ID = /^[A-Za-z0-9._-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** 템플릿이 아닌 곡에서 채우는 값. */
const AUTO_VARS = ["work"];
const bad = (m: string) => invalid("INVALID_CONTRACT", m);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function toTemplate(r: any): Template {
  return {
    templateId: r.template_id, version: r.version, kind: r.kind, recordKind: r.record_kind, title: r.title, variables: r.variables, clauses: r.clauses,
    signerVars: r.signer_vars, status: r.status, seeded: r.seeded, ...(r.authored_by && { authoredBy: r.authored_by }), ...(r.approved_by && { approvedBy: r.approved_by }),
    createdAt: iso(r.created_at)!, ...(r.approved_at && { approvedAt: iso(r.approved_at)! }),
  };
}

export async function listTemplates(tx: Tx): Promise<Template[]> {
  return (await tx.query("SELECT * FROM contract_template ORDER BY template_id, version DESC")).rows.map(toTemplate);
}

/** 버전을 주지 않으면 쓸 수 있는(승인된) 최신 버전. */
export async function getTemplate(tx: Tx, templateId: string, version?: number): Promise<Template> {
  const r = version === undefined
    ? (await tx.query("SELECT * FROM contract_template WHERE template_id = $1 AND status = 'APPROVED' ORDER BY version DESC LIMIT 1", [templateId])).rows[0]
    : (await tx.query("SELECT * FROM contract_template WHERE template_id = $1 AND version = $2", [templateId, version])).rows[0];
  if (r === undefined) throw notFound("contract template", version === undefined ? templateId : `${templateId}@${version}`);
  return toTemplate(r);
}

function requireLegal(actor: Actor): void {
  requirePermission(actor, "legal.template");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform legal staff manage contract templates");
}

function checkTemplateBody(vars: TemplateVar[], clauses: TemplateClause[], signerVars: string[]): void {
  const names = new Set([...vars.map((v) => v.name), ...AUTO_VARS]);
  for (const c of clauses) {
    if (typeof c.clauseId !== "string" || typeof c.heading !== "string" || typeof c.text !== "string" || !Array.isArray(c.fields)) throw bad("each clause needs clauseId, heading, text, fields");
    for (const m of c.text.matchAll(/\{\{(\w+)\}\}/g)) if (!names.has(m[1]!)) throw bad(`clause ${c.clauseId} uses unknown variable ${m[1]}`);
    for (const f of c.fields) if (!names.has(f)) throw bad(`clause ${c.clauseId} maps unknown field ${f}`);
  }
  for (const s of signerVars) if (!["party", "shares"].includes(vars.find((v) => v.name === s)?.type ?? "")) throw bad(`signer ${s} must be a party or shares variable`);
}

/** 법무 작성: 최신 버전을 바탕으로 조항·제목을 고친 새 버전(DRAFT). 변수와 기록 대응은 바꾸지 않는다(필드 대응이 기록 생성의 근거다). */
export async function authorTemplateVersion(tx: Tx, clock: Clock, actor: Actor, templateId: string, body: { title?: unknown; clauses?: unknown }): Promise<Template> {
  requireLegal(actor);
  const base = toTemplate((await tx.query("SELECT * FROM contract_template WHERE template_id = $1 ORDER BY version DESC LIMIT 1", [templateId])).rows[0] ?? (() => { throw notFound("contract template", templateId); })());
  const title = body.title === undefined ? base.title : body.title;
  if (typeof title !== "string" || title.trim() === "") throw bad("title must be text");
  const clauses = (body.clauses ?? base.clauses) as TemplateClause[];
  if (!Array.isArray(clauses) || clauses.length === 0) throw bad("clauses must be a non-empty list");
  checkTemplateBody(base.variables, clauses, base.signerVars);
  const version = base.version + 1;
  await tx.query(
    `INSERT INTO contract_template (template_id, version, kind, record_kind, title, variables, clauses, signer_vars, status, authored_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10)`,
    [templateId, version, base.kind, base.recordKind, title.trim(), JSON.stringify(base.variables), JSON.stringify(clauses), base.signerVars, actor.userId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "TEMPLATE_AUTHORED", entityType: "contract_template", entityId: `${templateId}@${version}` });
  return getTemplate(tx, templateId, version);
}

/** 법무 승인: 작성자가 아닌 법무가 한다. 승인하면 이전 승인 버전은 RETIRED(이미 서명된 계약은 그 버전에 고정되어 그대로다). */
export async function approveTemplateVersion(tx: Tx, clock: Clock, actor: Actor, templateId: string, version: number): Promise<Template> {
  requireLegal(actor);
  const t = await getTemplate(tx, templateId, version);
  if (t.status !== "DRAFT") throw conflict("TEMPLATE_NOT_DRAFT", `${templateId}@${version} is ${t.status}`);
  if (t.authoredBy === actor.userId && (await sodEnabled(tx, "contract-template.author-approve"))) throw new DomainError("SAME_PERSON", 403, "the author cannot approve their own template version");
  await tx.query("UPDATE contract_template SET status = 'RETIRED' WHERE template_id = $1 AND status = 'APPROVED'", [templateId]);
  await tx.query("UPDATE contract_template SET status = 'APPROVED', approved_by = $3, approved_at = $4 WHERE template_id = $1 AND version = $2", [templateId, version, actor.userId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "TEMPLATE_APPROVED", entityType: "contract_template", entityId: `${templateId}@${version}` });
  return getTemplate(tx, templateId, version);
}

/** 답 검사: 변수 형식과 참조(파티 존재, 녹음은 곡의 녹음, 보이스는 곡의 보이스). 날짜는 UTC 0시로 바꾼다. */
const ROLE_DETAIL: Record<string, string> = { LYRICS_COMPOSITION: "작사·작곡", LYRICS: "작사", COMPOSITION: "작곡", ARRANGEMENT: "편곡" };
/**
 * 계정 없는 당사자: 연결된 계정이 없다. 관리 테넌트가 보낸 계약을 전자서명 공급자 링크(이메일)로 본인이 서명한다(결정 WD2).
 * 값은 당사자 → 관리 테넌트 이름(시안 "작가 본인(빅히트 관리)").
 */
export async function noAccountParties(tx: Tx, parties: string[]): Promise<Map<string, string>> {
  const rows = await withSystemScope(tx, async () => (await tx.query(
    `SELECT p.party_id, t.name FROM party p JOIN tenant t ON t.tenant_id = p.tenant_id
      WHERE p.party_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM user_account u WHERE u.party_id = p.party_id)`, [parties])).rows);
  return new Map(rows.map((r) => [r.party_id as string, r.name as string]));
}

async function parseAnswers(tx: Tx, t: Template, scopeId: string, raw: unknown): Promise<{ answers: Answers; labels: Record<string, string>; html: Record<string, string> }> {
  if (raw === null || typeof raw !== "object") throw bad("answers must be an object");
  const a = raw as Record<string, unknown>;
  const scope = await withSystemScope(tx, async () => (await tx.query("SELECT work_id FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0]);
  if (scope === undefined) throw notFound("facts scope", scopeId);
  const answers: Answers = { work: scope.work_id };
  const labels: Record<string, string> = { work: scope.work_id };
  const html: Record<string, string> = {};
  for (const v of t.variables) {
    const x = a[v.name];
    if (x === undefined || x === "" || (Array.isArray(x) && x.length === 0)) {
      if (v.optional) continue;
      throw bad(`${v.label}(${v.name}) is required`);
    }
    if (v.type === "party" || v.type === "recording" || v.type === "voice") {
      if (typeof x !== "string" || !ID.test(x)) throw bad(`${v.name} must be an id`);
      const [sql, params] = v.type === "party" ? ["SELECT display_name AS label FROM party WHERE party_id = $1", [x]]
        : v.type === "recording" ? ["SELECT version_title AS label FROM recording_version WHERE recording_id = $1 AND work_id = $2", [x, scope.work_id]]
          : ["SELECT voice_id AS label FROM voice WHERE voice_id = $1 AND facts_scope_id = $2", [x, scopeId]];
      const row = await withSystemScope(tx, async () => (await tx.query(sql as string, params as unknown[])).rows[0]);
      if (row === undefined) throw bad(`${v.name}: ${x} is not a known ${v.type}${v.type === "party" ? "" : ` of ${scopeId}`}`);
      answers[v.name] = x;
      labels[v.name] = v.type === "party" ? `${row.label}(${x})` : row.label === x ? x : `${x} "${row.label}"`;
    } else if (v.type === "date") {
      // 마법사는 날짜(UTC 0시), 앱 동의는 서명 시각부터라 시각(ms UTC ISO)도 받는다.
      const instant = typeof x === "string" && INSTANT.test(x) && new Date(x).toISOString() === x;
      if (typeof x !== "string" || (!instant && (!DATE.test(x) || Number.isNaN(Date.parse(`${x}T00:00:00.000Z`))))) throw bad(`${v.name} must be YYYY-MM-DD`);
      answers[v.name] = instant ? x : `${x}T00:00:00.000Z`;
      labels[v.name] = `${x.slice(0, 4)}년 ${Number(x.slice(5, 7))}월 ${Number(x.slice(8, 10))}일`;
    } else if (v.type === "text") {
      if (typeof x !== "string" || x.trim() === "" || x.length > 400) throw bad(`${v.name} must be text (1..400)`);
      answers[v.name] = x.trim();
      labels[v.name] = x.trim();
    } else if (v.type === "shares") {
      // 작가 지분 표: 당사자마다 bps, 합은 100%(10000)여야 한다. 작가끼리 맞물리므로 한 부로 서명한다(결정 CT5).
      if (!Array.isArray(x) || x.length === 0) throw bad(`${v.name} must be a non-empty list of shares`);
      const rows: Share[] = x.map((r, i) => {
        const y = r as Record<string, unknown>;
        if (typeof y.partyId !== "string" || !ID.test(y.partyId)) throw bad(`${v.name}[${i}].partyId must be an id`);
        if (typeof y.shareBps !== "number" || !Number.isInteger(y.shareBps) || y.shareBps < 1 || y.shareBps > 10000) throw bad(`${v.name}[${i}].shareBps must be basis points 1..10000`);
        if (y.roleDetail !== undefined && y.roleDetail !== null && typeof y.roleDetail !== "string") throw bad(`${v.name}[${i}].roleDetail must be text`);
        return { partyId: y.partyId, shareBps: y.shareBps, roleDetail: (y.roleDetail as string | null | undefined) ?? null };
      });
      if (new Set(rows.map((r) => r.partyId)).size !== rows.length) throw bad(`${v.name} lists a party twice`);
      const sum = rows.reduce((a, r) => a + r.shareBps, 0);
      if (sum !== 10000) throw invalid("SHARES_NOT_100", `${v.label} must add up to 100% (now ${sum / 100}%)`);
      const names = await withSystemScope(tx, async () => (await tx.query("SELECT party_id, display_name FROM party WHERE party_id = ANY($1)", [rows.map((r) => r.partyId)])).rows);
      for (const r of rows) if (!names.some((n) => n.party_id === r.partyId)) throw bad(`${v.name}: ${r.partyId} is not a known party`);
      const managed = await noAccountParties(tx, rows.map((r) => r.partyId));
      const name = (p: string) => names.find((n) => n.party_id === p)!.display_name as string;
      answers[v.name] = rows;
      labels[v.name] = rows.map((r) => `${name(r.partyId)} ${(r.shareBps / 100).toFixed(2)}%`).join(", ");
      const td = (c: string, mono = false) => `<td${mono ? ' class="mono"' : ""}>${esc(c)}</td>`;
      html[v.name] = `<table><thead><tr><th>작가</th><th>역할</th><th>지분</th><th>수령</th></tr></thead><tbody>${rows.map((r) =>
        `<tr>${td(name(r.partyId))}${td(ROLE_DETAIL[r.roleDetail ?? ""] ?? r.roleDetail ?? "—")}${td(`${(r.shareBps / 100).toFixed(2)}%`, true)}${td(managed.has(r.partyId) ? `작가 본인(${managed.get(r.partyId)!.replace(/\s*—.*$/, "")} 관리)` : "본인")}</tr>`).join("")}</tbody></table>`;
    } else if (v.type === "multi") {
      const allowed = (v.options ?? []).map((o) => o[0]);
      if (!Array.isArray(x) || !x.every((y) => typeof y === "string" && allowed.includes(y))) throw bad(`${v.name} must be a subset of ${allowed.join(", ")}`);
      const picked = allowed.filter((o) => (x as string[]).includes(o));
      answers[v.name] = picked;
      labels[v.name] = picked.map((o) => v.options!.find((p) => p[0] === o)![1]).join("·");
    } else {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 10000) throw bad(`${v.name} must be basis points 1..10000`);
      answers[v.name] = x;
      labels[v.name] = `${(x / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
    }
  }
  if (typeof answers.validFrom === "string" && typeof answers.validTo === "string" && answers.validTo <= answers.validFrom) throw bad("validTo must be after validFrom");
  return { answers, labels, html };
}

function render(t: Template, contractId: string, scopeId: string, labels: Record<string, string>, html: Record<string, string> = {}): string {
  const fill = (s: string) => esc(s).replace(/\{\{(\w+)\}\}/g, (_, n: string) => html[n] ?? `<strong>${esc(labels[n] ?? "—")}</strong>`);
  const body = t.clauses.map((c, i) => `<section data-clause="${esc(c.clauseId)}" data-clause-type="${esc(c.clauseType)}"><h2>제${i + 1}조 ${esc(c.heading)}</h2><p>${fill(c.text)}</p></section>`).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(t.title)}</title>`
    + `<style>body{font-family:sans-serif;max-width:720px;margin:2rem auto;line-height:1.7;color:#222}h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.4rem}.meta{color:#666;font-size:.85rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.3rem .5rem;text-align:left;font-size:.85rem}.certificate{margin-top:2rem;border-top:2px solid #333}</style></head>`
    + `<body><h1>${esc(t.title)}</h1><p class="meta">계약 ${esc(contractId)} · 곡 ${esc(scopeId)} · 템플릿 ${esc(t.templateId)}@${t.version}</p>\n${body}\n</body></html>`;
}

function plan(t: Template, contractId: string, a: Answers): PlannedRecord[] {
  const usage = { actions: a.actions as string[], territories: a.territories as string[], media: a.media as string[], audience: a.audience as string[] };
  const period = { validFrom: a.validFrom as string, validTo: a.validTo as string };
  switch (t.recordKind) {
    case "CONSENT_MASTER": return [{ type: "CONSENT", consentId: `cns_${contractId}`, partyId: a.licensor as string, rightType: "MASTER", assetId: a.recording as string, scope: usage, ...period }];
    case "CONSENT_WORK": return [{ type: "CONSENT", consentId: `cns_${contractId}`, partyId: a.licensor as string, rightType: "WORK", assetId: a.work as string, scope: usage, ...period }];
    case "CONSENT_PERFORMER": return [{ type: "CONSENT", consentId: `cns_${contractId}`, partyId: a.performer as string, rightType: "PERFORMER", assetId: a.voice as string, scope: usage, ...period }];
    case "MANDATE_PERFORMER": return [{ type: "MANDATE", mandateId: `mnd_${contractId}`, fromPartyId: a.performer as string, toPartyId: a.agency as string, rightKind: "PERFORMER", shareBps: a.shareBps as number, ...period }];
    case "CLAIM_CONFIRM": {
      // 레이블용: 마스터 보유(CONTROLLED_BY 100%). 작가용: 작가 지분(WRITTEN_BY) 전부 + 작가마다 작품 이용 동의.
      if (t.kind === "MASTER_CONTRACT") return [{ type: "CLAIM", edge: "CONTROLLED_BY", sourceId: a.recording as string, targetId: a.holder as string, shareBps: 10000, roleDetail: null, validFrom: a.validFrom as string }];
      const shares = a.authors as Share[];
      return [
        ...shares.map((s): PlannedRecord => ({ type: "CLAIM", edge: "WRITTEN_BY", sourceId: a.work as string, targetId: s.partyId, shareBps: s.shareBps, roleDetail: s.roleDetail, validFrom: a.validFrom as string })),
        ...shares.map((s, i): PlannedRecord => ({ type: "CONSENT", consentId: `cns_${contractId}_${i + 1}`, partyId: s.partyId, rightType: "WORK", assetId: a.work as string, scope: usage, ...period })),
      ];
    }
    default: return [];
  }
}

/** 권리 확인서의 근거: 불러온 원본 계약서와, 사람이 확인한 후보 값의 조항(당사자별). */
async function importEvidence(tx: Tx, importId: string | undefined): Promise<{ original: DocumentRef | null; clauses: { partyId: string | null; clauseId: string }[] }> {
  if (importId === undefined) return { original: null, clauses: [] };
  return withSystemScope(tx, async () => {
    const imp = (await tx.query("SELECT document_id, document_version FROM contract_import WHERE import_id = $1", [importId])).rows[0];
    if (imp === undefined) return { original: null, clauses: [] };
    const vals = (await tx.query(
      "SELECT DISTINCT ON (key) key, value, clause_ref FROM import_value WHERE import_id = $1 ORDER BY key, seq DESC", [importId])).rows;
    return {
      original: { documentId: imp.document_id as string, version: imp.document_version as number },
      clauses: vals.filter((v) => v.clause_ref !== null).map((v) => ({ partyId: (v.value?.partyId as string | undefined) ?? null, clauseId: v.clause_ref as string })),
    };
  });
}

/** 권리 확인서 주장의 대상: 이 곡에 같은 관계로 확인서에 없는 당사자의 현재 주장이 있으면 합계가 어긋나므로 거부한다. */
async function claimTarget(tx: Tx, scopeId: string, r: Extract<PlannedRecord, { type: "CLAIM" }>, listed: string[]): Promise<{ claimId: string; version: number } | null> {
  return withSystemScope(tx, async () => {
    const cur = (await tx.query(
      "SELECT claim_id, version, target_id FROM right_claim WHERE facts_scope_id = $1 AND source_id = $2 AND edge = $3 AND superseded_at IS NULL AND status <> 'SUPERSEDED' ORDER BY claim_id",
      [scopeId, r.sourceId, r.edge])).rows;
    const others = cur.filter((c) => !listed.includes(c.target_id as string));
    if (others.length > 0) throw conflict("CLAIM_CONFIRM_OTHERS", `${r.sourceId} has ${r.edge} claims for parties not in this confirmation: ${others.map((c) => c.target_id).join(", ")}`);
    const mine = cur.find((c) => c.target_id === r.targetId);
    return mine === undefined ? null : { claimId: mine.claim_id as string, version: mine.version as number };
  });
}

async function apply(tx: Tx, clock: Clock, actor: Actor, scopeId: string, records: PlannedRecord[], doc: DocumentRef | null, importId?: string): Promise<{ type: string; id: string; version?: number }[]> {
  const out: { type: string; id: string; version?: number }[] = [];
  const ev = doc === null ? { original: null, clauses: [] } : await importEvidence(tx, importId);
  for (const r of records) {
    if (r.type === "CLAIM") {
      const listed = records.filter((x): x is Extract<PlannedRecord, { type: "CLAIM" }> => x.type === "CLAIM" && x.edge === r.edge && x.sourceId === r.sourceId).map((x) => x.targetId);
      const cur = await claimTarget(tx, scopeId, r, listed);
      const claimId = cur?.claimId ?? `c_${r.edge === "WRITTEN_BY" ? "work" : "master"}_${r.targetId.replace(/^pty_/, "")}_${scopeId.replace(/^fsc_/, "")}`;
      // 근거 = 확인서 서명본 + 원본 계약서(확인서는 원본을 대체하지 않는다, 결정 CT3). 같은 주장이 ASSERTED였으면 새 버전이 되고 열린 확인 요청은 닫힌다.
      const evidence = doc === null ? [] : [doc, ...(ev.original === null ? [] : [ev.original])];
      const rec = await withSystemScope(tx, () => recordClaim(tx, clock, {
        claimId, factsScopeId: scopeId, sourceId: r.sourceId, edge: r.edge, targetId: r.targetId, shareBps: r.shareBps, ...(r.roleDetail !== null && { roleDetail: r.roleDetail }),
        status: "VERIFIED", validFrom: r.validFrom, ...(evidence.length > 0 && { evidenceDocuments: evidence, linkedBy: actor.userId }),
      }, cur === null ? {} : { expectedVersion: cur.version }));
      for (const c of ev.clauses.filter((x) => x.partyId === r.targetId)) {
        await withSystemScope(tx, () => tx.query(
          "INSERT INTO record_clause (record_type, record_id, record_version, clause_id, linked_by, linked_at) VALUES ('CLAIM',$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [claimId, rec.version, c.clauseId, actor.userId, clock.now()]));
      }
      out.push({ type: "CLAIM", id: claimId, version: rec.version });
    } else if (r.type === "CONSENT") {
      const { type: _t, ...c } = r;
      const sign = () => signConsent(tx, clock, actor, { ...c, factsScopeId: scopeId, ...(doc === null ? { sourceContractUri: "contract:dry-run" } : { sourceDocument: doc }) }, { signedContract: true });
      await sign();
      out.push({ type: "CONSENT", id: r.consentId });
    } else {
      const { type: _t, ...m } = r;
      await recordMandate(tx, clock, { ...m, factsScopeId: scopeId, status: "VERIFIED", ...(doc !== null && { evidenceDocuments: [doc], linkedBy: actor.userId }) });
      out.push({ type: "MANDATE", id: r.mandateId });
    }
  }
  return out;
}

/** 계약 작성·반영은 권리를 가진 쪽(contract.draft)만 한다. 플랫폼 운영은 계약을 맺지 않는다(결정 WD1). */
function requireDrafter(actor: Actor): void {
  requirePermission(actor, "contract.draft");
}

async function prepare(tx: Tx, b: { contractId?: unknown; templateId?: unknown; templateVersion?: unknown; factsScopeId?: unknown; answers?: unknown }) {
  const contractId = b.contractId ?? "preview";
  if (typeof contractId !== "string" || !ID.test(contractId)) throw bad("contractId must be an id");
  if (typeof b.templateId !== "string") throw bad("templateId is required");
  if (typeof b.factsScopeId !== "string") throw bad("factsScopeId is required");
  // 요청자에게 보이는 곡이어야 한다(RLS).
  if ((await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [b.factsScopeId])).rowCount === 0) throw notFound("facts scope", b.factsScopeId);
  const t = await getTemplate(tx, b.templateId, b.templateVersion === undefined ? undefined : Number(b.templateVersion));
  if (t.status !== "APPROVED") throw conflict("TEMPLATE_NOT_APPROVED", `${t.templateId}@${t.version} is ${t.status}`);
  const { answers, labels, html: raw } = await parseAnswers(tx, t, b.factsScopeId, b.answers);
  const html = render(t, contractId, b.factsScopeId, labels, raw);
  const signers = signerParties(t, answers);
  return { contractId, t, scopeId: b.factsScopeId, answers, labels, html, signers, records: plan(t, contractId, answers) };
}

/** 서명 당사자: 당사자 변수는 그 당사자, 지분 표 변수는 표의 당사자 전원. */
function signerParties(t: Template, a: Answers): string[] {
  return [...new Set(t.signerVars.flatMap((v) => (Array.isArray(a[v]) && typeof (a[v] as unknown[])[0] === "object" ? (a[v] as Share[]).map((s) => s.partyId) : [a[v] as string])))];
}

/** 미리보기: 계약서 문안과 서명하면 만들어질 기록을 보여 준다. 저장하지 않는다. */
export async function previewContract(tx: Tx, actor: Actor, b: Record<string, unknown>) {
  requireDrafter(actor);
  const p = await prepare(tx, b);
  return { html: p.html, signers: p.signers, records: p.records, labels: p.labels, template: { templateId: p.t.templateId, version: p.t.version, title: p.t.title, clauses: p.t.clauses } };
}

/**
 * 서명 요청: 계약서를 만들어 해시를 고정하고 공급자에게 보낸다. 서명 뒤 기록을 만들 수 있는지 미리 시험한다(세이브포인트에서 만들어 보고 되돌린다).
 */
export async function createContract(tx: Tx, clock: Clock, actor: Actor, provider: SignatureProvider, b: Record<string, unknown>) {
  requireDrafter(actor);
  if (b.contractId === undefined) throw bad("contractId is required");
  const p = await prepare(tx, b);
  if ((await withSystemScope(tx, async () => (await tx.query("SELECT 1 FROM contract_envelope WHERE contract_id = $1", [p.contractId])).rowCount)) !== 0) {
    throw conflict("CONTRACT_EXISTS", `contract ${p.contractId} exists`);
  }
  await tx.query("SAVEPOINT contract_dry_run");
  try {
    await apply(tx, clock, actor, p.scopeId, p.records, null);
  } finally {
    await tx.query("ROLLBACK TO SAVEPOINT contract_dry_run");
  }
  const sha256 = createHash("sha256").update(p.html).digest("hex");
  const names = await withSystemScope(tx, async () => (await tx.query("SELECT party_id, display_name FROM party WHERE party_id = ANY($1)", [p.signers])).rows);
  const sent = await provider.send({ contractId: p.contractId, title: p.t.title, sha256, signers: p.signers.map((s) => ({ partyId: s, displayName: names.find((n) => n.party_id === s)?.display_name ?? s })) });
  await tx.query(
    `INSERT INTO contract_envelope (contract_id, template_id, template_version, facts_scope_id, answers, title, rendered_html, rendered_sha256, provider, provider_ref, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [p.contractId, p.t.templateId, p.t.version, p.scopeId, JSON.stringify(p.answers), p.t.title, p.html, sha256, provider.name, sent.providerRef, actor.userId, clock.now()]);
  await withSystemScope(tx, async () => {
    for (const v of p.t.signerVars) {
      const parties = Array.isArray(p.answers[v]) ? (p.answers[v] as Share[]).map((s) => s.partyId) : [p.answers[v] as string];
      for (const party of parties) {
        await tx.query("INSERT INTO contract_signature (contract_id, party_id, signer_var, owner_tenant_id) SELECT contract_id, $2, $3, owner_tenant_id FROM contract_envelope WHERE contract_id = $1 ON CONFLICT DO NOTHING",
          [p.contractId, party, v]);
      }
    }
  });
  await audit(tx, clock, { actor: actor.userId, action: "CONTRACT_SENT", entityType: "contract_envelope", entityId: p.contractId, after: { template: `${p.t.templateId}@${p.t.version}`, sha256, signers: p.signers } });
  return getContract(tx, p.contractId);
}

export async function getContract(tx: Tx, contractId: string) {
  const e = (await tx.query("SELECT * FROM contract_envelope WHERE contract_id = $1", [contractId])).rows[0];
  if (e === undefined) throw notFound("contract", contractId);
  const sigs = (await tx.query(
    "SELECT s.*, p.display_name FROM contract_signature s JOIN party p ON p.party_id = s.party_id WHERE s.contract_id = $1 ORDER BY s.signer_var", [contractId])).rows;
  return {
    contractId, templateId: e.template_id as string, templateVersion: e.template_version as number, factsScopeId: e.facts_scope_id as string, title: e.title as string,
    answers: e.answers as Answers, html: e.rendered_html as string, sha256: e.rendered_sha256 as string, status: e.status as string, provider: e.provider as string,
    ownerTenantId: e.owner_tenant_id as string, createdBy: e.created_by as string, createdAt: iso(e.created_at)!,
    ...(e.document_id !== null && { document: { documentId: e.document_id as string, version: e.document_version as number } }),
    records: e.records as { type: string; id: string }[], ...(e.completed_at !== null && { completedAt: iso(e.completed_at)! }),
    signatures: sigs.map((s) => ({ partyId: s.party_id as string, displayName: s.display_name as string, signerVar: s.signer_var as string,
      ...(s.signed_at !== null && { signedAt: iso(s.signed_at)!, method: s.method as string }), ...(s.signed_by !== null && { signedBy: s.signed_by as string }) })),
  };
}

export async function listContracts(tx: Tx, f: { scope?: string; status?: string }) {
  const read = async () => {
    const ids = (await tx.query(
      "SELECT contract_id FROM contract_envelope WHERE ($1::text IS NULL OR facts_scope_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, contract_id",
      [f.scope ?? null, f.status ?? null])).rows.map((r) => r.contract_id as string);
    const out = [];
    for (const id of ids) { const { html: _h, ...c } = await getContract(tx, id); out.push(c); }
    return out;
  };
  // 곡을 지정하고 그 곡이 요청자에게 보이면(RLS) 그 곡의 계약은 다 보인다 — 플랫폼이 위탁 작가와 맺은 작품 이용허락도(곡 워크스페이스 문서·계약, 조회만).
  if (f.scope !== undefined && (await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [f.scope])).rows.length > 0) return withSystemScope(tx, read);
  return read();
}

async function markSigned(tx: Tx, clock: Clock, contractId: string, partyId: string, method: string, by: string | null): Promise<void> {
  await withSystemScope(tx, async () => {
    const e = (await tx.query("SELECT status FROM contract_envelope WHERE contract_id = $1 FOR UPDATE", [contractId])).rows[0];
    if (e === undefined) throw notFound("contract", contractId);
    if (e.status !== "SENT") throw conflict("CONTRACT_NOT_OPEN", `contract ${contractId} is ${e.status}`);
    const r = await tx.query("UPDATE contract_signature SET signed_at = $3, signed_by = $4, method = $5 WHERE contract_id = $1 AND party_id = $2 AND signed_at IS NULL RETURNING 1",
      [contractId, partyId, clock.now(), by, method]);
    if (r.rowCount === 0) throw conflict("NOT_A_PENDING_SIGNER", `${partyId} has no pending signature on ${contractId}`);
    const left = (await tx.query("SELECT count(*)::int AS n FROM contract_signature WHERE contract_id = $1 AND signed_at IS NULL", [contractId])).rows[0].n as number;
    if (left === 0) await tx.query("UPDATE contract_envelope SET status = 'SIGNED' WHERE contract_id = $1", [contractId]);
  });
  await audit(tx, clock, { actor: by ?? "sys_esign", action: "CONTRACT_SIGNED", entityType: "contract_envelope", entityId: contractId, after: { partyId, method } });
}

/**
 * 당사자 서명(플랫폼 사용자): 실연자는 본인 파티(본인 인증 필수), 권리자는 그 파티가 속한 테넌트의 contract.sign_org 권한자가 서명한다.
 * 공급자가 본인 확인을 맡는 운영 환경에서는 공급자 화면에서 서명하고 통지(providerSigned)로 들어온다.
 */
export async function signContract(tx: Tx, clock: Clock, actor: Actor, provider: SignatureProvider, contractId: string, partyId?: unknown) {
  const pending = (await tx.query("SELECT party_id FROM contract_signature WHERE contract_id = $1 AND signed_at IS NULL", [contractId])).rows.map((r) => r.party_id as string);
  let mine: string[];
  if (actor.partyId !== undefined && hasPermission(actor, "performer.self")) {
    mine = pending.filter((p) => p === actor.partyId);
    if (mine.length > 0 && !(await isIdentityVerified(tx, actor.userId))) throw new DomainError("IDENTITY_REQUIRED", 403, `${actor.userId} must complete identity verification before signing`);
  } else {
    requirePermission(actor, "contract.sign_org");
    // 기관 서명: 그 테넌트의 기관 당사자만. 사람 당사자(작가 등)는 관리 테넌트가 대신 서명하지 못한다 — 본인 계정이나 전자서명 링크로(결정 WD2).
    const owned = (await withSystemScope(tx, async () => (await tx.query(
      "SELECT party_id FROM party WHERE party_id = ANY($1) AND tenant_id = $2 AND party_type <> ALL($3)", [pending, actor.tenantId, [...PERSON_PARTY_TYPES]])).rows))
      .map((r) => r.party_id as string);
    mine = pending.filter((p) => owned.includes(p));
  }
  if (partyId !== undefined) mine = mine.filter((p) => p === partyId);
  if (mine.length === 0) throw new DomainError("NOT_A_SIGNER", 403, `${actor.userId} cannot sign ${contractId} for any pending party`);
  for (const p of mine) await markSigned(tx, clock, contractId, p, provider.name, actor.userId);
  return getContract(tx, contractId);
}

/** 공급자 통지: 플랫폼 밖 당사자(예: 해외 작가)가 공급자 화면에서 서명했다. 개발용 공급자는 개발 도구가 이 통지를 흉내 낸다. */
export async function providerSigned(tx: Tx, clock: Clock, provider: SignatureProvider, contractId: string, partyId: string): Promise<void> {
  await markSigned(tx, clock, contractId, partyId, provider.name, null);
}

/**
 * 기록 반영: 모두 서명한 계약을 만든 테넌트가 반영한다. 공급자에게 서명본을 받아 원천 문서(TEMPLATE_SIGNED)로 남기고,
 * 마법사 답대로 동의·위임 기록을 만든다(근거 = 서명본). 그 뒤 곡을 다시 검사한다.
 */
export async function completeContract(tx: Tx, clock: Clock, actor: Actor, store: DocumentStore, provider: SignatureProvider, contractId: string) {
  requireDrafter(actor);
  const c = await getContract(tx, contractId);
  if (c.ownerTenantId !== actor.tenantId) throw new DomainError("NOT_OWNER", 403, `${contractId} belongs to ${c.ownerTenantId}`);
  if (c.status !== "SIGNED") throw conflict("CONTRACT_NOT_SIGNED", `contract ${contractId} is ${c.status}`);
  const t = await getTemplate(tx, c.templateId, c.templateVersion);
  const ref = await withSystemScope(tx, async () => (await tx.query("SELECT provider_ref FROM contract_envelope WHERE contract_id = $1", [contractId])).rows[0].provider_ref as string);
  const signed = await provider.finalize({
    contractId, providerRef: ref, html: c.html, sha256: c.sha256,
    signatures: c.signatures.map((s) => ({ partyId: s.partyId, displayName: s.displayName, signedAt: s.signedAt!, method: s.method!, ...(s.signedBy && { signedBy: s.signedBy }) })),
  });
  const doc = await storeGeneratedDocument(tx, clock, store, {
    owner: c.ownerTenantId, documentId: `doc_${contractId}`, kind: t.kind, title: `${t.title} (${contractId})`, parties: c.signatures.map((s) => s.partyId),
    effectiveFrom: typeof c.answers.validFrom === "string" ? c.answers.validFrom : null, effectiveTo: typeof c.answers.validTo === "string" ? c.answers.validTo : null,
    html: signed.html, by: actor.userId,
  });
  const importId = typeof c.answers.importId === "string" ? c.answers.importId : undefined;
  const records = await apply(tx, clock, actor, c.factsScopeId, plan(t, contractId, c.answers), doc, importId);
  if (importId !== undefined) await withSystemScope(tx, () => tx.query("UPDATE contract_import SET step = 'DONE' WHERE import_id = $1 AND step <> 'DONE'", [importId]));
  await withSystemScope(tx, () => tx.query(
    "UPDATE contract_envelope SET status = 'COMPLETED', document_id = $2, document_version = $3, records = $4, completed_by = $5, completed_at = $6 WHERE contract_id = $1",
    [contractId, doc.documentId, doc.version, JSON.stringify(records), actor.userId, clock.now()]));
  await audit(tx, clock, { actor: actor.userId, action: "CONTRACT_COMPLETED", entityType: "contract_envelope", entityId: contractId, after: { document: doc, records } });
  await revalidate(tx, clock, c.factsScopeId);
  return getContract(tx, contractId);
}

export async function cancelContract(tx: Tx, clock: Clock, actor: Actor, contractId: string) {
  requireDrafter(actor);
  const c = await getContract(tx, contractId);
  if (c.ownerTenantId !== actor.tenantId) throw new DomainError("NOT_OWNER", 403, `${contractId} belongs to ${c.ownerTenantId}`);
  if (c.status !== "SENT" && c.status !== "SIGNED") throw conflict("CONTRACT_NOT_OPEN", `contract ${contractId} is ${c.status}`);
  await withSystemScope(tx, () => tx.query("UPDATE contract_envelope SET status = 'CANCELLED' WHERE contract_id = $1", [contractId]));
  await audit(tx, clock, { actor: actor.userId, action: "CONTRACT_CANCELLED", entityType: "contract_envelope", entityId: contractId });
  return getContract(tx, contractId);
}

/**
 * 실연자 앱 동의서 원문(원천 문서 설계 S4): 실연자가 앱에서 동의하면 실연 이용 동의서 템플릿으로 원문을 만들고 자체 서명 기록
 * (본인 인증을 마친 계정·서명 시각·기기·원문 해시)을 붙여 원천 문서로 남긴다. 외부 공급자를 쓸지는 D1 사업자를 정할 때 함께 정한다.
 */
export async function performerConsentOriginal(
  tx: Tx, clock: Clock, store: DocumentStore, actor: Actor,
  d: { consentId: string; factsScopeId: string; assetId: string; scope: { actions: string[]; territories: string[]; media: string[]; audience: string[] }; validFrom: string; validTo: string },
  device: string,
): Promise<DocumentRef> {
  if (actor.partyId === undefined) throw new DomainError("NOT_SELF", 403, `${actor.userId} has no party`);
  const t = await getTemplate(tx, "tpl_performer_consent");
  const { labels } = await parseAnswers(tx, t, d.factsScopeId, { performer: actor.partyId, voice: d.assetId, ...d.scope, validFrom: d.validFrom, validTo: d.validTo });
  const html = render(t, d.consentId, d.factsScopeId, labels);
  const sha256 = createHash("sha256").update(html).digest("hex");
  const signedAt = clock.now();
  const cert = `<section class="certificate"><h2>서명 기록(플랫폼 자체 서명)</h2><table><tbody>`
    + `<tr><th>서명자</th><td>${esc(labels.performer!)} · 계정 ${esc(actor.userId)}(본인 인증 완료)</td></tr><tr><th>서명 시각</th><td>${esc(signedAt)}</td></tr>`
    + `<tr><th>기기</th><td>${esc(device.slice(0, 200) || "알 수 없음")}</td></tr><tr><th>원문 SHA-256</th><td><code>${sha256}</code></td></tr></tbody></table></section>`;
  return storeGeneratedDocument(tx, clock, store, {
    owner: actor.tenantId, documentId: `doc_${d.consentId}`, kind: "PERFORMER_CONSENT", title: `${t.title} (${d.consentId})`, parties: [actor.partyId],
    effectiveFrom: d.validFrom, effectiveTo: d.validTo, html: html.replace("</body>", `${cert}</body>`), by: actor.userId,
  });
}

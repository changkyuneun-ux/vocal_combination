import { randomBytes } from "node:crypto";
import { addClause } from "../documents/service.ts";
import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { requirePermission } from "../platform/permissions.ts";
import { irGaps, type ImportFill, type IrGapRow } from "../registry/readiness.ts";
import type { SignatureProvider } from "./esign.ts";
import { applyFrame, getFrame, type Frame, type FrameField, type FrameValue } from "./frames.ts";
import { createContract, listContracts, noAccountParties, previewContract } from "./service.ts";

/**
 * 계약서 불러오기(3부-B, 결정 CT1~CT5): ① 원본 계약서(원천 문서)와 읽기 틀 → ② 후보 값(사람이 하나씩 확인) → ③ IR 정보 대조 →
 * ④ 빠진 것 입력 → ⑤ 권리 확인서(표준 계약) 서명. 계정 없는 작가는 빅히트가 보낸 전자서명 링크로 서명한다(결정 WD2). 원본은 플랫폼 밖으로 보내지 않는다. 값은 사람이 표시한 조항 인용 문장에서만 읽는다.
 */
export type Step = "VALUES" | "GAPS" | "READY" | "CONFIRM_SENT" | "DONE";
/** 빠진 것 입력의 어휘는 동의 기록과 같다(시안 Song-Import 2026-10-23 정정: 이용 행위·지역·매체·공개 대상). */
export const ACTIONS = [["PREVIEW", "미리듣기"], ["COMBINE", "조합 생성"], ["PERSONAL_HOLD", "개인 보관"], ["SHARE_LINK", "링크 공유"], ["DOWNLOAD", "내려받기"]] as const;
export const TERRITORIES = [["KR", "대한민국"], ["JP", "일본"], ["US", "미국"]] as const;
export const MEDIA = [["FAN_APP", "팬앱"], ["EXTERNAL_SNS", "외부 SNS"]] as const;
export const AUDIENCE = [["FAN_COMMUNITY", "팬 커뮤니티"], ["PUBLIC", "전체 공개"]] as const;
const GAP_SETS = { actions: ACTIONS, territories: TERRITORIES, media: MEDIA, audience: AUDIENCE } as const;
type GapKey = keyof typeof GAP_SETS;
const GAP_KEYS = Object.keys(GAP_SETS) as GapKey[];
const labelsOf = (k: GapKey, codes: string[]) => codes.map((c) => (GAP_SETS[k] as readonly (readonly [string, string])[]).find((x) => x[0] === c)![1]).join("·");
/** 시안의 이용 범위 → 동의 기록의 이용 행위·지역(팬앱 전용, 팬 커뮤니티 공개). */
const CLAUSE_TYPE: Record<string, string> = { WORK_TITLE: "OTHER", RECORDING: "OTHER", AUTHOR: "RIGHT_HOLDER", MASTER_OWNER: "RIGHT_HOLDER", AUTHOR_SHARE: "SHARE", EFFECTIVE_FROM: "PERIOD" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (m: string) => invalid("INVALID_IMPORT", m);

function requireDrafter(actor: Actor): void {
  requirePermission(actor, "contract.draft");
}

type ValueRow = { key: string; seq: number; value: FrameValue | null; page: number | null; clause: string | null; quote: string | null; clauseRef: string | null;
  origin: "FRAME" | "MANUAL"; compared: "SAME" | "NEW" | "DIFFERENT" | null; confirmedBy: string | null; confirmedAt: string | null };

async function latestValues(tx: Tx, importId: string): Promise<Map<string, ValueRow>> {
  const rows = (await tx.query("SELECT DISTINCT ON (key) * FROM import_value WHERE import_id = $1 ORDER BY key, seq DESC", [importId])).rows;
  return new Map(rows.map((r) => [r.key as string, {
    key: r.key, seq: r.seq, value: r.value, page: r.page, clause: r.clause, quote: r.quote, clauseRef: r.clause_ref, origin: r.origin, compared: r.compared,
    confirmedBy: r.confirmed_by, confirmedAt: iso(r.confirmed_at),
  } as ValueRow]));
}

async function insertValue(tx: Tx, importId: string, owner: string, v: Omit<ValueRow, "seq" | "confirmedAt"> & { confirmedAt: string | null }): Promise<void> {
  const seq = ((await tx.query("SELECT coalesce(max(seq), 0)::int AS s FROM import_value WHERE import_id = $1 AND key = $2", [importId, v.key])).rows[0].s as number) + 1;
  await tx.query(
    `INSERT INTO import_value (import_id, key, seq, value, page, clause, quote, clause_ref, origin, compared, confirmed_by, confirmed_at, owner_tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [importId, v.key, seq, v.value === null ? null : JSON.stringify(v.value), v.page, v.clause, v.quote, v.clauseRef, v.origin, v.compared, v.confirmedBy, v.confirmedAt, owner]);
}

/** 후보 값과 지금 기록(원곡 권리)의 비교: 같음 · 새 값(기록 없음) · 다름. */
async function compare(tx: Tx, scopeId: string, workId: string, f: FrameField, v: FrameValue | null): Promise<"SAME" | "NEW" | "DIFFERENT" | null> {
  if (v === null) return null;
  return withSystemScope(tx, async () => {
    const one = async (sql: string, p: unknown[]) => (await tx.query(sql, p)).rows[0];
    switch (f.irItem) {
      case "WORK_TITLE": return (await one("SELECT title FROM work WHERE work_id = $1", [workId]))?.title === (v as { text: string }).text ? "SAME" : "DIFFERENT";
      case "RECORDING": return (await one("SELECT 1 FROM recording_version WHERE work_id = $1 AND version_title = $2", [workId, (v as { text: string }).text])) ? "SAME" : "NEW";
      case "EFFECTIVE_FROM": return "NEW";
      case "AUTHOR": case "AUTHOR_SHARE": {
        const c = await one("SELECT share_bps FROM right_claim WHERE facts_scope_id = $1 AND source_id = $2 AND edge = 'WRITTEN_BY' AND target_id = $3 AND superseded_at IS NULL AND status <> 'SUPERSEDED'",
          [scopeId, workId, (v as { partyId: string }).partyId]);
        if (c === undefined) return "NEW";
        return f.irItem === "AUTHOR" || c.share_bps === (v as { shareBps: number }).shareBps ? "SAME" : "DIFFERENT";
      }
      case "MASTER_OWNER": {
        const cs = (await tx.query(
          "SELECT c.target_id FROM right_claim c JOIN recording_version r ON r.recording_id = c.source_id WHERE c.facts_scope_id = $1 AND r.work_id = $2 AND c.edge = 'CONTROLLED_BY' AND c.superseded_at IS NULL",
          [scopeId, workId])).rows;
        return cs.length === 0 ? "NEW" : cs.some((c) => c.target_id === (v as { partyId: string }).partyId) ? "SAME" : "DIFFERENT";
      }
    }
  });
}

/** 지금 기록의 값(다를 때 "기존 값을 쓴다"를 고르면 이 값으로 확인한다). */
async function currentValue(tx: Tx, scopeId: string, workId: string, f: FrameField, v: FrameValue | null): Promise<FrameValue | null> {
  return withSystemScope(tx, async () => {
    if (f.irItem === "WORK_TITLE") return { text: (await tx.query("SELECT title FROM work WHERE work_id = $1", [workId])).rows[0].title as string };
    if (f.irItem === "AUTHOR_SHARE" && v !== null && "partyId" in v) {
      const c = (await tx.query("SELECT share_bps, role_detail FROM right_claim WHERE facts_scope_id = $1 AND source_id = $2 AND edge = 'WRITTEN_BY' AND target_id = $3 AND superseded_at IS NULL",
        [scopeId, workId, v.partyId])).rows[0];
      return c === undefined ? null : { partyId: v.partyId, shareBps: c.share_bps as number, roleDetail: (c.role_detail as string | null) ?? ("roleDetail" in v ? v.roleDetail : null) };
    }
    if (f.irItem === "MASTER_OWNER") {
      const c = (await tx.query("SELECT c.target_id FROM right_claim c JOIN recording_version r ON r.recording_id = c.source_id WHERE c.facts_scope_id = $1 AND r.work_id = $2 AND c.edge = 'CONTROLLED_BY' AND c.superseded_at IS NULL LIMIT 1", [scopeId, workId])).rows[0];
      return c === undefined ? null : { partyId: c.target_id as string };
    }
    return null;
  });
}

async function loadImport(tx: Tx, importId: string) {
  const r = (await tx.query("SELECT * FROM contract_import WHERE import_id = $1", [importId])).rows[0];
  if (r === undefined) throw notFound("contract import", importId);
  const scope = await withSystemScope(tx, async () => (await tx.query("SELECT work_id FROM facts_scope WHERE facts_scope_id = $1", [r.facts_scope_id])).rows[0]);
  const doc = await withSystemScope(tx, async () => (await tx.query("SELECT * FROM source_document WHERE document_id = $1 AND version = $2", [r.document_id, r.document_version])).rows[0]);
  const frame = r.frame_id === null ? null : await withSystemScope(tx, () => getFrame(tx, r.frame_id, r.frame_version));
  return { r, workId: scope.work_id as string, doc, frame };
}

async function partiesOf(tx: Tx, ids: string[]): Promise<{ partyId: string; name: string }[]> {
  const rows = await withSystemScope(tx, async () => (await tx.query("SELECT party_id, display_name FROM party WHERE party_id = ANY($1)", [ids])).rows);
  return ids.map((id) => ({ partyId: id, name: (rows.find((x) => x.party_id === id)?.display_name as string | undefined) ?? id }));
}

/**
 * ① 불러오기 시작: 이 곡의 원천 문서(작품 퍼블리싱·녹음 계약서)와 읽기 틀(주지 않으면 같은 테넌트·같은 문서 종류의 승인된 틀).
 * 필드마다 인용 문장은 요청 본문(quotes)이나, 원천 문서에 사람이 이미 표시한 조항(같은 쪽, 값 모양이 맞는 것)에서 가져온다.
 */
export async function startImport(tx: Tx, clock: Clock, actor: Actor, scopeId: string, b: { documentId?: unknown; version?: unknown; frameId?: unknown; quotes?: unknown }) {
  requireDrafter(actor);
  if ((await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rowCount === 0) throw notFound("facts scope", scopeId);
  if (typeof b.documentId !== "string") throw bad("documentId is required");
  const doc = (await tx.query(
    "SELECT * FROM source_document WHERE document_id = $1 AND ($2::int IS NULL OR version = $2) ORDER BY version DESC LIMIT 1", [b.documentId, b.version ?? null])).rows[0];
  if (doc === undefined) throw notFound("document", b.documentId);
  if (doc.status === "REJECTED" || doc.disposed_at !== null) throw invalid("DOCUMENT_UNUSABLE", `${doc.document_id}@${doc.version} is not usable`);
  if (doc.kind !== "PUBLISHING" && doc.kind !== "MASTER_CONTRACT") throw invalid("DOCUMENT_KIND", `only publishing and master contracts are imported (got ${doc.kind})`);
  let frame: Frame | null = null;
  if (b.frameId !== undefined) {
    if (typeof b.frameId !== "string") throw bad("frameId must be an id");
    frame = await getFrame(tx, b.frameId);
  } else {
    const f = (await tx.query(
      "SELECT frame_id FROM contract_reading_frame WHERE status = 'APPROVED' AND document_kind = $1 AND owner_tenant_id = $2 ORDER BY approved_at DESC, frame_id LIMIT 1",
      [doc.kind, doc.owner_tenant_id])).rows[0];
    if (f !== undefined) frame = await getFrame(tx, f.frame_id as string);
  }
  if (frame !== null && frame.documentKind !== doc.kind) throw invalid("FRAME_KIND_MISMATCH", `${frame.frameId} reads ${frame.documentKind} contracts, not ${doc.kind}`);
  const quotes = (b.quotes ?? {}) as Record<string, unknown>;
  if (typeof quotes !== "object" || quotes === null || Object.values(quotes).some((q) => typeof q !== "string")) throw bad("quotes must map field keys to text");
  const workId = await withSystemScope(tx, async () => (await tx.query("SELECT work_id FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0].work_id as string);
  const importId = `imp_${randomBytes(6).toString("hex")}`;
  await tx.query(
    "INSERT INTO contract_import (import_id, facts_scope_id, document_id, document_version, frame_id, frame_version, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [importId, scopeId, doc.document_id, doc.version, frame?.frameId ?? null, frame?.version ?? null, actor.userId, clock.now()]);
  const owner = (await tx.query("SELECT owner_tenant_id FROM contract_import WHERE import_id = $1", [importId])).rows[0].owner_tenant_id as string;
  if (frame !== null) {
    const ctx = { parties: await partiesOf(tx, doc.parties as string[]) };
    const marked = (await tx.query("SELECT clause_id, page, quote FROM document_clause WHERE document_id = $1 AND document_version = $2 ORDER BY marked_at, clause_id",
      [doc.document_id, doc.version])).rows;
    for (const f of frame.fields) {
      let quote = quotes[f.key] as string | undefined;
      let clauseRef: string | null = null;
      if (quote === undefined) {
        const hit = marked.find((m) => m.page === f.page && applyFrame([f], { [f.key]: m.quote as string }, ctx)[0]!.value !== null);
        if (hit !== undefined) { quote = hit.quote as string; clauseRef = hit.clause_id as string; }
      }
      const value = applyFrame([f], { [f.key]: quote }, ctx)[0]!.value;
      await insertValue(tx, importId, owner, { key: f.key, value, page: f.page, clause: f.clause, quote: quote ?? null, clauseRef, origin: "FRAME",
        compared: await compare(tx, scopeId, workId, f, value), confirmedBy: null, confirmedAt: null });
    }
  }
  await audit(tx, clock, { actor: actor.userId, action: "CONTRACT_IMPORT_STARTED", entityType: "contract_import", entityId: importId, after: { document: `${doc.document_id}@${doc.version}`, frame: frame && `${frame.frameId}@${frame.version}` } });
  return getImport(tx, clock, importId);
}

function fillOf(kind: string, frame: Frame | null, vals: Map<string, ValueRow>, gaps: boolean): ImportFill {
  const ok = (f: FrameField) => vals.get(f.key)?.confirmedAt != null && vals.get(f.key)?.value != null;
  const fields = frame?.fields ?? [];
  const shares = fields.filter((f) => f.irItem === "AUTHOR_SHARE");
  return {
    kind: kind as ImportFill["kind"],
    title: fields.some((f) => f.irItem === "WORK_TITLE" && ok(f)),
    sharesBps: shares.length > 0 && shares.every(ok) ? shares.reduce((a, f) => a + (vals.get(f.key)!.value as { shareBps: number }).shareBps, 0) : null,
    masterOwner: fields.some((f) => f.irItem === "MASTER_OWNER" && ok(f)),
    gaps,
  };
}

/** 불러오기 화면 한 장: 문서·읽기 틀·후보 값(근거·비교·확인)·IR 정보 대조·빠진 것·단계. */
export async function getImport(tx: Tx, clock: Clock, importId: string) {
  const { r, workId, doc, frame } = await loadImport(tx, importId);
  const vals = await latestValues(tx, importId);
  const parties = await partiesOf(tx, doc.parties as string[]);
  const managed = await noAccountParties(tx, doc.parties as string[]);
  const g = (k: string) => vals.get(`gap.${k}`)?.value as unknown;
  const gaps = g("actions") === undefined ? null
    : { actions: g("actions") as string[], territories: g("territories") as string[], media: g("media") as string[], audience: g("audience") as string[], validTo: g("validTo") as string };
  const ir: IrGapRow[] = await irGaps(tx, r.facts_scope_id, clock.now(), fillOf(doc.kind, frame, vals, gaps !== null));
  const names = new Map(parties.map((p) => [p.partyId, p.name]));
  const fieldVals = (frame?.fields ?? []).map((f) => {
    const v = vals.get(f.key);
    const who = v?.value && "partyId" in v.value ? v.value.partyId : null;
    return { key: f.key, label: f.label, irItem: f.irItem, page: f.page, clause: f.clause, value: v?.value ?? null, partyName: who === null ? null : names.get(who) ?? who,
      quote: v?.quote ?? null, origin: v?.origin ?? "FRAME", compared: v?.compared ?? null, confirmed: v?.confirmedAt != null, confirmedBy: v?.confirmedBy ?? null };
  });
  return {
    importId, factsScopeId: r.facts_scope_id as string, workId, step: r.step as Step, contractId: r.contract_id as string | null, createdBy: r.created_by as string, createdAt: iso(r.created_at)!,
    document: { documentId: doc.document_id as string, version: doc.version as number, title: doc.title as string, kind: doc.kind as string, mime: doc.mime as string, sha256: doc.file_sha256 as string,
      uploadedAt: iso(doc.uploaded_at)!, effectiveFrom: iso(doc.effective_from) ?? null, effectiveTo: iso(doc.effective_to) ?? null,
      parties: parties.map((p) => ({ ...p, noAccount: managed.has(p.partyId), manager: managed.get(p.partyId) ?? null })) },
    frame: frame && { frameId: frame.frameId, version: frame.version, title: frame.title, pages: frame.pages, documentKind: frame.documentKind },
    values: fieldVals, gaps, ir, missing: ir.filter((x) => x.state === "MISSING").map((x) => `${x.group}: ${x.need}`),
  };
}

export async function listImports(tx: Tx, clock: Clock, scopeId: string) {
  const ids = (await tx.query("SELECT import_id FROM contract_import WHERE facts_scope_id = $1 ORDER BY created_at DESC, import_id", [scopeId])).rows.map((r) => r.import_id as string);
  const out = [];
  for (const id of ids) out.push(await getImport(tx, clock, id));
  return out;
}

function checkManual(f: FrameField, raw: unknown, parties: string[]): FrameValue {
  const v = raw as Record<string, unknown>;
  if (v === null || typeof v !== "object") throw bad("value must be an object");
  switch (f.irItem) {
    case "WORK_TITLE": case "RECORDING":
      if (typeof v.text !== "string" || v.text.trim() === "") throw bad("value.text is required");
      return { text: v.text.trim() };
    case "EFFECTIVE_FROM":
      if (typeof v.date !== "string" || !DATE.test(v.date)) throw bad("value.date must be YYYY-MM-DD");
      return { date: v.date };
    case "AUTHOR": case "MASTER_OWNER":
      if (typeof v.partyId !== "string" || !parties.includes(v.partyId)) throw bad("value.partyId must be a party of the document");
      return { partyId: v.partyId };
    case "AUTHOR_SHARE":
      if (typeof v.partyId !== "string" || !parties.includes(v.partyId)) throw bad("value.partyId must be a party of the document");
      if (typeof v.shareBps !== "number" || !Number.isInteger(v.shareBps) || v.shareBps < 1 || v.shareBps > 10000) throw bad("value.shareBps must be 1..10000");
      return { partyId: v.partyId, shareBps: v.shareBps, roleDetail: typeof v.roleDetail === "string" ? v.roleDetail : f.roleDetail ?? null };
  }
}

function locked(step: string, importId: string): void {
  if (step === "CONFIRM_SENT" || step === "DONE") throw conflict("IMPORT_LOCKED", `import ${importId} already sent its rights confirmation`);
}

/** 단계 다시 계산: 후보 값 모두 확인 → 빠진 것(GAPS), 빠진 것까지 채우고 대조에 빠짐이 없으면 READY. */
async function restep(tx: Tx, clock: Clock, importId: string): Promise<void> {
  const v = await getImport(tx, clock, importId);
  if (v.step === "CONFIRM_SENT" || v.step === "DONE") return;
  const confirmed = v.values.length > 0 && v.values.every((x) => x.confirmed);
  const step: Step = !confirmed ? "VALUES" : v.missing.length === 0 ? "READY" : "GAPS";
  if (step !== v.step) await tx.query("UPDATE contract_import SET step = $2 WHERE import_id = $1", [importId, step]);
}

/**
 * ② 후보 값 확인·고침: 인용 문장을 새로 주면 읽기 틀로 다시 읽고(조항을 원천 문서에 표시한다), 값을 직접 주면 사람이 입력한 값이다.
 * 기존 기록과 다르면(DIFFERENT) 어느 쪽을 쓸지(use: IMPORT | CURRENT) 골라야 확인된다. 행은 추가만 한다.
 */
export async function setValue(tx: Tx, clock: Clock, actor: Actor, importId: string, key: string, b: { value?: unknown; quote?: unknown; confirm?: unknown; use?: unknown }) {
  requireDrafter(actor);
  const { r, workId, doc, frame } = await loadImport(tx, importId);
  locked(r.step, importId);
  const f = frame?.fields.find((x) => x.key === key);
  if (f === undefined) throw notFound("import field", key);
  const cur = (await latestValues(tx, importId)).get(key);
  let value = cur?.value ?? null, quote = cur?.quote ?? null, clauseRef = cur?.clauseRef ?? null, origin = cur?.origin ?? "FRAME";
  if (b.quote !== undefined) {
    if (typeof b.quote !== "string" || b.quote.trim() === "") throw bad("quote must be the clause text");
    const parsed = applyFrame([f], { [key]: b.quote }, { parties: await partiesOf(tx, doc.parties as string[]) })[0]!;
    if (parsed.value === null) throw invalid("QUOTE_NOT_READ", `${f.label}: ${parsed.reason}`);
    const c = await addClause(tx, clock, actor, { documentId: doc.document_id, version: doc.version }, { page: f.page, quote: b.quote, clauseType: CLAUSE_TYPE[f.irItem], note: f.clause });
    value = parsed.value; quote = b.quote.trim(); clauseRef = c.clauseId; origin = "FRAME";
  } else if (b.value !== undefined) {
    value = checkManual(f, b.value, doc.parties as string[]); origin = "MANUAL";
  }
  let compared = await compare(tx, r.facts_scope_id, workId, f, value);
  if (b.use === "CURRENT") {
    const c = await currentValue(tx, r.facts_scope_id, workId, f, value);
    if (c === null) throw conflict("NO_CURRENT_VALUE", `${f.label} has no recorded value to use`);
    value = c; compared = "SAME"; origin = "MANUAL";
  } else if (b.use !== undefined && b.use !== "IMPORT") throw bad("use must be IMPORT or CURRENT");
  const confirm = b.confirm === true;
  if (confirm && value === null) throw invalid("VALUE_REQUIRED", `${f.label} has no value to confirm — give the clause quote or a value`);
  if (confirm && compared === "DIFFERENT" && b.use === undefined) throw conflict("CHOOSE_VALUE", `${f.label} differs from the recorded value; choose which to use (use: IMPORT | CURRENT)`);
  await insertValue(tx, importId, r.owner_tenant_id, { key, value, page: f.page, clause: f.clause, quote, clauseRef, origin, compared,
    confirmedBy: confirm ? actor.userId : null, confirmedAt: confirm ? clock.now() : null });
  await restep(tx, clock, importId);
  return getImport(tx, clock, importId);
}

/** ④ 빠진 것 입력: 원본 계약에 없는 이용 행위·지역·매체·공개 대상·기간 끝. 기간 끝은 원본 계약 기간을 넘지 않는다. */
export async function setGaps(tx: Tx, clock: Clock, actor: Actor, importId: string, b: Record<string, unknown>) {
  requireDrafter(actor);
  const v = await getImport(tx, clock, importId);
  locked(v.step, importId);
  if (v.document.kind !== "PUBLISHING") throw invalid("NO_GAPS", "only publishing contracts need the fan-app usage input");
  const picked: Record<string, string[]> = {};
  for (const k of GAP_KEYS) {
    const codes = GAP_SETS[k].map((x) => x[0] as string);
    const raw = b[k];
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((u) => typeof u === "string" && codes.includes(u))) throw bad(`${k} must be a non-empty subset of ${codes.join(", ")}`);
    picked[k] = codes.filter((c) => (raw as string[]).includes(c));
  }
  if (typeof b.validTo !== "string" || !DATE.test(b.validTo) || Number.isNaN(Date.parse(`${b.validTo}T00:00:00.000Z`))) throw bad("validTo must be YYYY-MM-DD");
  const from = effectiveFrom(v);
  if (from !== null && b.validTo <= from) throw bad("validTo must be after the effective date");
  if (v.document.effectiveTo !== null && `${b.validTo}T00:00:00.000Z` > v.document.effectiveTo) throw invalid("BEYOND_ORIGINAL", `validTo must not pass the original contract period (${v.document.effectiveTo.slice(0, 10)})`);
  const owner = (await tx.query("SELECT owner_tenant_id FROM contract_import WHERE import_id = $1", [importId])).rows[0].owner_tenant_id as string;
  for (const [k, val] of [...GAP_KEYS.map((k) => [k, picked[k]] as const), ["validTo", b.validTo] as const]) {
    await insertValue(tx, importId, owner, { key: `gap.${k}`, value: val as never, page: null, clause: null, quote: null, clauseRef: null, origin: "MANUAL", compared: null,
      confirmedBy: actor.userId, confirmedAt: clock.now() });
  }
  await restep(tx, clock, importId);
  return getImport(tx, clock, importId);
}

type ImportView = Awaited<ReturnType<typeof getImport>>;
function effectiveFrom(v: ImportView): string | null {
  const e = v.values.find((x) => x.irItem === "EFFECTIVE_FROM" && x.value !== null)?.value as { date: string } | undefined;
  return e?.date ?? v.document.effectiveFrom?.slice(0, 10) ?? null;
}

/** 권리 확인서 답: 읽기 틀 값과 빠진 것 입력이 그대로 템플릿 변수가 된다(결정 CT5). */
async function confirmationBody(tx: Tx, v: ImportView, kind: "AUTHOR" | "LABEL") {
  if (kind === "AUTHOR" && v.document.kind !== "PUBLISHING") throw invalid("CONFIRM_KIND", "the author confirmation comes from a publishing contract");
  if (kind === "LABEL" && v.document.kind !== "MASTER_CONTRACT") throw invalid("CONFIRM_KIND", "the label confirmation comes from a master contract");
  if (!v.values.every((x) => x.confirmed)) throw conflict("IMPORT_NOT_CONFIRMED", "confirm every candidate value first");
  if (v.missing.length > 0) throw conflict("IMPORT_GAPS", `fill the missing IR information first: ${v.missing.join(", ")}`);
  const rec = await withSystemScope(tx, async () => (await tx.query(
    `SELECT w.title AS work_title, r.recording_id, r.version_title, p.display_name AS owner FROM work w JOIN recording_version r ON r.work_id = w.work_id
       LEFT JOIN party p ON p.party_id = r.master_owner_party_id WHERE w.work_id = $1 ORDER BY r.recording_id LIMIT 1`, [v.workId])).rows[0]);
  const workTitle = (v.values.find((x) => x.irItem === "WORK_TITLE")?.value as { text: string } | undefined)?.text ?? rec?.work_title;
  const subject = rec === undefined ? `작품 「${workTitle}」` : `작품 「${workTitle}」, 녹음 ${rec.version_title}(${rec.owner})`;
  const clauses = [...new Set(v.values.filter((x) => x.irItem === (kind === "AUTHOR" ? "AUTHOR_SHARE" : "MASTER_OWNER")).map((x) => x.clause.split(" ")[0]))].join("·");
  const h = v.document.sha256;
  const source = `${v.document.title} v${v.document.version} ${clauses}(${v.document.documentId}, sha256 ${h.slice(0, 4)}…${h.slice(-4)})`;
  const validFrom = effectiveFrom(v);
  if (validFrom === null) throw conflict("IMPORT_GAPS", "the effective date is missing");
  if (kind === "LABEL") {
    const owner = v.values.find((x) => x.irItem === "MASTER_OWNER")?.value as { partyId: string } | undefined;
    if (owner === undefined || rec === undefined) throw conflict("IMPORT_GAPS", "the master owner or the recording is missing");
    return { templateId: "tpl_claim_confirm_label", answers: { subject, holder: owner.partyId, recording: rec.recording_id, source, importId: v.importId, validFrom } };
  }
  const g = v.gaps!;
  const usageText = `이용 행위 ${labelsOf("actions", g.actions)}, 지역 ${labelsOf("territories", g.territories)}, 매체 ${labelsOf("media", g.media)}, 공개 대상 ${labelsOf("audience", g.audience)}`;
  return {
    templateId: "tpl_claim_confirm_author",
    answers: {
      subject, authors: v.values.filter((x) => x.irItem === "AUTHOR_SHARE").map((x) => x.value), usage: usageText, period: `${validFrom} ~ ${g.validTo}`, source, importId: v.importId,
      actions: g.actions, territories: g.territories, media: g.media, audience: g.audience, validFrom, validTo: g.validTo,
    },
  };
}

function kindOf(raw: unknown): "AUTHOR" | "LABEL" {
  if (raw !== "AUTHOR" && raw !== "LABEL") throw new DomainError("BAD_REQUEST", 400, "kind must be AUTHOR or LABEL");
  return raw;
}

/** ⑤ 권리 확인서 미리보기(저장하지 않는다): 조항·서명자·서명하면 만들어지는 기록. */
export async function previewConfirmation(tx: Tx, clock: Clock, actor: Actor, importId: string, kind: unknown) {
  const v = await getImport(tx, clock, importId);
  const body = await confirmationBody(tx, v, kindOf(kind));
  const p = await previewContract(tx, actor, { ...body, factsScopeId: v.factsScopeId, contractId: `ctr_cc_${importId.replace(/^imp_/, "")}` });
  const managed = await noAccountParties(tx, p.signers);
  return { ...p, answers: body.answers, signerParties: (await partiesOf(tx, p.signers)).map((s) => ({ ...s, noAccount: managed.has(s.partyId), manager: managed.get(s.partyId) ?? null })) };
}

/** ⑤ 서명 요청: 표준 계약 길 B(createContract)로 만들어 보낸다. 계정 없는 작가는 전자서명 공급자 링크로 서명한다(결정 WD2). */
export async function sendConfirmation(tx: Tx, clock: Clock, actor: Actor, provider: SignatureProvider, importId: string, kind: unknown) {
  const v = await getImport(tx, clock, importId);
  locked(v.step, importId);
  const body = await confirmationBody(tx, v, kindOf(kind));
  const contractId = `ctr_cc_${importId.replace(/^imp_/, "")}`;
  const c = await createContract(tx, clock, actor, provider, { ...body, factsScopeId: v.factsScopeId, contractId });
  await tx.query("UPDATE contract_import SET step = 'CONFIRM_SENT', contract_id = $2 WHERE import_id = $1", [importId, contractId]);
  return c;
}

/** 이 곡의 권리 확인서(레이블용·작가용): 종류마다 가장 최근 계약(없으면 null). */
export async function listClaimConfirmations(tx: Tx, scopeId: string) {
  const all = await listContracts(tx, { scope: scopeId });
  return (["LABEL", "AUTHOR"] as const).map((kind) => {
    const tpl = kind === "LABEL" ? "tpl_claim_confirm_label" : "tpl_claim_confirm_author";
    const c = all.filter((x) => x.templateId === tpl && x.status !== "CANCELLED").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return { kind, templateId: tpl, contract: c ?? null };
  });
}

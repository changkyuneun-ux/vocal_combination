import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { requirePermission } from "../platform/permissions.ts";

/**
 * 계약서 읽기 틀(결정 CT1·CT2): 권리 테넌트가 자기 계약 양식에서 값이 있는 위치(쪽·조항)와 값 모양을 IR 항목에 대응시켜 등록하고,
 * 플랫폼이 승인한다. 승인 뒤에는 바꿀 수 없고 새 버전으로 바꾼다. 원본 PDF의 글자는 서버가 뽑지 않는다(자동 추출 없음, 외부 반출 없음) —
 * 사람이 그 조항의 인용 문장을 표시하면(원천 문서 조항 표시, 길 A) 값 모양에 맞춰 값을 읽고, 사람이 하나씩 확인한다.
 */
export const IR_ITEMS = ["WORK_TITLE", "AUTHOR", "AUTHOR_SHARE", "EFFECTIVE_FROM", "RECORDING", "MASTER_OWNER"] as const;
export type IrItem = (typeof IR_ITEMS)[number];
export type FrameField = {
  key: string; label: string; irItem: IrItem; page: number; clause: string; pattern: string;
  /** 당사자를 이름이 아니라 순서(갑·을)로 적는 양식: 원천 문서 당사자 목록의 몇 번째(1부터). */
  partyOrder?: number;
  /** 작가 지분의 역할(작사·작곡 등). 양식이 정해 둔다. */
  roleDetail?: string;
};
export type Frame = {
  frameId: string; version: number; ownerTenantId: string; title: string; documentKind: "PUBLISHING" | "MASTER_CONTRACT"; pages: number | null;
  fields: FrameField[]; status: string; authoredBy: string; authoredAt: string; approvedBy?: string; approvedAt?: string;
};
export type FrameValue =
  | { text: string }
  | { partyId: string; shareBps: number; roleDetail: string | null }
  | { partyId: string }
  | { date: string };
export type Candidate = { key: string; value: FrameValue | null; reason?: string };

const ID = /^[A-Za-z0-9._-]+$/;
const KEY = /^[a-z][a-zA-Z0-9_]*$/;
const SLOTS = ["bps", "percent", "date", "text", "party"] as const;
const bad = (m: string) => invalid("INVALID_FRAME", m);

/** 값 모양 → 정규식. {bps}·{percent}·{date}·{text}·{party} 자리를 잡고 나머지는 글자 그대로(공백은 느슨하게). */
function patternRegex(pattern: string): { re: RegExp; slots: string[] } {
  const slots: string[] = [];
  let src = "";
  for (const part of pattern.split(/(\{[a-z]+\})/)) {
    const m = /^\{([a-z]+)\}$/.exec(part);
    if (m) {
      const s = m[1]!;
      slots.push(s);
      src += "\\s*" + (s === "bps" ? "([0-9]{1,5})"
        : s === "percent" ? "([0-9]{1,3}(?:\\.[0-9]{1,2})?)"
          : s === "date" ? "([0-9]{4}\\s*(?:-|\\.|년)\\s*[0-9]{1,2}\\s*(?:-|\\.|월)\\s*[0-9]{1,2}\\s*일?)"
            : "(.+?)") + "\\s*";
    } else {
      src += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
    }
  }
  // 끝에 오는 {text}·{party}는 문장 끝까지 읽는다.
  if (/\{(text|party)\}\s*$/.test(pattern)) src = src.replace(/\(\.\+\?\)\\s\*$/, "(.+)");
  return { re: new RegExp(src), slots };
}

function toDate(s: string): string | null {
  const m = /^([0-9]{4})\s*(?:-|\.|년)\s*([0-9]{1,2})\s*(?:-|\.|월)\s*([0-9]{1,2})/.exec(s.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${d}T00:00:00.000Z`)) || new Date(`${d}T00:00:00.000Z`).toISOString().slice(0, 10) !== d ? null : d;
}

/**
 * 읽기 틀 적용(순수 함수): 필드마다 인용 문장을 값 모양에 맞춰 후보 값을 만든다. 인용이 없거나 모양이 맞지 않으면 후보를 만들지 않고
 * 사람이 입력하도록 남긴다(value null, reason). 당사자는 {party} 이름으로 찾거나 양식이 정한 순서(partyOrder)로 고른다.
 */
export function applyFrame(fields: FrameField[], quotes: Record<string, string | undefined>, ctx: { parties: { partyId: string; name: string }[] }): Candidate[] {
  return fields.map((f): Candidate => {
    const quote = quotes[f.key];
    if (quote === undefined || quote.trim() === "") return { key: f.key, value: null, reason: "인용 문장 없음 — 사람이 입력" };
    const { re, slots } = patternRegex(f.pattern);
    const m = re.exec(quote.replace(/[“”"]/g, ""));
    if (!m) return { key: f.key, value: null, reason: "값 모양과 맞지 않음 — 사람이 입력" };
    const got = Object.fromEntries(slots.map((s, i) => [s, m[i + 1]!.trim()]));
    const party = (): string | null => {
      if (got.party !== undefined) return ctx.parties.find((p) => p.name === got.party || p.partyId === got.party)?.partyId ?? null;
      if (f.partyOrder !== undefined) return ctx.parties[f.partyOrder - 1]?.partyId ?? null;
      return null;
    };
    switch (f.irItem) {
      case "WORK_TITLE": case "RECORDING":
        return got.text ? { key: f.key, value: { text: got.text } } : { key: f.key, value: null, reason: "{text} 자리가 없음" };
      case "EFFECTIVE_FROM": {
        const d = got.date === undefined ? null : toDate(got.date);
        return d ? { key: f.key, value: { date: d } } : { key: f.key, value: null, reason: "날짜를 읽지 못함 — 사람이 입력" };
      }
      case "AUTHOR": case "MASTER_OWNER": {
        const p = party();
        return p ? { key: f.key, value: { partyId: p } } : { key: f.key, value: null, reason: "당사자를 찾지 못함 — 사람이 입력" };
      }
      case "AUTHOR_SHARE": {
        const p = party();
        const bps = got.bps !== undefined ? Number(got.bps) : got.percent !== undefined ? Math.round(Number(got.percent) * 100) : NaN;
        if (p === null) return { key: f.key, value: null, reason: "당사자를 찾지 못함 — 사람이 입력" };
        if (!Number.isInteger(bps) || bps < 1 || bps > 10000) return { key: f.key, value: null, reason: "지분을 읽지 못함 — 사람이 입력" };
        return { key: f.key, value: { partyId: p, shareBps: bps, roleDetail: f.roleDetail ?? null } };
      }
    }
  });
}

/** 등록 본문의 필드 목록 검사. */
export function checkFields(raw: unknown): FrameField[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad("fields must be a non-empty list");
  const keys = new Set<string>();
  return raw.map((x, i) => {
    const f = x as Record<string, unknown>;
    if (typeof f.key !== "string" || !KEY.test(f.key) || keys.has(f.key)) throw bad(`fields[${i}].key must be a unique identifier`);
    keys.add(f.key);
    if (typeof f.label !== "string" || f.label.trim() === "") throw bad(`fields[${i}].label is required`);
    if (!IR_ITEMS.includes(f.irItem as IrItem)) throw bad(`fields[${i}].irItem must be one of ${IR_ITEMS.join(", ")}`);
    if (!Number.isInteger(f.page) || (f.page as number) < 1) throw bad(`fields[${i}].page must be a positive integer`);
    if (typeof f.clause !== "string" || f.clause.trim() === "") throw bad(`fields[${i}].clause is required (예: 제3조 1항)`);
    if (typeof f.pattern !== "string") throw bad(`fields[${i}].pattern is required`);
    const used = [...f.pattern.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!);
    if (used.length === 0 || used.some((s) => !(SLOTS as readonly string[]).includes(s))) throw bad(`fields[${i}].pattern needs one of {${SLOTS.join("}, {")}}`);
    if (f.partyOrder !== undefined && !(Number.isInteger(f.partyOrder) && (f.partyOrder as number) >= 1)) throw bad(`fields[${i}].partyOrder must be a positive integer`);
    if (f.roleDetail !== undefined && typeof f.roleDetail !== "string") throw bad(`fields[${i}].roleDetail must be text`);
    return {
      key: f.key, label: f.label.trim(), irItem: f.irItem as IrItem, page: f.page as number, clause: f.clause.trim(), pattern: f.pattern,
      ...(f.partyOrder !== undefined && { partyOrder: f.partyOrder as number }), ...(f.roleDetail !== undefined && { roleDetail: f.roleDetail as string }),
    };
  });
}

function toFrame(r: any): Frame {
  return {
    frameId: r.frame_id, version: r.version, ownerTenantId: r.owner_tenant_id, title: r.title, documentKind: r.document_kind, pages: r.pages, fields: r.fields,
    status: r.status, authoredBy: r.authored_by, authoredAt: iso(r.authored_at)!,
    ...(r.approved_by !== null && { approvedBy: r.approved_by as string, approvedAt: iso(r.approved_at)! }),
  };
}

/** 보이는 읽기 틀(소유 테넌트·플랫폼) 전부, 쓴 횟수(불러오기 수)와 함께. */
export async function listFrames(tx: Tx): Promise<(Frame & { uses: number })[]> {
  const rows = (await tx.query("SELECT * FROM contract_reading_frame ORDER BY frame_id, version DESC")).rows;
  const uses = new Map((await withSystemScope(tx, async () => (await tx.query(
    "SELECT frame_id, frame_version, count(*)::int AS n FROM contract_import WHERE frame_id IS NOT NULL GROUP BY frame_id, frame_version")).rows))
    .map((r) => [`${r.frame_id}@${r.frame_version}`, r.n as number]));
  return rows.map((r) => ({ ...toFrame(r), uses: uses.get(`${r.frame_id}@${r.version}`) ?? 0 }));
}

export async function getFrame(tx: Tx, frameId: string, version?: number): Promise<Frame> {
  const r = version === undefined
    ? (await tx.query("SELECT * FROM contract_reading_frame WHERE frame_id = $1 AND status = 'APPROVED' ORDER BY version DESC LIMIT 1", [frameId])).rows[0]
    : (await tx.query("SELECT * FROM contract_reading_frame WHERE frame_id = $1 AND version = $2", [frameId, version])).rows[0];
  if (r === undefined) throw notFound("reading frame", version === undefined ? frameId : `${frameId}@${version}`);
  return toFrame(r);
}

/** 등록(권리 테넌트, contract.draft): 새 버전(DRAFT). 같은 id의 앞 버전은 그대로 두고, 승인되면 그 버전을 대신한다. */
export async function registerFrame(tx: Tx, clock: Clock, actor: Actor, b: Record<string, unknown>): Promise<Frame> {
  if (actor.scope !== "tenant") throw new DomainError("TENANT_ONLY", 403, "reading frames are registered by the rights tenant that uses the contract form");
  requirePermission(actor, "contract.draft");
  if (typeof b.frameId !== "string" || !ID.test(b.frameId)) throw bad("frameId must be an id");
  if (typeof b.title !== "string" || b.title.trim() === "") throw bad("title is required");
  if (b.documentKind !== "PUBLISHING" && b.documentKind !== "MASTER_CONTRACT") throw bad("documentKind must be PUBLISHING or MASTER_CONTRACT");
  if (b.pages !== undefined && !(Number.isInteger(b.pages) && (b.pages as number) >= 1)) throw bad("pages must be a positive integer");
  const fields = checkFields(b.fields);
  const prior = await withSystemScope(tx, async () => (await tx.query("SELECT owner_tenant_id, max(version)::int AS v FROM contract_reading_frame WHERE frame_id = $1 GROUP BY owner_tenant_id", [b.frameId])).rows[0]);
  if (prior !== undefined && prior.owner_tenant_id !== actor.tenantId) throw conflict("FRAME_EXISTS", `reading frame ${b.frameId} belongs to another tenant`);
  const version = (prior?.v ?? 0) + 1;
  await tx.query(
    `INSERT INTO contract_reading_frame (frame_id, version, owner_tenant_id, title, document_kind, pages, fields, authored_by, authored_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [b.frameId, version, actor.tenantId, b.title.trim(), b.documentKind, b.pages ?? null, JSON.stringify(fields), actor.userId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "READING_FRAME_REGISTERED", entityType: "contract_reading_frame", entityId: `${b.frameId}@${version}` });
  return getFrame(tx, b.frameId, version);
}

/** 승인(플랫폼, contract.frame_approve): DRAFT → APPROVED, 앞의 승인 버전은 RETIRED(이미 쓴 불러오기는 그 버전에 고정). */
export async function approveFrame(tx: Tx, clock: Clock, actor: Actor, frameId: string, version: number): Promise<Frame> {
  requirePermission(actor, "contract.frame_approve");
  if (actor.scope !== "platform") throw new DomainError("PLATFORM_ONLY", 403, "reading frames are approved by the platform");
  const f = await getFrame(tx, frameId, version);
  if (f.status !== "DRAFT") throw conflict("FRAME_NOT_DRAFT", `${frameId}@${version} is ${f.status}`);
  await withSystemScope(tx, async () => {
    await tx.query("UPDATE contract_reading_frame SET status = 'RETIRED' WHERE frame_id = $1 AND status = 'APPROVED'", [frameId]);
    await tx.query("UPDATE contract_reading_frame SET status = 'APPROVED', approved_by = $3, approved_at = $4 WHERE frame_id = $1 AND version = $2", [frameId, version, actor.userId, clock.now()]);
  });
  await audit(tx, clock, { actor: actor.userId, action: "READING_FRAME_APPROVED", entityType: "contract_reading_frame", entityId: `${frameId}@${version}` });
  return getFrame(tx, frameId, version);
}

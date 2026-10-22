import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { checkForm, explainForm, formToText, textToForm, type PolicyForm } from "../engine-bridge/policy-form.ts";
import { requirePermission } from "../platform/permissions.ts";
import { sodEnabled } from "../platform/sod.ts";

/**
 * 표준 분배 규칙 템플릿(테넌트 정책 결정 TD13). 법무가 작성·승인(작성자 ≠ 승인자)한 폼이다. 권리 테넌트는 템플릿을 값 그대로 써서 정책을 만들 수 있고,
 * 1인 테넌트(독립 아티스트)는 그렇게 만든 정책만 혼자 편집·승인·활성화할 수 있다(템플릿 승인이 두 번째 눈이다).
 */
export type TemplateForm = Omit<PolicyForm, "packId">;
export type PolicyTemplate = {
  templateId: string; version: number; title: string; description: string; form: TemplateForm; status: string; seeded: boolean;
  authoredBy: string | null; approvedBy: string | null; createdAt: string; approvedAt: string | null; explanation: string[];
};

function view(r: any): PolicyTemplate {
  const form = r.form as TemplateForm;
  return {
    templateId: r.template_id, version: r.version, title: r.title, description: r.description, form, status: r.status, seeded: r.seeded,
    authoredBy: r.authored_by, approvedBy: r.approved_by, createdAt: iso(r.created_at)!, approvedAt: iso(r.approved_at) ?? null,
    explanation: explainForm({ ...form, packId: "pack" }),
  };
}

export async function listTemplates(tx: Tx, f: { status?: string } = {}): Promise<PolicyTemplate[]> {
  return (await tx.query("SELECT * FROM policy_template WHERE ($1::text IS NULL OR status = $1) ORDER BY template_id, version", [f.status ?? null])).rows.map(view);
}

export async function getTemplate(tx: Tx, templateId: string, version?: number): Promise<PolicyTemplate> {
  const r = (await tx.query(
    version === undefined
      ? "SELECT * FROM policy_template WHERE template_id = $1 AND status = 'APPROVED' ORDER BY version DESC LIMIT 1"
      : "SELECT * FROM policy_template WHERE template_id = $1 AND version = $2",
    version === undefined ? [templateId] : [templateId, version])).rows[0];
  if (r === undefined) throw notFound("policy template", version === undefined ? templateId : `${templateId}@${version}`);
  return view(r);
}

/** 템플릿 → 그 팩·정책 id의 MDRL 텍스트(값을 바꾸지 않는다). */
export function templateText(t: PolicyTemplate, packId: string, policyId: string, version = 1): string {
  return formToText({ ...t.form, packId }, policyId, version);
}

/** 법무 초안 작성(DRAFT). 계약 몫(특정 당사자)이 없는 폼만. */
export async function draftTemplate(tx: Tx, clock: Clock, actor: Actor, b: { templateId?: unknown; title?: unknown; description?: unknown; form?: unknown }) {
  requirePermission(actor, "legal.template");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "templates are drafted by platform legal");
  if (typeof b.templateId !== "string" || !/^ptpl_[a-z0-9_]+$/.test(b.templateId)) throw invalid("BAD_REQUEST", "templateId must look like ptpl_<소문자·숫자·_>");
  if (typeof b.title !== "string" || b.title.trim() === "" || typeof b.description !== "string") throw invalid("BAD_REQUEST", "title and description are required");
  const form = b.form as TemplateForm;
  if (typeof form !== "object" || form === null || "packId" in form) throw invalid("BAD_REQUEST", "form is a policy form without packId");
  if ((form.contracts ?? []).length > 0) throw invalid("TEMPLATE_HAS_PARTY", "a template cannot name a specific party (contract shares)");
  const diags = checkForm({ ...form, packId: "pak_template" });
  if (diags.length > 0) throw invalid("FORM_INVALID", "the template form is invalid", diags);
  const version = ((await tx.query("SELECT COALESCE(MAX(version), 0)::int AS v FROM policy_template WHERE template_id = $1", [b.templateId])).rows[0].v as number) + 1;
  await tx.query("INSERT INTO policy_template (template_id, version, title, description, form, authored_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [b.templateId, version, b.title.trim(), b.description, JSON.stringify(form), actor.userId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_TEMPLATE_DRAFTED", entityType: "policy_template", entityId: `${b.templateId}@${version}` });
  return getTemplate(tx, b.templateId, version);
}

/** 법무 승인: 작성자가 아닌 다른 법무만. 같은 템플릿의 이전 승인본은 그대로 둔다(이미 만든 정책이 가리킨다). */
export async function approveTemplate(tx: Tx, clock: Clock, actor: Actor, templateId: string, version: number) {
  requirePermission(actor, "legal.template");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "templates are approved by platform legal");
  const t = (await tx.query("SELECT status, authored_by FROM policy_template WHERE template_id = $1 AND version = $2 FOR UPDATE", [templateId, version])).rows[0];
  if (t === undefined) throw notFound("policy template", `${templateId}@${version}`);
  if (t.status !== "DRAFT") throw conflict("INVALID_STATE", `${templateId}@${version} is ${t.status}`);
  if (t.authored_by === actor.userId && (await sodEnabled(tx, "policy-template.author-approve"))) throw new DomainError("SOD_VIOLATION", 403, "the author cannot approve the template");
  await tx.query("UPDATE policy_template SET status = 'APPROVED', approved_by = $3, approved_at = $4 WHERE template_id = $1 AND version = $2", [templateId, version, actor.userId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_TEMPLATE_APPROVED", entityType: "policy_template", entityId: `${templateId}@${version}` });
  return getTemplate(tx, templateId, version);
}

/**
 * 1인 테넌트의 직무 분리 예외(TD13): 같은 사람이 이미 서명한 정책을 승인·활성화하려 할 때, 다음을 모두 만족하면 허용한다.
 * 독립 아티스트 테넌트 본인(대행 아님) · 정책 버전이 승인된 템플릿에서 왔고 · 본문이 그 템플릿 그대로다.
 */
export async function templateExemption(tx: Tx, actor: Actor, row: { policyId: string; version: number; packId: string }): Promise<{ templateId: string; version: number } | null> {
  if (actor.tenantType !== "INDEPENDENT_ARTIST" || actor.scope !== "tenant" || actor.actingOnBehalfOf !== undefined) return null;
  const p = (await tx.query("SELECT source_text, template_id, template_version, rebind_of_version FROM policy_version WHERE policy_id = $1 AND version = $2", [row.policyId, row.version])).rows[0];
  if (p?.template_id == null) return null;
  const t = await getTemplate(tx, p.template_id, p.template_version);
  if (t.status !== "APPROVED") return null;
  // 봉인된 본문(canonical)은 facts 고정이 들어가므로 폼으로 되돌려 비교한다: 템플릿 값과 하나라도 다르면 예외가 아니다.
  const back = textToForm(p.source_text as string);
  if (back.form === null || formToText(back.form, row.policyId, row.version) !== templateText(t, row.packId, row.policyId, row.version)) return null;
  return { templateId: t.templateId, version: t.version };
}

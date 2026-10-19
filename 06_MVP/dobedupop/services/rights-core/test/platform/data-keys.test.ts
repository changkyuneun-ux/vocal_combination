import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";

// 데이터 범위의 열쇠 목록(테넌트 정책 3절, 진행 TN7). 새 표가 열쇠 없이 생기지 않도록 모든 표를 여기서 분류한다 —
// 표를 추가하면 이 시험이 실패하고, 어느 열쇠로 볼지 정해야 통과한다.
//   OWNER = 소유(등록한 권리 테넌트), PARTY = 당사자(그 몫의 관리 주체), SELF = 본인(계정·개인 당사자), LINK = 연결(참여 기관),
//   ORG = 조직 자기 데이터(파트너 리포트·확인 항목), PUBLIC = 공용, PLATFORM = 플랫폼 전용, AUTH = 인증(시스템 범위만),
//   REFERENCE = RLS 없음(식별·참조·불변 봉인·설정 — 행을 돌려주는 API가 범위를 정한다).
const KEYS: Record<string, "OWNER" | "PARTY" | "SELF" | "LINK" | "ORG" | "PUBLIC" | "PLATFORM" | "AUTH" | "REFERENCE"> = {
  work: "OWNER", facts_scope: "OWNER", recording_version: "OWNER", part_slot: "OWNER", stem: "OWNER", voice: "OWNER", right_claim: "OWNER", mandate: "OWNER",
  dispute: "OWNER", vocal_pack: "OWNER", pack_claimant: "OWNER", policy_version: "OWNER", rights_snapshot: "OWNER", snapshot_stem_assignment: "OWNER",
  snapshot_member_pct: "OWNER", issue_seal: "OWNER", source_document: "OWNER", document_clause: "OWNER", record_clause: "OWNER", record_evidence: "OWNER",
  validation_issue: "OWNER", validation_check: "OWNER", contract_envelope: "OWNER", contract_signature: "OWNER", stem_audio: "OWNER", reference_audio: "OWNER",
  combination_render: "OWNER", exposure_hold: "OWNER", decision_cache: "OWNER", decision_epoch: "OWNER", confirmation_request: "OWNER", issue_rejection: "OWNER",
  consent_agreement: "OWNER",
  allocation_line: "PARTY", payout_instruction: "PARTY", party_payout_profile: "PARTY", ledger_account: "PARTY", posting: "PARTY",
  notification: "SELF", push_subscription: "SELF", identity_challenge: "SELF", play_event: "SELF",
  participant_link: "LINK", partner_asset: "LINK",
  inbound_file: "ORG", inbound_record: "ORG", tenant_check: "ORG",
  contract_template: "PUBLIC",
  revenue_event: "PLATFORM", revenue_supersede: "PLATFORM", settlement_batch: "PLATFORM", settlement_batch_skip: "PLATFORM", settlement_run: "PLATFORM",
  settlement_run_event: "PLATFORM", settlement_run_event_refund: "PLATFORM", pool_line: "PLATFORM", unallocated_holding: "PLATFORM", reversal_run: "PLATFORM",
  hold_release: "PLATFORM", hold_release_reversal: "PLATFORM", quarantine: "PLATFORM", psp_webhook_inbox: "PLATFORM", audit_log: "PLATFORM", outbox: "PLATFORM",
  traffic_pool: "PLATFORM", traffic_allocation: "PLATFORM", inspection_audit_log: "PLATFORM", break_glass: "PLATFORM",
  user_credential: "AUTH", user_session: "AUTH", user_invitation: "AUTH",
  // RLS 없음: 신원·소속(user_account·user_membership·portal_role), 조직·당사자 명부(tenant·party — 공용 명부 범위는 조회 API가 거른다, 결정 TD8),
  // 불변 봉인·서명(sealed_document·attestation·dev_signing_key), 설정(payout_policy), 분개 머리(journal_entry — 금액은 posting에), 지급 실행(payout_run), 마이그레이션.
  user_account: "REFERENCE", user_membership: "REFERENCE", portal_role: "REFERENCE", tenant: "REFERENCE", party: "REFERENCE", sealed_document: "REFERENCE",
  attestation: "REFERENCE", dev_signing_key: "REFERENCE", payout_policy: "REFERENCE", journal_entry: "REFERENCE", payout_run: "REFERENCE", schema_migrations: "REFERENCE",
};

const { db, drop } = await freshDb();
after(drop);

test("every table has a data key, and every keyed table has row-level security", async () => {
  const rows = (await db.pool.query(
    "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1")).rows;
  const unclassified = rows.map((r) => r.relname as string).filter((t) => KEYS[t] === undefined);
  assert.deepEqual(unclassified, [], "new tables need a data key in this list (테넌트 정책 3절 순서로 정한다)");
  assert.deepEqual(Object.keys(KEYS).filter((t) => !rows.some((r) => r.relname === t)), [], "the list names tables that no longer exist");
  const wrong = rows.filter((r) => (KEYS[r.relname] === "REFERENCE") === r.relrowsecurity).map((r) => `${r.relname}:${KEYS[r.relname]}:${r.relrowsecurity ? "rls" : "no rls"}`);
  assert.deepEqual(wrong, [], "keyed tables must have RLS; REFERENCE tables have none");
});

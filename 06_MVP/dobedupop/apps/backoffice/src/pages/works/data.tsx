import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiError, Paged } from "../../api/client.ts";
import { sessionMode } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import type { Readiness, ScopeInfo, WorkFacts, WorkOverview } from "../../api/works.ts";
import type { PartyRow } from "../../api/works.ts";

/** 작품 화면이 같이 쓰는 조회. 쓰기 뒤에는 WORKS_KEYS를 모두 다시 읽는다. */
export const WORKS_KEYS = ["works-overview", "work-facts", "readiness", "scope-info", "parties", "work-contracts", "work-confirmations", "work-consents", "work-packs", "work-policies", "policy-version", "documents", "contract-imports", "claim-confirmations", "reading-frames"];

export const useOverview = () => useGet<WorkOverview[]>(["works-overview"], "/works/overview");
export function useWork(workId: string) {
  const o = useOverview();
  return { ...o, work: o.data?.find((w) => w.workId === workId) };
}
export const useFacts = (scopeId: string | null | undefined) =>
  useGet<WorkFacts>(["work-facts", scopeId], `/scopes/${encodeURIComponent(scopeId ?? "")}/facts`, { enabled: !!scopeId });
export const useReadiness = (scopeId: string | null | undefined) =>
  useGet<Readiness>(["readiness", scopeId], `/scopes/${encodeURIComponent(scopeId ?? "")}/readiness`, { enabled: !!scopeId });
export const useScopeInfo = (scopeId: string | null | undefined) =>
  useGet<ScopeInfo>(["scope-info", scopeId], `/scopes/${encodeURIComponent(scopeId ?? "")}`, { enabled: !!scopeId });

/** 당사자 표시 이름(보이는 당사자 한 쪽 — MVP 규모). */
export function useParties() {
  const q = useGet<Paged<PartyRow>>(["parties", "all"], "/parties?limit=200");
  const items = q.data?.items ?? [];
  return { ...q, items, names: new Map(items.map((p) => [p.partyId, p.displayName])) };
}

export type Me = { userId: string; roles: string[]; permissions: string[]; tenantId: string; tenantStatus?: string; scope: string; partyId?: string; memberships?: { tenantId: string; name: string }[] };
/** 로그인 사용자의 권한(1부 RBAC). 개발 서버(사용자 전환)에서도 /me를 읽는다. */
export function useMe() {
  const q = useGet<Me>(["me-perms"], "/me");
  const perms = new Set(q.data?.permissions ?? []);
  // 권한을 아직 모르면(불러오는 중) 버튼을 보여 주고 코어가 다시 검사한다.
  const can = (p: string) => q.data === undefined || perms.has(p);
  return { ...q, me: q.data, can };
}

/** 쓰기 한 번: 실행 → 작품 조회 다시 읽기, 오류·안내 상태를 돌려준다. */
export function useWrite() {
  const qc = useQueryClient();
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      setErr(null); setNotice(msg);
      await Promise.all(WORKS_KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      return true;
    } catch (e) { setErr(e as ApiError); setNotice(""); return false; } finally { setBusy(false); }
  };
  return { run, err, notice, busy, setErr, setNotice };
}

export const sessionOnly = sessionMode;

/** IR 준비 항목 표시: ✓ · ! · ✕ */
export function ReadyMark({ ok }: { ok: boolean | "warn" }) {
  return ok === true ? <span className="mark-ok" aria-label="통과">✓</span> : ok === "warn" ? <span className="mark-warn" aria-label="경고">!</span> : <span className="mark-bad" aria-label="미충족">✕</span>;
}

export const STATUS_TONE: Record<string, string> = { "입력 중": "muted", "확인 대기": "warn", "IR 생성됨": "info", "판매 중": "ok", "분쟁·보류": "bad" };
export function WorkStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? "muted"}`}>{status}</span>;
}

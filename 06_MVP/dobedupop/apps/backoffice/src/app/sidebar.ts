/**
 * 권리 테넌트 사이드 메뉴 모델(시안 Sidebar.dc.html 2026-10-23 2차, 디자인 가이드 4절). 순수 함수 — 화면은 이 결과를 그리기만 한다.
 * - 작품 관리: 작품 목록 · 작품 워크스페이스(지금 연 곡 이름 + 상태 배지 하나 — 누르면 원곡 권리 탭). '최근 연 작품'은 두지 않는다(2026-10-23).
 *   곡 안의 화면(원곡 권리·스템·…)은 메뉴에 두지 않고 본문 탭으로 고른다. 곡의 어느 탭에 있든 곡 이름 줄이 지금 화면이다. 새 곡은 작품 목록 버튼으로.
 * - 경로 줄(breadcrumb)은 두지 않는다(2026-10-23) — 위치는 사이드 메뉴 활성과 제목으로 안다.
 * - 배지는 할 일(주황)만. 건수만 알리는 회색 숫자 배지와 묶음 옆 설명은 두지 않는다.
 * - 펼침 기본값: 지금 화면이 든 메뉴는 펼친다. 운영 관리 화면에서는 지금 화면이 든 묶음만, 작품 화면에서는 확인·동의·계약·문서를 펼친다.
 *   접힌 메뉴 안에 지금 화면이 있으면 그 메뉴 이름을 굵게(strong) 보인다.
 */
export type Badge = { text: string; tone: "warn" | "gray" | "ok" | "ir" | "bad" };
export type Leaf = { key: string; label: string; to: string; current: boolean; badge?: Badge };
export type Item = { key: string; label: string; to?: string; current: boolean; open: boolean; strong: boolean; children: Leaf[]; badge?: Badge };
export type Group = { key: string; label: string; open: boolean; items: Item[] };
export type CurrentWork = { workId: string; title: string; status: string } | null;
export type Counts = Partial<Record<"confirmAll" | "contractsPending" | "warnings", number>>;

const OPS: Record<string, string> = {
  "/ops/confirmations": "op-confirm-all", "/ops/consents": "op-consents", "/ops/contracts": "op-contracts-all", "/ops/documents": "op-docs", "/ops/templates": "op-templates",
  "/ops/validation": "op-validation", "/ops/statements": "op-statements", "/ops/issues": "op-issues", "/": "op-org", "/accounts": "op-accounts", "/delegation": "op-delegation", "/links": "op-links",
};
/** 곡 상태 배지 색: 할 일(확인 대기)은 주황. */
const STATUS_TONE: Record<string, Badge["tone"]> = { "입력 중": "gray", "확인 대기": "warn", "IR 생성됨": "ir", "판매 중": "ok", "분쟁·보류": "bad" };

/** 경로 → 지금 화면 키. */
export function activeKey(path: string): string {
  if (path === "/works") return "works-list";
  if (path === "/works/new") return "works-new";
  // 곡의 어느 탭(과 그 아래 화면)이든 사이드 메뉴의 지금 화면은 곡 이름 줄이다.
  if (/^\/works\/[^/]+\/[a-z]+/.test(path)) return "ws";
  return OPS[path] ?? "";
}

/** 경로가 곡 워크스페이스면 그 곡 id. */
export function workIdOf(path: string): string | null {
  const m = /^\/works\/([^/]+)\/[a-z]+/.exec(path);
  return m && m[1] !== "new" ? decodeURIComponent(m[1]!) : null;
}

const todo = (n: number | undefined): Badge | undefined => (n === undefined || n === 0 ? undefined : { text: String(n), tone: "warn" });

export function sidebarModel(path: string, work: CurrentWork, counts: Counts, perms: (p: string) => boolean, closed: Record<string, boolean> = {}): Group[] {
  const active = activeKey(path);
  const isOpen = (k: string, dflt: boolean) => (closed[k] === undefined ? dflt : !closed[k]);
  const leaf = (key: string, label: string, to: string, badge?: Badge): Leaf => ({ key, label, to, current: key === active, ...(badge && { badge }) });
  const item = (key: string, label: string, opts: { to?: string; children?: Leaf[]; open?: boolean; badge?: Badge } = {}): Item => {
    const kids = opts.children ?? [];
    const contains = kids.some((c) => c.current);
    const open = kids.length > 0 ? isOpen(key, opts.open ?? contains) : false;
    return {
      key, label, ...(opts.to && { to: opts.to }), current: kids.length === 0 && key === active, open, strong: kids.length > 0 && contains && !open, children: kids,
      ...(opts.badge && { badge: opts.badge }),
    };
  };
  const g1: Item[] = [item("works-list", "작품 목록", { to: "/works" })];
  if (work) {
    const badge: Badge = { text: work.status, tone: STATUS_TONE[work.status] ?? "gray" };
    g1.push(item("ws", "작품 워크스페이스", { children: [leaf("ws", work.title, `/works/${encodeURIComponent(work.workId)}/rights`, badge)], open: true }));
  }
  const onOps = active.startsWith("op-");
  const org = [leaf("op-org", "내 조직", "/"), ...(perms("account.manage") ? [leaf("op-accounts", "담당자 계정", "/accounts")] : []),
    ...(perms("delegation.set") ? [leaf("op-delegation", "위임 대행", "/delegation")] : []), leaf("op-links", "신탁·유통 연결", "/links")];
  const g2: Item[] = [
    item("op-c", "확인·동의", { children: [leaf("op-confirm-all", "확인 요청 전체", "/ops/confirmations", todo(counts.confirmAll)), leaf("op-consents", "멤버 이용 동의", "/ops/consents")], ...(onOps ? {} : { open: true }) }),
    item("op-d", "계약·문서", { children: [leaf("op-contracts-all", "표준 계약 전체", "/ops/contracts", todo(counts.contractsPending)), leaf("op-docs", "원천 문서", "/ops/documents"), leaf("op-templates", "계약 템플릿", "/ops/templates")], ...(onOps ? {} : { open: true }) }),
    item("op-v", "점검", { children: [leaf("op-validation", "정합성 점검 전체", "/ops/validation", counts.warnings ? { text: `경고 ${counts.warnings}`, tone: "warn" } : undefined)] }),
    item("op-s", "정산", { children: [leaf("op-statements", "명세·지급", "/ops/statements"), leaf("op-issues", "발행 조합", "/ops/issues")] }),
    item("op-o", "조직", { children: org }),
  ];
  return [
    { key: "g-works", label: "작품 관리", open: isOpen("g-works", true), items: g1 },
    { key: "g-ops", label: "운영 관리", open: isOpen("g-ops", true), items: g2 },
  ];
}

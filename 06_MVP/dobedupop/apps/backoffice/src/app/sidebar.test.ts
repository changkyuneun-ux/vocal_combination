import { describe, expect, it } from "vitest";
import { activeKey, sidebarModel, workIdOf } from "./sidebar.ts";

const all = () => true;
const work = { workId: "wrk_dynamite", title: "Dynamite", status: "확인 대기" };
const find = (g: ReturnType<typeof sidebarModel>, key: string) => g.flatMap((x) => x.items).find((i) => i.key === key)!;
const badges = (g: ReturnType<typeof sidebarModel>) => g.flatMap((x) => x.items).flatMap((i) => [i.badge, ...i.children.map((c) => c.badge)]).filter(Boolean);

describe("권리 테넌트 사이드 메뉴(시안 Sidebar.dc.html 2026-10-23 3차)", () => {
  it("maps paths: every tab of the open song (and screens under it) is the song row", () => {
    expect(activeKey("/works")).toBe("works-list");
    expect(activeKey("/works/wrk_dynamite/stems")).toBe("ws");
    expect(activeKey("/works/wrk_dynamite/rights")).toBe("ws");
    expect(activeKey("/works/wrk_dynamite/contracts/import")).toBe("ws");
    expect(activeKey("/ops/confirmations")).toBe("op-confirm-all");
    expect(activeKey("/")).toBe("op-org");
    expect(workIdOf("/works/wrk_dynamite/stems")).toBe("wrk_dynamite");
    expect(workIdOf("/works/new")).toBeNull();
  });

  it("작품 관리: 작품 목록 · 작품 워크스페이스(곡 이름 + 상태 배지 하나, 원곡 권리로) — no new-song item, no song sub-menu, no recent works", () => {
    const g = sidebarModel("/works/wrk_dynamite/stems", work, {}, all);
    expect(g.map((x) => x.label)).toEqual(["작품 관리", "운영 관리"]);
    expect(g[0]!.items.map((i) => i.key)).toEqual(["works-list", "ws"]);
    const ws = find(g, "ws");
    expect(ws.open).toBe(true);
    expect(ws.children).toEqual([{ key: "ws", label: "Dynamite", to: "/works/wrk_dynamite/rights", current: true, badge: { text: "확인 대기", tone: "warn" } }]);
    expect([find(g, "op-c").open, find(g, "op-d").open, find(g, "op-v").open, find(g, "op-s").open, find(g, "op-o").open]).toEqual([true, true, false, false, false]);
  });

  it("badges are to-dos only (orange): no grey count badges", () => {
    const g = sidebarModel("/works/wrk_dynamite/rights", work, { confirmAll: 9, contractsPending: 8, warnings: 2 }, all);
    expect(badges(g)).toEqual([{ text: "확인 대기", tone: "warn" }, { text: "9", tone: "warn" }, { text: "8", tone: "warn" }, { text: "경고 2", tone: "warn" }]);
    expect(badges(sidebarModel("/works", null, { confirmAll: 0 }, all))).toEqual([]);
  });

  it("ops screen: only the group holding the screen is open; the workspace stays open with the song row not current", () => {
    const g = sidebarModel("/ops/validation", work, { warnings: 2 }, all);
    expect([find(g, "op-c").open, find(g, "op-d").open, find(g, "op-v").open, find(g, "op-s").open, find(g, "op-o").open]).toEqual([false, false, true, false, false]);
    expect(find(g, "ws").children[0]!.current).toBe(false);
  });

  it("a closed menu holding the current screen is strong", () => {
    const g = sidebarModel("/works/wrk_dynamite/rights", work, {}, all, { ws: true });
    expect(find(g, "ws").open).toBe(false);
    expect(find(g, "ws").strong).toBe(true);
  });

  it("hides items without permission and has no workspace without an open work", () => {
    const g = sidebarModel("/works", null, {}, (p) => p !== "rights.edit" && p !== "account.manage");
    expect(g.flatMap((x) => x.items).map((i) => i.key)).not.toContain("ws");
    expect(find(g, "op-o").children.map((c) => c.label)).toEqual(["내 조직", "위임 대행", "신탁·유통 연결"]);
  });
});

import { describe, expect, it } from "vitest";
import { activeKey, crumbsFor, sidebarModel, workIdOf } from "./sidebar.ts";

const all = () => true;
const work = { workId: "wrk_dynamite", title: "Dynamite", status: "확인 대기" };
const find = (g: ReturnType<typeof sidebarModel>, key: string) => g.flatMap((x) => x.items).find((i) => i.key === key)!;

describe("권리 테넌트 사이드 메뉴(시안 Sidebar.dc.html)", () => {
  it("maps paths to the active key and the open work", () => {
    expect(activeKey("/works")).toBe("works-list");
    expect(activeKey("/works/new")).toBe("works-new");
    expect(activeKey("/works/wrk_dynamite/stems")).toBe("ws-stems");
    expect(activeKey("/ops/confirmations")).toBe("op-confirm-all");
    expect(activeKey("/")).toBe("op-org");
    expect(workIdOf("/works/wrk_dynamite/stems")).toBe("wrk_dynamite");
    expect(workIdOf("/works/new")).toBeNull();
  });

  it("work screen: workspace and 확인·동의 · 계약·문서 open, others closed; current leaf marked", () => {
    const g = sidebarModel("/works/wrk_dynamite/stems", work, { stems: 154, wsConfirm: 2 }, all);
    const ws = find(g, "ws");
    expect(ws.open).toBe(true);
    expect(ws.work).toEqual({ title: "Dynamite", status: "확인 대기" });
    expect(ws.children.find((c) => c.current)?.label).toBe("스템");
    expect(ws.children.find((c) => c.key === "ws-confirm")?.badge).toEqual({ text: "2", tone: "warn" });
    expect([find(g, "op-c").open, find(g, "op-d").open, find(g, "op-v").open, find(g, "op-s").open, find(g, "op-o").open]).toEqual([true, true, false, false, false]);
  });

  it("ops screen: only the group holding the screen is open; workspace closed and shown strong only if it holds the screen", () => {
    const g = sidebarModel("/ops/validation", work, { warnings: 2 }, all);
    expect([find(g, "op-c").open, find(g, "op-d").open, find(g, "op-v").open, find(g, "op-s").open, find(g, "op-o").open]).toEqual([false, false, true, false, false]);
    expect(find(g, "ws").open).toBe(false);
    expect(find(g, "ws").strong).toBe(false);
    expect(find(g, "op-v").children[0]!.badge).toEqual({ text: "경고 2", tone: "warn" });
  });

  it("a closed menu holding the current screen is strong", () => {
    const g = sidebarModel("/works/wrk_dynamite/rights", work, {}, all, [], { ws: true });
    expect(find(g, "ws").open).toBe(false);
    expect(find(g, "ws").strong).toBe(true);
  });

  it("hides items without permission and has no workspace without an open work", () => {
    const g = sidebarModel("/works", null, { works: 1 }, (p) => p !== "rights.edit" && p !== "account.manage");
    expect(g.flatMap((x) => x.items).map((i) => i.key)).not.toContain("works-new");
    expect(g.flatMap((x) => x.items).map((i) => i.key)).not.toContain("ws");
    expect(find(g, "op-o").children.map((c) => c.label)).toEqual(["내 조직", "위임 대행", "신탁·유통 연결"]);
    expect(find(g, "works-list").badge).toEqual({ text: "1", tone: "gray" });
  });

  it("crumbs", () => {
    expect(crumbsFor("/works/wrk_dynamite/stems", sidebarModel("/works/wrk_dynamite/stems", work, {}, all), "Dynamite")).toEqual(["작품 관리", "작품 워크스페이스", "Dynamite", "스템"]);
    expect(crumbsFor("/ops/confirmations", sidebarModel("/ops/confirmations", null, {}, all))).toEqual(["운영 관리", "확인·동의", "확인 요청 전체"]);
    expect(crumbsFor("/works", sidebarModel("/works", null, {}, all))).toEqual(["작품 관리", "작품 목록"]);
  });
});

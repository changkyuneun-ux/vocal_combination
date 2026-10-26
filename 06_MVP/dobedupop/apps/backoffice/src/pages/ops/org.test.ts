import { describe, expect, it } from "vitest";
import { accountRefOf, usedIn } from "./Org.tsx";
import { progressBlocker } from "../works/tabs/Policy.tsx";

// 우리 당사자(시안 Ops-Org-Parties)·컴파일 조건(2026-10-26, Butter 막힌 곳 5·6·8).
describe("우리 당사자", () => {
  it("쓰인 곳: 곡 이름들, 곡 권리 없이 수령 위임만 있으면 '멤버 n 수령 위임'", () => {
    expect(usedIn({ partyId: "pty_a", partyType: "LABEL", displayName: "L", uses: [{ title: "Dynamite", edge: "CONTROLLED_BY", shareBps: 10000 }, { title: "Butter", edge: "CONTROLLED_BY", shareBps: 10000 }] })).toBe("Dynamite · Butter");
    expect(usedIn({ partyId: "pty_b", partyType: "AGENCY", displayName: "A", uses: [], mandates: 7 })).toBe("멤버 7 수령 위임");
    expect(usedIn({ partyId: "pty_c", partyType: "AUTHOR", displayName: "J", uses: [] })).toBe("—");
  });
  it("지급 계좌는 끝 4자만 보관한다", () => {
    expect(accountRefOf("국민 123-45-6789")).toBe("국민 ****6789");
    expect(accountRefOf("Chase · 000123451234")).toBe("Chase ****1234");
    expect(accountRefOf("110222333444")).toBe("계좌 ****3444");
  });
});

describe("컴파일 조건", () => {
  const steps = (done: boolean[]) => ["원본 계약서", "권리 등록", "권리 확정", "이용 허락", "분배·출시"].map((label, i) => ({ label, done: done[i] ?? false }));
  it("곡 진행 ①~④ 중 끝나지 않은 첫 단계를 이유로 든다", () => {
    expect(progressBlocker(steps([true, true, false, false]))).toBe("③ 권리 확정이 끝나지 않았다");
    expect(progressBlocker(steps([false]))).toBe("① 원본 계약서가 끝나지 않았다");
    expect(progressBlocker(steps([true, true, true, true, false]))).toBeNull();
    expect(progressBlocker(undefined)).toBe("곡 진행을 불러오는 중");
  });
});

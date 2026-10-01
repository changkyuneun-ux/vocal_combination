import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentActor, resetActorForTest, setActor, subscribe } from "./actor.ts";

describe("actor store", () => {
  beforeEach(() => resetActorForTest());
  afterEach(() => vi.unstubAllGlobals());

  it("기본값은 usr_editor", () => {
    expect(currentActor()).toBe("usr_editor");
  });
  it("setActor는 구독자에게 알리고 값을 바꾼다", () => {
    const fn = vi.fn();
    const off = subscribe(fn);
    setActor("usr_settle");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(currentActor()).toBe("usr_settle");
    off();
    setActor("usr_editor");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("localStorage가 던져도 전환된다", () => {
    const boom = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    const fn = vi.fn();
    subscribe(fn);
    setActor("usr_settle");
    expect(fn).toHaveBeenCalled();
    expect(currentActor()).toBe("usr_settle");
  });
});

describe("사용자 전환과 캐시", () => {
  it("setActor는 쿼리를 무효화하지 않는다(키 변경이 새 조회를 일으킨다)", async () => {
    const { queryClient } = await import("./queryClient.ts");
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    resetActorForTest();
    setActor("usr_approver");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

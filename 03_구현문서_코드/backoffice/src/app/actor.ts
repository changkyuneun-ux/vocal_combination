import { useSyncExternalStore } from "react";
import { queryClient } from "./queryClient.ts";

const KEY = "rc.actor";
export const DEFAULT_ACTOR = "usr_editor";

/** 메모리상 현재 값. localStorage가 막혀도 전환이 동작하도록 이 값이 기준이다. */
let current: string | null = null;
const listeners = new Set<() => void>();

export function currentActor(): string {
  if (current === null) {
    try {
      current = localStorage.getItem(KEY) || DEFAULT_ACTOR;
    } catch {
      current = DEFAULT_ACTOR;
    }
  }
  return current;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setActor(id: string): void {
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 저장 실패는 무시한다 */
  }
  for (const fn of [...listeners]) fn();
  void queryClient.invalidateQueries();
}

/** 반응형 현재 사용자. 쿼리 키에 넣어 사용자별 캐시를 분리한다. */
export function useActor(): string {
  return useSyncExternalStore(subscribe, currentActor, currentActor);
}

/** 테스트용: 메모리 값을 비워 다음 읽기에서 localStorage를 다시 본다. */
export function resetActorForTest(): void {
  current = null;
  listeners.clear();
}

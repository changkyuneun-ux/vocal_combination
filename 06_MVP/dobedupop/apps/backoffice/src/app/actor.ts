import { useSyncExternalStore } from "react";
import { currentApp } from "./apps.ts";

/**
 * 개발 서버의 현재 사용자(x-actor). 앱마다 따로 저장한다 — 운영 앱에서 바꾼 사용자 때문에 포털이 플랫폼 계정으로 열리지 않게.
 * 포털은 권리 테넌트 하나로 고정이고 기본 사용자는 빅히트 권리 편집(usr_bh_rights)이다(시안 기준 "총괄 · usr_admin"은 개발 시드에 없다).
 */
const portal = () => currentApp() === "portal";
const keyOf = () => (portal() ? "rc.actor.portal" : "rc.actor");
export const DEFAULT_ACTOR = "usr_editor";
export const PORTAL_DEFAULT_ACTOR = "usr_bh_rights";
const defaultOf = () => (portal() ? PORTAL_DEFAULT_ACTOR : DEFAULT_ACTOR);

/** 메모리상 현재 값. localStorage가 막혀도 전환이 동작하도록 이 값이 기준이다. */
let current: string | null = null;
const listeners = new Set<() => void>();

export function currentActor(): string {
  if (current === null || current === "") {
    try {
      current = localStorage.getItem(keyOf()) || defaultOf();
    } catch {
      current = defaultOf();
    }
  }
  return current;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setActor(id: string): void {
  if (typeof id !== "string" || id === "") return;
  current = id;
  try {
    localStorage.setItem(keyOf(), id);
  } catch {
    /* 저장 실패는 무시한다 */
  }
  for (const fn of [...listeners]) fn();
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

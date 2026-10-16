import { useQuery } from "@tanstack/react-query";
import { api, devApi, sessionMode, type ApiError } from "./client.ts";
import type { ClockState } from "./types.ts";

/** 가상 시계 쿼리 키. 사용자와 무관하다(/api/dev는 x-actor가 없다). 헤더의 전진·지정이 이 키를 무효화한다. */
export const CLOCK_KEY = ["clock", "now"] as const;

/** 가상 시계의 현재 값. 사용자를 바꿔도 값이 사라지지 않고, 헤더의 시계 변경 즉시 갱신된다. */
export function useClock() {
  return useQuery<ClockState, ApiError>({
    queryKey: CLOCK_KEY,
    // 빌드된 앱(로그인 세션)은 개발 도구에 닿지 않는다: 채널의 서버 시각(/clock)을 쓴다. 데모 환경에서는 그것이 가상 시계다.
    queryFn: () => (sessionMode ? api<ClockState>("GET", "/clock") : devApi<ClockState>("GET", "/clock")),
    refetchInterval: 5000,
  });
}

/** 사용자가 고친 값(edit)이 있으면 그것을, 아니면 시계에서 파생한 기본값을 쓴다. */
export function editedOr<T>(edit: T | null | undefined, derived: T): T {
  return edit === null || edit === undefined ? derived : edit;
}

/** 서비스는 현재 시각을 직접 읽지 않고 Clock을 받는다. now()는 밀리초 UTC ISO 문자열이다. */
export type Clock = { now(): string };

export const systemClock: Clock = { now: () => new Date().toISOString() };

/** 테스트·시나리오용: startIso에서 시작해 호출마다 stepMs씩 증가한다(0이면 고정). */
export function fixedClock(startIso: string, stepMs = 1): Clock {
  let t = Date.parse(startIso);
  return {
    now() {
      const s = new Date(t).toISOString();
      t += stepMs;
      return s;
    },
  };
}

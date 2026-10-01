import { queryClient } from "./queryClient.ts";

const KEY = "rc.actor";
const DEFAULT = "usr_editor";

export function currentActor(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function setActor(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 저장 실패는 무시한다 */
  }
  void queryClient.invalidateQueries();
}

import { DomainError } from "./errors.ts";

/** 목록 API 공통 쪽 정보. after는 직전 쪽 마지막 행의 정렬 키(디코딩한 것). */
export type Page = { limit: number; after: unknown[] | undefined };

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** ?limit=(1~200, 기본 50)·?after=(base64url(JSON 배열))를 읽는다. 어긋나면 400 BAD_REQUEST, 깨진 커서는 400 BAD_CURSOR. */
export function parsePage(q: Record<string, unknown>): Page {
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (typeof q.limit !== "string" || !/^[0-9]{1,6}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > MAX_LIMIT) {
      throw new DomainError("BAD_REQUEST", 400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    limit = Number(q.limit);
  }
  if (q.after === undefined) return { limit, after: undefined };
  const bad = () => new DomainError("BAD_CURSOR", 400, "after is not a valid cursor");
  if (typeof q.after !== "string" || q.after === "" || !/^[A-Za-z0-9_-]+$/.test(q.after)) throw bad();
  let key: unknown;
  try { key = JSON.parse(Buffer.from(q.after, "base64url").toString("utf8")); } catch { throw bad(); }
  if (!Array.isArray(key) || key.length === 0) throw bad();
  return { limit, after: key };
}

export function encodeCursor(key: unknown[]): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** 쿼리는 LIMIT page.limit + 1로 읽는다. 초과분이 있으면 잘라 내고 마지막 항목의 키로 next를 만든다. */
export function pageOf<R>(rows: R[], page: Page, key: (r: R) => unknown[]): { items: R[]; next: string | null } {
  if (rows.length <= page.limit) return { items: rows, next: null };
  const items = rows.slice(0, page.limit);
  return { items, next: encodeCursor(key(items[items.length - 1] as R)) };
}

/**
 * 커서 키를 기대한 모양(s 문자열, n 정수, t 시각 ISO)으로 검사해 돌려준다. page.after가 없으면 undefined.
 * 모양이 다르면 400 BAD_CURSOR (DB 형변환 오류로 새지 않게 한다).
 */
export function cursorKey(page: Page, shape: readonly ("s" | "n" | "t")[]): unknown[] | undefined {
  const k = page.after;
  if (k === undefined) return undefined;
  const ok = k.length === shape.length && shape.every((t, i) =>
    t === "s" ? typeof k[i] === "string"
      : t === "n" ? typeof k[i] === "number" && Number.isSafeInteger(k[i])
        : typeof k[i] === "string" && Number.isFinite(Date.parse(k[i] as string)));
  if (!ok) throw new DomainError("BAD_CURSOR", 400, "after does not match this list");
  return k;
}

/** TIMESTAMPTZ → ISO 문자열, NULL → null (응답 변환 보조). */
export const ts = (v: Date | null): string | null => (v === null ? null : v.toISOString());

/** 선택 쿼리 문자열 필터. 없으면 undefined, 문자열이 아니거나 빈 값이면 400 BAD_REQUEST. */
export function optFilter(q: Record<string, unknown>, name: string): string | undefined {
  const v = q[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") throw new DomainError("BAD_REQUEST", 400, `${name} must be a non-empty string`);
  return v;
}

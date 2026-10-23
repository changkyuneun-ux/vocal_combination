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

/** 쪽 번호 방식(3부-A PG1). page가 없으면 null — 그 경로는 기존 커서 방식으로 답한다. */
export type PageNo = { page: number; size: number; offset: number };
const MAX_SIZE = 100;
const DEFAULT_SIZE = 10;

/** ?page=(1 이상)·?size=(1~100, 기본 10). 어긋나면 400 BAD_REQUEST. */
export function parsePageNo(q: Record<string, unknown>): PageNo | null {
  if (q.page === undefined) return null;
  const int = (v: unknown) => (typeof v === "string" && /^[0-9]{1,6}$/.test(v) ? Number(v) : NaN);
  const page = int(q.page);
  if (!(page >= 1)) throw new DomainError("BAD_REQUEST", 400, "page must be an integer of 1 or more");
  const size = q.size === undefined ? DEFAULT_SIZE : int(q.size);
  if (!(size >= 1 && size <= MAX_SIZE)) throw new DomainError("BAD_REQUEST", 400, `size must be an integer between 1 and ${MAX_SIZE}`);
  return { page, size, offset: (page - 1) * size };
}

/** 쪽 번호 응답 { items, page, size, total }. */
export function pageNoResult<R>(items: R[], total: number, p: PageNo): { items: R[]; page: number; size: number; total: number } {
  return { items, page: p.page, size: p.size, total };
}

/** 이미 다 읽은 작은 목록을 쪽으로 자른다(행 수가 곡 하나 범위인 목록). */
export function slicePageNo<R>(rows: R[], p: PageNo): { items: R[]; page: number; size: number; total: number } {
  return pageNoResult(rows.slice(p.offset, p.offset + p.size), rows.length, p);
}

/** ?page가 있으면 다 읽은 목록을 쪽으로, 없으면 그대로(기존 응답). */
export function pagedOr<R>(q: Record<string, unknown>, rows: R[]): R[] | { items: R[]; page: number; size: number; total: number } {
  const p = parsePageNo(q);
  return p === null ? rows : slicePageNo(rows, p);
}
/** 커서 목록 함수를 쪽 번호로 쓸 때 한 번에 다 읽는 쪽 정보. */
export const ALL_ROWS: Page = { limit: 1_000_000, after: undefined };

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

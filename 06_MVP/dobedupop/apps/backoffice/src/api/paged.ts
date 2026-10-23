import { useEffect, useState } from "react";
import { useGet } from "./hooks.ts";

/** 쪽 나눔(3부-A PG1·PG3, 디자인 가이드 5절): 10행 단위. */
export const PAGE_SIZE = 10;
export type PageNoResult<T> = { items: T[]; page: number; size: number; total: number };

/** 곡 단위 작은 목록을 화면에서 쪽으로 나눈다. */
export function paginate<T>(rows: T[], page: number, size = PAGE_SIZE): { rows: T[]; total: number } {
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
}

/** "1–10 / 13" */
export function rangeText(page: number, size: number, total: number): string {
  if (total === 0) return "0 / 0";
  return `${(page - 1) * size + 1}–${Math.min(page * size, total)} / ${total}`;
}

/** 쪽 번호 줄: 7쪽 이하면 전부, 넘으면 처음·끝과 지금 쪽 앞뒤 2쪽, 사이는 "…". */
export function pageNumbers(page: number, pages: number): (number | "…")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  sorted.forEach((p, i) => { if (i > 0 && p - sorted[i - 1]! > 1) out.push("…"); out.push(p); });
  return out;
}

const qs = (params: Record<string, string | number | undefined>) => Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

/** 서버 쪽 번호 목록(?page=&size=). 필터가 바뀌면 1쪽으로 간다. */
export function usePaged<T>(key: string, path: string, opts: { size?: number; filters?: Record<string, string | undefined>; enabled?: boolean } = {}) {
  const size = opts.size ?? PAGE_SIZE;
  const [page, setPage] = useState(1);
  const fkey = JSON.stringify(opts.filters ?? {});
  useEffect(() => { setPage(1); }, [fkey]);
  const url = `${path}${path.includes("?") ? "&" : "?"}${qs({ ...(opts.filters ?? {}), page, size })}`;
  const q = useGet<PageNoResult<T>>([key, url], url, { enabled: opts.enabled ?? true });
  return { rows: q.data?.items ?? [], page, setPage, total: q.data?.total ?? 0, size, isLoading: q.isLoading, error: q.error };
}

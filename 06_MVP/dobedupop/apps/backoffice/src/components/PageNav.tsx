import type { ReactNode } from "react";
import { PAGE_SIZE, pageNumbers, rangeText } from "../api/paged.ts";

/** 쪽 나눔 줄(시안 gen_ops_mockups.py pager(), 디자인 가이드 5절): 범위 · ‹ · 쪽 번호 · ›. 한 쪽뿐이어도 둔다. */
export function PageNav({ page, total, size = PAGE_SIZE, onPage }: { page: number; total: number; size?: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <nav aria-label="쪽" className="p-pager">
      <span className="range">{rangeText(page, size, total)}</span>
      <button type="button" aria-label="이전 쪽" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
      {pageNumbers(page, pages).map((p, i) => p === "…"
        ? <span key={`e${i}`} className="gap">…</span>
        : <button key={p} type="button" aria-current={p === page ? "page" : undefined} onClick={() => onPage(p)}>{p}</button>)}
      <button type="button" aria-label="다음 쪽" disabled={page >= pages} onClick={() => onPage(page + 1)}>›</button>
    </nav>
  );
}

/** 표 카드 맨 아래 줄: 왼쪽 설명, 오른쪽 쪽 나눔. */
export function PagedTableFoot({ note, children }: { note?: ReactNode; children?: ReactNode }) {
  return <div className="p-tfoot"><span className="note">{note}</span>{children}</div>;
}

/** 빈 목록: 표 머리는 그대로, 본문 한 칸에 가운데 정렬 안내. */
export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return <tr className="p-empty"><td colSpan={cols}>{children}</td></tr>;
}

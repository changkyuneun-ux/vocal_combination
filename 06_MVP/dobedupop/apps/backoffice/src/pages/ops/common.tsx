import { useState, type ReactNode } from "react";
import { useGet } from "../../api/hooks.ts";
import type { WorkOverview } from "../../api/works.ts";
import { EmptyRow, PageNav, PagedTableFoot } from "../../components/PageNav.tsx";
import { usePaged } from "../../api/paged.ts";

/**
 * 운영 관리 화면 공통(시안 gen_ops_mockups.py의 page()·stats()·filters()·table()·card()·note()·kv()·badge()).
 * 화면은 이 조각으로만 짠다 — 시안 마크업과 같은 구조·간격. 스타일 v2(2026-10-23). 본문 위 경로 줄은 두지 않는다.
 */
export function OpsPage({ title, desc, actions, children }: { title: string; desc: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="p-main">
      <div className="p-title-row">
        <div><h1>{title}</h1><div className="p-desc">{desc}</div></div>
        <div className="p-row">{actions}</div>
      </div>
      {children}
    </main>
  );
}

export type Stat = { label: string; value: ReactNode; note?: ReactNode; warn?: boolean };
export function Stats({ items }: { items: Stat[] }) {
  return (
    <div className="p-kpis" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((s) => (
        <div key={s.label} className={s.warn ? "p-kpi warn" : "p-kpi"}>
          <div className="l">{s.label}</div><div className="v">{s.value}</div><div className="n">{s.note}</div>
        </div>
      ))}
    </div>
  );
}

export type Opt = [string, string];
/** 검색 줄: 검색 입력 + 선택 상자들. 검색은 서버 필터가 없는 화면에서 비활성(이유 툴팁). 고르기 상자의 첫 값·처음 값은 언제나 '전체'(2026-10-23). */
export function Filters({ placeholder, q, onQ, selects }: { placeholder: string; q?: string; onQ?: (v: string) => void; selects: { name: string; value: string; options: Opt[]; onChange: (v: string) => void }[] }) {
  return (
    <div className="p-row" style={{ gap: 10 }}>
      <label htmlFor="q" className="p-sr">검색</label>
      <input id="q" className="p-input" style={{ flex: "1 1 280px" }} placeholder={placeholder} value={q ?? ""} disabled={onQ === undefined}
        title={onQ === undefined ? "이 목록은 아직 검색어 서버 필터가 없다 — 곡·상태로 고른다" : undefined} onChange={(e) => onQ?.(e.target.value)} />
      {selects.map((s) => (
        <select key={s.name} aria-label={s.name} className="p-select" value={s.value} onChange={(e) => s.onChange(e.target.value)}>
          {s.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ))}
    </div>
  );
}

/** 표 카드(시안 table()): 제목 줄(선택), 표, 맨 아래 설명 + 쪽 나눔. paged=false면 쪽 나눔 줄을 두지 않는다(항목 수가 정해진 표). */
export function TableCard({ cols, children, foot, title, minW = 900, empty, count, page, total, onPage, paged = true, label }: {
  cols: string[]; children: ReactNode; foot?: ReactNode; title?: [string, ReactNode]; minW?: number; empty?: ReactNode; count: number;
  page?: number; total?: number; onPage?: (p: number) => void; paged?: boolean; label?: string;
}) {
  const showPager = paged && page !== undefined && total !== undefined && onPage !== undefined && total > 0;
  return (
    <section className="p-card">
      {title && <div style={{ padding: "16px 18px 12px" }}><CardHead title={title[0]} hint={title[1]} /></div>}
      <div className="p-scroll">
        <table className="p-table ops" style={{ minWidth: minW }} aria-label={label ?? title?.[0]}>
          <thead><tr>{cols.map((c, i) => <th key={`${c}${i}`}>{c}</th>)}</tr></thead>
          <tbody>{count === 0 && empty ? <EmptyRow cols={cols.length}>{empty}</EmptyRow> : children}</tbody>
        </table>
      </div>
      {(foot || showPager) && <PagedTableFoot note={foot}>{showPager && <PageNav page={page!} total={total!} onPage={onPage!} />}</PagedTableFoot>}
    </section>
  );
}

/** 카드 머리(시안 head()): 제목 16px 700 왼쪽, 설명은 제목 옆, 오른쪽 끝에 버튼. */
export function CardHead({ title, hint, right }: { title: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="p-row" style={{ gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--p-fg)" }}>{title}</h2>
      {hint && <span className="p-sub">{hint}</span>}
      {right && <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>{right}</span>}
    </div>
  );
}

export function Card({ title, hint, right, children }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="p-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <CardHead title={title} hint={hint} right={right} />
      {children}
    </section>
  );
}

/** 안내 상자(시안 note()): 옅은 바탕 + 왼쪽 3px 띠(정보 남색, 주의 호박색). */
export function Note({ tone = "blue", children }: { tone?: "blue" | "warn"; children: ReactNode }) {
  return <div role="note" className={tone === "warn" ? "p-note warn" : "p-note"}>{children}</div>;
}

/** 라벨·값 상자(시안 kv()): 라벨 왼쪽(회색) · 값 오른쪽(굵게). */
export function Kv({ pairs }: { pairs: [string, ReactNode][] }) {
  return <dl className="p-kv">{pairs.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export const B = ({ tone = "muted", children }: { tone?: "ok" | "warn" | "bad" | "ir" | "muted" | "blue"; children: ReactNode }) => <span className={`p-badge ${tone}`}>{children}</span>;
export const Mono = ({ children }: { children: ReactNode }) => <span className="p-mono" style={{ whiteSpace: "nowrap" }}>{children}</span>;
export const Sub = ({ main, small }: { main: ReactNode; small?: ReactNode }) => <>{main}{small && <div className="p-table-sub" style={{ marginTop: 2, fontSize: 12.5, fontWeight: 400, color: "var(--p-muted)" }}>{small}</div>}</>;
export const mmdd = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : "—");

/** 곡(범위) → 곡 이름·작품 id. */
export function useScopes() {
  const o = useGet<WorkOverview[]>(["works-overview"], "/works/overview");
  const by = new Map((o.data ?? []).filter((w) => w.scopeId).map((w) => [w.scopeId!, w]));
  const options: Opt[] = [["", "곡 전체"], ...(o.data ?? []).filter((w) => w.scopeId).map((w): Opt => [w.scopeId!, w.title])];
  return { works: o.data ?? [], by, options };
}

/** 엑셀 다운로드(CSV, BOM 붙임 — 엑셀에서 한글이 깨지지 않게). 지금 필터의 전체 행. */
export function CsvButton({ name, head, rows }: { name: string; head: string[]; rows: (string | number)[][] }) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const go = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`\ufeff${[head, ...rows].map((r) => r.map(esc).join(",")).join("\n")}\n`], { type: "text/csv;charset=utf-8" }));
    a.download = `${name}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  return <button type="button" className="p-btn" onClick={go}>엑셀 다운로드</button>;
}

/** 작품 요약 한 줄(GET /work-groups/:kind). scopeId가 null이면 작품 공통(조직 문서). */
export type WorkGroup = { scopeId: string | null; workId: string | null; title: string; sub: string; summary: Record<string, number>; status: [string, "ok" | "warn" | "bad" | "muted"] | null; rules?: string[] };
const groupKey = (g: WorkGroup) => g.scopeId ?? "none";

/**
 * 작품 묶음 표(시안 grouped(), 디자인 가이드 5절, 2026-10-24): 작품마다 요약 한 줄 → 누르면 그 작품 상세만 아래에 펼친다.
 * 한 번에 한 작품, 전체 펼치기 없음. 작품 목록은 서버 쪽 번호(10개), 상세는 detail이 자기 쪽 나눔(10행)을 한다.
 */
export function GroupedTable({ kind, filters, cols, cells, detail, foot, label, minW = 900 }: {
  kind: string; filters?: Record<string, string | undefined>; cols: string[]; cells: (g: WorkGroup) => ReactNode[];
  detail: (g: WorkGroup) => ReactNode; foot?: ReactNode; label: string; minW?: number;
}) {
  const p = usePaged<WorkGroup>(`work-groups-${kind}`, `/work-groups/${kind}`, { filters });
  // 처음에는 첫 작품을 펼친다(시안). 같은 작품을 다시 누르면 접는다.
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const openKey = open === undefined ? (p.rows[0] ? groupKey(p.rows[0]) : null) : open;
  return (
    <section className="p-card">
      <div className="p-scroll">
        <table className="p-table ops p-grouped" style={{ minWidth: minW }} aria-label={label}>
          <thead><tr><th>작품</th>{cols.map((c) => <th key={c}>{c}</th>)}<th /></tr></thead>
          <tbody>
            {p.rows.length === 0 && <EmptyRow cols={cols.length + 2}>{p.isLoading ? "불러오는 중…" : "해당하는 작품이 없습니다."}</EmptyRow>}
            {p.rows.flatMap((g) => {
              const k = groupKey(g), on = k === openKey;
              const toggle = () => setOpen(on ? null : k);
              return [
                <tr key={k} className={on ? "open" : ""}>
                  <td>
                    <button type="button" className="p-group-name" aria-expanded={on} onClick={toggle}><span className="chev" aria-hidden="true">▸</span><span>{g.title}</span></button>
                    {g.sub && <div className="p-group-sub">{g.sub}</div>}
                  </td>
                  {cells(g).map((c, i) => <td key={i}>{c}</td>)}
                  <td style={{ textAlign: "right" }}><button type="button" className="p-linkbtn p-group-act" onClick={toggle}>{on ? "접기" : "상세 보기"}</button></td>
                </tr>,
                ...(on ? [<tr key={`${k}-d`} className="p-group-detail"><td colSpan={cols.length + 2}><div role="region" aria-label={`${g.title} 상세`} className="p-group-inner">{detail(g)}</div></td></tr>] : []),
              ];
            })}
          </tbody>
        </table>
      </div>
      <PagedTableFoot note={foot ?? "작품을 누르면 그 작품 상세만 펼친다. 한 번에 한 작품씩."}><PageNav page={p.page} total={p.total} onPage={p.setPage} /></PagedTableFoot>
    </section>
  );
}

/** 펼친 작품의 상세 표(안쪽 표 13.5px, 10행 쪽 나눔). 행이 없으면 안내 한 줄. */
export function GroupDetail({ cols, count, children, page, total, onPage, note, empty, paged = true }: {
  cols: string[]; count: number; children: ReactNode; page?: number; total?: number; onPage?: (p: number) => void; note?: ReactNode; empty?: ReactNode; paged?: boolean;
}) {
  if (count === 0) return <div className="p-group-empty">{empty ?? "해당 항목이 없습니다."}</div>;
  return (
    <>
      <div className="p-scroll"><table className="p-table p-inner"><thead><tr>{cols.map((c, i) => <th key={`${c}${i}`}>{c}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
      {(note || (paged && page !== undefined)) && (
        <div className="p-inner-foot"><span style={{ flex: "1 1 auto" }}>{note}</span>{paged && page !== undefined && <PageNav page={page} total={total ?? 0} onPage={onPage!} />}</div>
      )}
    </>
  );
}

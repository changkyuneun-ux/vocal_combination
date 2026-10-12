import type { ReactNode } from "react";

export type Column<T> = { key: string; label: string; render?: (row: T) => ReactNode };

export function DataTable<T>({ columns, rows, empty }: { columns: Column<T>[]; rows: T[]; empty?: string }) {
  if (rows.length === 0) return <p className="muted">{empty ?? "데이터가 없습니다."}</p>;
  return (
    <table className="data">
      <thead><tr>{columns.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

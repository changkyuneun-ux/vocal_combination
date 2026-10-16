import { ApiError } from "../api/client.ts";
import { DataTable } from "./DataTable.tsx";

const str = (v: unknown) => (v === undefined || v === null ? "—" : typeof v === "string" ? v : JSON.stringify(v));

/** 백엔드 diagnostics를 표로 보여 준다(없으면 아무것도 그리지 않는다). */
export function Diagnostics({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || error.diagnostics.length === 0) return null;
  const rows = error.diagnostics.map((d) => (d ?? {}) as Record<string, unknown>);
  return (
    <DataTable rows={rows}
      columns={[
        { key: "code", label: "코드", render: (r) => str(r.code) },
        { key: "message", label: "메시지", render: (r) => str(r.message) },
        { key: "path", label: "위치", render: (r) => str(r.path ?? r.line ?? r.location ?? r.stem ?? r.role) },
      ]} />
  );
}

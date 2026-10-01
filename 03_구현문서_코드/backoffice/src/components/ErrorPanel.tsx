import { ApiError } from "../api/client.ts";

export function ErrorPanel({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    return (
      <div className="error-panel" role="alert">
        <strong>{error.code}</strong> {error.message}
        {error.diagnostics.length > 0 && (
          <details><summary>diagnostics</summary><pre>{JSON.stringify(error.diagnostics, null, 2)}</pre></details>
        )}
      </div>
    );
  }
  return <div className="error-panel" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
}

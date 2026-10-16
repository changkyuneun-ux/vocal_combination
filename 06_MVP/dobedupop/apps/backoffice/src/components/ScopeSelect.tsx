import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { useGet } from "../api/hooks.ts";

/** 선택한 facts 범위 id를 `?scope=`에 둔다(화면 간 공유). */
export function useScopeParam(): [string, (v: string) => void] {
  const [sp, setSp] = useSearchParams();
  return [sp.get("scope") ?? "", (v) => setSp(v ? { scope: v } : {}, { replace: true })];
}

type ScopeRow = { factsScopeId: string; workId: string; title: string };

/** 곡 선택: 내가 볼 수 있는 곡(테넌트는 자기 곡) 중에서 고른다. 아직 고르지 않았으면 첫 곡을 고른다. */
export function ScopeSelect({ scope, onChange }: { scope: string; onChange: (v: string) => void }) {
  const list = useGet<ScopeRow[]>(["scopes"], "/scopes");
  const rows = list.data ?? [];
  useEffect(() => { if (scope === "" && rows.length > 0) onChange(rows[0]!.factsScopeId); }, [scope, rows.length]);
  return (
    <div className="inline-form">
      <label className="field"><span>곡</span>
        <select aria-label="곡 선택" value={scope} onChange={(e) => onChange(e.target.value)}>
          {scope !== "" && !rows.some((r) => r.factsScopeId === scope) && <option value={scope}>{scope}</option>}
          {rows.length === 0 && scope === "" && <option value="">등록된 곡이 없습니다</option>}
          {rows.map((r) => <option key={r.factsScopeId} value={r.factsScopeId}>{r.title} ({r.factsScopeId})</option>)}
        </select>
      </label>
    </div>
  );
}

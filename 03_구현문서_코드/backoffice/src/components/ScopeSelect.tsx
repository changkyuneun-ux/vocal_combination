import { useState } from "react";
import { useSearchParams } from "react-router";

/** 선택한 facts 범위 id를 `?scope=`에 둔다(화면 간 공유). */
export function useScopeParam(): [string, (v: string) => void] {
  const [sp, setSp] = useSearchParams();
  return [sp.get("scope") ?? "", (v) => setSp(v ? { scope: v } : {}, { replace: true })];
}

export function ScopeSelect({ scope, onChange }: { scope: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(scope);
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); onChange(draft.trim()); }}>
      <label className="field"><span>facts 범위 id</span>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="fsc_nova_summer" />
      </label>
      <button type="submit" className="btn">범위 선택</button>
    </form>
  );
}

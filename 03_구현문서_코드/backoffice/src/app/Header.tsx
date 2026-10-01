import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currentActor, setActor } from "./actor.ts";
import { devApi, ApiError } from "../api/client.ts";
import { useAction, useGet } from "../api/hooks.ts";
import type { ClockState, UserRow } from "../api/types.ts";
import { violations, type InvariantReport } from "../api/invariants.ts";
import { ErrorPanel } from "../components/ErrorPanel.tsx";

const HOUR = 3_600_000;
const STEPS: { label: string; ms: number }[] = [
  { label: "+1시간", ms: HOUR }, { label: "+1일", ms: 24 * HOUR }, { label: "+3일", ms: 72 * HOUR }, { label: "+30일", ms: 720 * HOUR },
];

/** "2026-01-01T00:00:00.000Z" → "2026-01-01 00:00 UTC" */
function clockText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function VirtualClock({ onError }: { onError: (e: ApiError) => void }) {
  const qc = useQueryClient();
  const clock = useGet<ClockState>(["clock"], "/dev/clock", { refetchInterval: 5000 });
  const [custom, setCustom] = useState("");
  const [picking, setPicking] = useState(false);
  const done = () => { void qc.invalidateQueries(); };
  const advance = useAction((ms: number) => devApi<{ now: string }>("POST", "/clock/advance", { ms }), ["clock"]);
  const setAt = useAction((at: string) => devApi<{ now: string }>("POST", "/clock/set", { at }), ["clock"]);
  const run = (m: typeof advance | typeof setAt, v: never) => m.mutate(v, { onSuccess: done, onError });
  return (
    <div className="clock" aria-label="가상 시계">
      <strong className="clock-now" data-testid="clock-now">{clock.data ? clockText(clock.data.now) : "—"}</strong>
      {STEPS.map((s) => <button key={s.label} className="btn" onClick={() => run(advance, s.ms as never)}>{s.label}</button>)}
      {picking ? (
        <>
          <input type="datetime-local" step={1} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="지정 시각(UTC)" />
          <button className="btn primary" disabled={!custom} onClick={() => { run(setAt, new Date(`${custom}Z`).toISOString() as never); setPicking(false); }}>적용</button>
          <button className="btn" onClick={() => setPicking(false)}>취소</button>
        </>
      ) : <button className="btn" onClick={() => setPicking(true)}>지정…</button>}
    </div>
  );
}

function InvariantBadge() {
  const [open, setOpen] = useState(false);
  const q = useGet<InvariantReport>(["invariants"], "/settlement/invariants", { refetchInterval: 10000, api: { actorOverride: "usr_settle" } });
  if (q.error) return <span className="badge muted" title={q.error.message}>점검 불가</span>;
  if (!q.data) return <span className="badge muted">점검 중…</span>;
  const v = violations(q.data);
  if (v.length === 0) return <span className="badge ok" data-testid="invariants-badge">점검 정상</span>;
  return (
    <>
      <button className="badge bad" data-testid="invariants-badge" onClick={() => setOpen(!open)}>점검 위반 {v.length}</button>
      {open && (
        <div className="popover" role="dialog" aria-label="위반 항목">
          <h4>위반 항목</h4>
          <ul>{v.map((x) => <li key={x.key}><strong>{x.label}</strong><br /><span className="muted">{x.detail}</span></li>)}</ul>
        </div>
      )}
    </>
  );
}

export function Header() {
  const [toast, setToast] = useState<ApiError | null>(null);
  const users = useGet<{ items: UserRow[] }>(["users"], "/users");
  const actor = currentActor();
  const rows = users.data?.items ?? [];
  const known = rows.some((u) => u.userId === actor);
  return (
    <header className="header">
      <div className="app-name">VCRL 검증 백오피스</div>
      <VirtualClock onError={setToast} />
      <div className="right">
        <label>사용자{" "}
          <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="사용자 전환">
            {!known && <option value={actor}>{actor}</option>}
            {rows.map((u) => <option key={u.userId} value={u.userId}>{u.displayName} ({u.roles.join(", ")})</option>)}
          </select>
        </label>
        <InvariantBadge />
      </div>
      {toast && (
        <div className="toast" role="alert">
          <ErrorPanel error={toast} />
          <button className="btn tiny" onClick={() => setToast(null)}>닫기</button>
        </div>
      )}
    </header>
  );
}

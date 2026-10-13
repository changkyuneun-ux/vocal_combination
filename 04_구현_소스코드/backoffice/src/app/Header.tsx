import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_ACTOR, setActor, useActor } from "./actor.ts";
import { useClock } from "../api/clock.ts";
import { devApi, ApiError } from "../api/client.ts";
import { useAction, useGet } from "../api/hooks.ts";
import type { UserRow } from "../api/types.ts";
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
  const clock = useClock();
  const [custom, setCustom] = useState("");
  const [picking, setPicking] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const done = () => { void qc.invalidateQueries(); };
  const advance = useAction((ms: number) => devApi<{ now: string }>("POST", "/clock/advance", { ms }), ["clock"]);
  const setAt = useAction((at: string) => devApi<{ now: string }>("POST", "/clock/set", { at }), ["clock"]);
  const doAdvance = (ms: number) => advance.mutate(ms, { onSuccess: done, onError });
  const doSet = (at: string) => setAt.mutate(at, { onSuccess: done, onError });
  const apply = () => {
    const t = new Date(`${custom}Z`);
    if (Number.isNaN(t.getTime())) { setInvalid(true); return; }
    setInvalid(false);
    doSet(t.toISOString());
    setPicking(false);
  };
  const busy = advance.isPending || setAt.isPending;
  return (
    <div className="clock" aria-label="가상 시계">
      <strong className="clock-now" data-testid="clock-now">{clock.data ? clockText(clock.data.now) : "—"}</strong>
      {STEPS.map((s) => <button key={s.label} className="btn" disabled={busy} onClick={() => doAdvance(s.ms)}>{s.label}</button>)}
      {picking ? (
        <>
          <input type="datetime-local" step={1} value={custom} onChange={(e) => { setCustom(e.target.value); setInvalid(false); }} aria-label="지정 시각(UTC)" />
          <button className="btn primary" disabled={!custom || busy} onClick={apply}>적용</button>
          {invalid && <span role="alert" className="muted">올바른 시각이 아닙니다.</span>}
          <button className="btn" disabled={busy} onClick={() => setPicking(false)}>취소</button>
        </>
      ) : <button className="btn" disabled={busy} onClick={() => setPicking(true)}>지정…</button>}
    </div>
  );
}

function InvariantBadge() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const q = useGet<InvariantReport>(["invariants"], "/settlement/invariants", { refetchInterval: 10000, api: { actorOverride: "usr_settle" } });
  if (q.error) return <span className="badge muted" title={`${q.error.message} (정산 담당(usr_settle) 신원으로 조회)`}>점검 불가</span>;
  if (!q.data) return <span className="badge muted">점검 중…</span>;
  const v = violations(q.data);
  if (v.length === 0) return <span className="badge ok" data-testid="invariants-badge" title="정산 담당(usr_settle) 신원으로 조회">점검 정상</span>;
  return (
    <span ref={ref} className="badge-wrap">
      <button className="badge bad" data-testid="invariants-badge" title="정산 담당(usr_settle) 신원으로 조회" onClick={() => setOpen(!open)}>점검 위반 {v.length}</button>
      {open && (
        <div className="popover" role="dialog" aria-label="위반 항목">
          <h4>위반 항목</h4>
          <ul>{v.map((x) => <li key={x.key}><strong>{x.label}</strong><br /><span className="muted">{x.detail}</span></li>)}</ul>
        </div>
      )}
    </span>
  );
}

export function Header() {
  const [toast, setToast] = useState<ApiError | null>(null);
  const users = useGet<{ items: UserRow[] }>(["users"], "/users");
  const actor = useActor();
  // 저장된 사용자가 없어졌거나 비정상이면 /users가 UNKNOWN_ACTOR(401)로 실패한다. 기본 사용자로 한 번 복구한다.
  const usersError = users.error;
  useEffect(() => {
    if (usersError instanceof ApiError && (usersError.code === "UNKNOWN_ACTOR" || usersError.status === 401) && actor !== DEFAULT_ACTOR) {
      setActor(DEFAULT_ACTOR);
    }
  }, [usersError, actor]);
  const rows = users.data?.items ?? [];
  const known = rows.some((u) => u.userId === actor);
  return (
    <header className="header">
      <div className="app-name">dobedupop · MDRL 검증 백오피스</div>
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

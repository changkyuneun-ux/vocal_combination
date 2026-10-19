import { useEffect, useState } from "react";
import { appUrl, PERSONAS, STEP_VIEW } from "./links.ts";

type Step = { id: string; title: string; detail: string; persona: string; app: string; status: "todo" | "running" | "done" | "failed"; error?: string; startedAt?: string; finishedAt?: string };
type View = { clock: string | null; running: boolean; notice: string | null; next: string | null; steps: Step[]; summary: Record<string, unknown> };

const STATUS: Record<Step["status"], string> = { todo: "대기", running: "실행 중", done: "완료", failed: "실패" };

async function call(method: "GET" | "POST", path: string): Promise<View> {
  const r = await fetch(`/api/demo${path}`, { method, headers: { "x-dbp-csrf": "1" } });
  const body = await r.json();
  if (!r.ok && r.status !== 202) throw new Error(body.message ?? body.code ?? `HTTP ${r.status}`);
  return body as View;
}

/**
 * 데모 진행판(MVP 진행계획 M5): Dynamite 2차 이용을 단계별로 실행하고, 각 단계를 보여 줄 앱을 그 페르소나로 바로 연다.
 * 데이터는 공개 API로 들어가므로(정책·검증을 그대로 통과) 앱 화면에 보이는 것이 실제 처리 결과다.
 */
export function App() {
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const load = () => call("GET", "/steps").then((v) => { setView(v); setErr(""); }, (e) => setErr(String(e.message ?? e)));
  useEffect(() => { void load(); const t = setInterval(() => void load(), 2000); return () => clearInterval(t); }, []);
  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try { setView(await call("POST", path)); setErr(""); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const done = view?.steps.filter((s) => s.status === "done").length ?? 0;
  return (
    <>
    <div className="bar"><strong>dobedupop · 데모 진행판</strong><span className="host">{location.host} · 데모 환경에서만 배포</span></div>
    <div className="page">
      <header className="top">
        <div>
          <h1>Dynamite 2차 이용 시연</h1>
          <p className="muted">BTS "Dynamite" 2차 이용(가상 사례 — 곡 크레딧·멤버만 실제, 지분·계약·가격·판매량은 가정)</p>
        </div>
        <div className="controls">
          <span className="clock" aria-label="가상 시계">가상 시계 {view?.clock ? view.clock.replace("T", " ").slice(0, 16) : "—"}</span>
          <button onClick={() => void act("/run-all")} disabled={!view || view.running || view.next === null || view.notice !== null}>남은 단계 모두 실행</button>
          <button className="danger" onClick={() => void act("/reset", "데모 데이터를 모두 지우고 처음부터 시작합니다. 계속할까요?")} disabled={view?.running}>처음부터 다시</button>
        </div>
      </header>
      {err && <p className="err" role="alert">{err}</p>}
      {view?.notice && <p className="warn" role="status">{view.notice}</p>}
      <main className="grid">
        <section aria-label="시연 단계">
          <h2>시연 단계 <span className="muted small">{done} / {view?.steps.length ?? 0} 완료</span></h2>
          <ol className="steps">
            {view?.steps.map((s, i) => (
              <li key={s.id} className={`step ${s.status}`} data-step={s.id}>
                <div className="step-head">
                  <span className="num">{i + 1}</span>
                  <strong>{s.title}</strong>
                  <span className={`badge ${s.status}`}>{STATUS[s.status]}</span>
                </div>
                <p className="small">{s.detail}</p>
                <p className="muted small">페르소나: {s.persona}</p>
                {s.error && <pre className="err small">{s.error}</pre>}
                <div className="actions">
                  {view.next === s.id && <button className="primary" disabled={view.running || view.notice !== null} onClick={() => void act(`/steps/${s.id}/run`)}>실행</button>}
                  {(STEP_VIEW[s.id] ?? []).map((v) => (
                    <a key={v.label} className="btn" href={appUrl(location, v.app, v.persona, v.path)} target="_blank" rel="noreferrer">{v.label}</a>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
        <aside>
          <h2>페르소나로 앱 열기</h2>
          <p className="muted small">데모 환경에만 있는 빠른 로그인입니다. 새 탭에서 그 사람으로 로그인된 앱이 열립니다.</p>
          <ul className="personas">
            {PERSONAS.map((p) => (
              <li key={p.userId}>
                <a href={appUrl(location, p.app, p.userId)} target="_blank" rel="noreferrer"><strong>{p.name}</strong> <span className="muted small">{p.app === "portal" ? "권리자 포털" : p.app === "artist" ? "실연자 앱" : p.app === "partner" ? "참여 기관" : "운영 백오피스"}</span></a>
                <div className="muted small">{p.what}</div>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
    </>
  );
}

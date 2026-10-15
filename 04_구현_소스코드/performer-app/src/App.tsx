import { useCallback, useEffect, useState } from "react";
import { api, ApiError, currentUser, setUser, type Claim, type Consent, type Me, type Notice, type Objection, type Statement, type Usage, type Voice } from "./api.ts";
import { EDGE_LABEL, KIND_LABEL, newConsentId, revocable, won, yearPeriod } from "./logic.ts";

type Tab = "consents" | "usage" | "money" | "objections" | "notifications";
const TABS: { id: Tab; label: string }[] = [
  { id: "consents", label: "동의" }, { id: "usage", label: "사용" }, { id: "money", label: "수익" }, { id: "objections", label: "이의제기" }, { id: "notifications", label: "알림" },
];
const FAN_APP_SCOPE = { actions: ["PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] };

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: ApiError | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [n, setN] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  useEffect(() => { run().then((d) => { setData(d); setError(null); }, (e: ApiError) => setError(e)); }, [run, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

function Err({ e }: { e: unknown }) {
  if (!e) return null;
  const a = e as ApiError;
  return <p className="err" role="alert">{a.code ? `${a.code}: ` : ""}{a.message}</p>;
}

/** 로그인(개발용): 실연자 계정 id. 운영은 본인 인증 기반 로그인으로 바꾼다. */
function Login({ onLogin }: { onLogin: (id: string) => void }) {
  const [id, setId] = useState("usr_singer_a");
  const [err, setErr] = useState<unknown>(null);
  const go = async () => {
    try { await api<Me>("GET", "/me", undefined, id.trim()); setUser(id.trim()); onLogin(id.trim()); } catch (e) { setErr(e); }
  };
  return (
    <main className="screen center">
      <h1>실연자</h1>
      <p className="muted">내 보이스가 어디에 쓰이는지 보고, 동의하고, 수익을 확인합니다.</p>
      <label className="field">계정<input aria-label="계정 id" value={id} onChange={(e) => setId(e.target.value)} /></label>
      <button className="primary" onClick={() => void go()}>들어가기</button>
      <Err e={err} />
    </main>
  );
}

/** 본인 인증: 코드를 받아 입력한다. 개발 서버는 코드를 화면에 보여 준다(운영은 문자·PASS로 받는다). */
function Identity({ onDone }: { onDone: () => void }) {
  const [challenge, setChallenge] = useState<{ challengeId: number; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const start = async () => { try { setChallenge(await api("POST", "/identity/start", {})); setErr(null); } catch (e) { setErr(e); } };
  const confirm = async () => {
    try {
      const r = await api<{ verified: boolean; attemptsLeft: number }>("POST", "/identity/confirm", { challengeId: challenge!.challengeId, code });
      if (r.verified) onDone(); else setMsg(`코드가 맞지 않습니다. 남은 시도 ${r.attemptsLeft}회`);
    } catch (e) { setErr(e); }
  };
  return (
    <main className="screen center">
      <h1>본인 인증</h1>
      <p className="muted">동의 서명은 본인만 할 수 있어 먼저 본인 인증을 합니다.</p>
      {challenge === null ? <button className="primary" onClick={() => void start()}>인증 코드 받기</button> : (
        <>
          {challenge.devCode && <p className="dev" data-testid="dev-code">개발용 코드: {challenge.devCode}</p>}
          <label className="field">인증 코드<input aria-label="인증 코드" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="primary" disabled={code.length !== 6} onClick={() => void confirm()}>확인</button>
          {msg && <p className="err">{msg}</p>}
        </>
      )}
      <Err e={err} />
    </main>
  );
}

function Consents() {
  const voices = useLoad(() => api<Voice[]>("GET", "/voices"), []);
  const consents = useLoad(() => api<Consent[]>("GET", "/consents"), []);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const reload = () => { voices.reload(); consents.reload(); };
  const sign = async (v: Voice) => {
    try { await api("POST", "/consents", { consentId: newConsentId(v.voiceId, Date.now()), factsScopeId: v.factsScopeId, assetId: v.voiceId, scope: FAN_APP_SCOPE }); setErr(null); reload(); } catch (e) { setErr(e); }
  };
  const revoke = async (c: Consent) => {
    try { await api("POST", `/consents/${encodeURIComponent(c.consentId)}/revoke`, { reason }); setRevoking(null); setReason(""); setErr(null); reload(); } catch (e) { setErr(e); }
  };
  return (
    <section>
      <p className="muted">동의 범위: 팬 앱에서 미리듣기·조합·소장·링크 공유, 한국, 팬 커뮤니티, 1년. 철회하면 이 보이스를 쓰는 새 조합은 발행되지 않습니다.</p>
      <Err e={voices.error ?? consents.error ?? err} />
      {voices.data?.length === 0 && <p className="muted">등록된 내 보이스가 없습니다.</p>}
      {voices.data?.map((v) => {
        const c = revocable(v, consents.data ?? []);
        return (
          <article key={v.voiceId} className="card" data-voice={v.voiceId}>
            <div className="row"><strong>{v.title}</strong><span className={`badge ${v.consent.toLowerCase()}`}>{v.consent === "SIGNED" ? "동의함" : v.consent === "REVOKED" ? "철회함" : "동의 전"}</span></div>
            <p className="muted small">보이스 {v.voiceId}</p>
            {v.consent !== "SIGNED" && <button className="primary" onClick={() => void sign(v)}>동의하기</button>}
            {v.consent === "SIGNED" && c && (revoking === c.consentId ? (
              <div className="stack">
                <textarea aria-label="철회 사유" placeholder="철회 사유" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="danger" disabled={reason.trim() === ""} onClick={() => void revoke(c)}>철회 확정</button>
                <button onClick={() => setRevoking(null)}>취소</button>
              </div>
            ) : <button onClick={() => setRevoking(c.consentId)}>철회하기</button>)}
          </article>
        );
      })}
    </section>
  );
}

function UsageTab() {
  const q = useLoad(() => api<Usage[]>("GET", "/usages"), []);
  return (
    <section>
      <Err e={q.error} />
      {q.data?.length === 0 && <p className="muted">아직 내 스템이 쓰인 조합이 없습니다.</p>}
      {q.data?.map((u) => (
        <article key={`${u.snapshotId}-${u.slotId}`} className="card" data-usage={u.vcId}>
          <div className="row"><strong>{u.vcId}</strong><span className="muted small">{u.issuedAt.slice(0, 10)}</span></div>
          <p className="small">{u.slotId} 파트 · {(u.durationMs / 1000).toFixed(1)}초 · 스템 {u.stemId}</p>
        </article>
      ))}
    </section>
  );
}

function Money() {
  const p = yearPeriod(new Date().toISOString());
  const q = useLoad(() => api<Statement>("GET", `/statements?from=${p.from}&to=${p.to}`), []);
  const s = q.data;
  return (
    <section>
      <Err e={q.error} />
      {s && (
        <article className="card">
          <h2>{p.from.slice(0, 4)}년 명세</h2>
          <dl className="kv">
            <dt>정산</dt><dd>{won(s.settled)}</dd>
            <dt>환불 역분개</dt><dd>{won(s.reversed)}</dd>
            <dt>보류 해제</dt><dd>{won(s.holdReleased)}</dd>
            <dt>실지급</dt><dd>{won(s.payoutNet)}</dd>
            <dt>미지급 잔액</dt><dd data-testid="closing">{won(s.closing)}</dd>
          </dl>
          <p className="muted small">소속사에 실연 권리를 위임했다면 실연 몫은 소속사가 받고, 여기에는 본인이 직접 받는 금액만 나옵니다.</p>
        </article>
      )}
    </section>
  );
}

function Objections() {
  const claims = useLoad(() => api<Claim[]>("GET", "/claims"), []);
  const mine = useLoad(() => api<Objection[]>("GET", "/objections"), []);
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    try { await api("POST", "/objections", { claimId: target, reason }); setTarget(null); setReason(""); setErr(null); mine.reload(); claims.reload(); } catch (e) { setErr(e); }
  };
  return (
    <section>
      <h2>나와 관련된 권리 주장</h2>
      <Err e={claims.error ?? err} />
      {claims.data?.map((c) => (
        <article key={c.claimId} className="card" data-claim={c.claimId}>
          <div className="row"><strong>{c.title}</strong><span className="badge">{EDGE_LABEL[c.edge] ?? c.edge}</span></div>
          <p className="small">{c.sourceId} → {c.targetId} · {(c.shareBps / 100).toFixed(0)}% · {c.status}</p>
          {target === c.claimId ? (
            <div className="stack">
              <textarea aria-label="이의 사유" placeholder="무엇이 틀렸는지 적어 주세요(5자 이상)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="danger" disabled={reason.trim().length < 5} onClick={() => void submit()}>이의제기 제출</button>
              <button onClick={() => setTarget(null)}>취소</button>
            </div>
          ) : c.status !== "DISPUTED" && <button onClick={() => setTarget(c.claimId)}>이의제기</button>}
        </article>
      ))}
      <h2>내 이의제기</h2>
      <Err e={mine.error} />
      {mine.data?.length === 0 && <p className="muted">제출한 이의제기가 없습니다.</p>}
      {mine.data?.map((o) => (
        <article key={o.disputeId} className="card" data-objection={o.disputeId}>
          <div className="row"><strong>{o.claimId}</strong><span className={`badge ${o.status === "OPEN" ? "open" : ""}`}>{o.status === "OPEN" ? "검토 중" : "종결"}</span></div>
          <p className="small">{o.reason}</p>
        </article>
      ))}
    </section>
  );
}

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

function Notifications({ onRead }: { onRead: () => void }) {
  const q = useLoad(() => api<Notice[]>("GET", "/notifications"), []);
  const [pushMsg, setPushMsg] = useState("");
  const enablePush = async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setPushMsg("이 브라우저는 푸시 알림을 지원하지 않습니다."); return; }
      if ((await Notification.requestPermission()) !== "granted") { setPushMsg("알림 권한이 없습니다."); return; }
      const { publicKey } = await api<{ publicKey: string }>("GET", "/push/vapid-key");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
      await api("POST", "/push/subscriptions", sub.toJSON());
      setPushMsg("이 기기에서 푸시 알림을 받습니다.");
    } catch (e) { setPushMsg(`푸시 등록 실패: ${(e as Error).message}`); }
  };
  const read = async (n: Notice) => { if (!n.read) { await api("POST", `/notifications/${n.notificationId}/read`, {}); q.reload(); onRead(); } };
  return (
    <section>
      <button onClick={() => void enablePush()}>푸시 알림 받기</button>
      {pushMsg && <p className="muted small">{pushMsg}</p>}
      <Err e={q.error} />
      {q.data?.length === 0 && <p className="muted">알림이 없습니다.</p>}
      {q.data?.map((n) => (
        <article key={n.notificationId} className={`card ${n.read ? "" : "unread"}`} data-notice={n.kind} onClick={() => void read(n)}>
          <div className="row"><strong>{n.title}</strong><span className="badge">{KIND_LABEL[n.kind] ?? n.kind}</span></div>
          <p className="small">{n.body}</p>
          <p className="muted small">{n.createdAt.slice(0, 16).replace("T", " ")}</p>
        </article>
      ))}
    </section>
  );
}

export function App() {
  const [user, setUserState] = useState<string | null>(currentUser());
  const me = useLoad(() => (user ? api<Me>("GET", "/me") : Promise.resolve(undefined)), [user]);
  const initial = (new URLSearchParams(location.search).get("tab") as Tab | null) ?? "consents";
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === initial) ? initial : "consents");
  const unread = useLoad(() => (user && me.data?.identityVerified ? api<Notice[]>("GET", "/notifications").then((l) => l.filter((n) => !n.read).length) : Promise.resolve(0)), [user, me.data?.identityVerified, tab]);
  if (!user) return <Login onLogin={setUserState} />;
  if (me.error) return <main className="screen center"><Err e={me.error} /><button onClick={() => { setUser(null); setUserState(null); }}>다시 로그인</button></main>;
  if (!me.data) return <main className="screen center"><p className="muted">불러오는 중…</p></main>;
  if (!me.data.identityVerified) return <Identity onDone={me.reload} />;
  return (
    <div className="app">
      <header className="top">
        <div><strong>{me.data.displayName}</strong><span className="muted small"> 본인 인증됨</span></div>
        <button className="link" onClick={() => { setUser(null); setUserState(null); }}>나가기</button>
      </header>
      <main className="screen">
        {tab === "consents" && <Consents />}
        {tab === "usage" && <UsageTab />}
        {tab === "money" && <Money />}
        {tab === "objections" && <Objections />}
        {tab === "notifications" && <Notifications onRead={unread.reload} />}
      </main>
      <nav className="tabs" aria-label="탭">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            {t.label}{t.id === "notifications" && (unread.data ?? 0) > 0 && <span className="dot" aria-label={`읽지 않은 알림 ${unread.data}개`}>{unread.data}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

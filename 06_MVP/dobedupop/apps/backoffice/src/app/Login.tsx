import { useEffect, useState } from "react";
import { authApi, type ApiError } from "../api/client.ts";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { APPS, currentApp } from "./apps.ts";

type Config = { method: string; mfa: "REQUIRED" | "OPTIONAL" | "NONE"; devLogin: boolean; personas: { userId: string; displayName: string; roles: string[] }[] };
type LoginReply = { status: "OK" } | { status: "MFA_REQUIRED" } | { status: "MFA_ENROLL"; secret: string; otpauthUrl: string };

/**
 * 로그인(MVP 진행계획 M3, 결정 MD3): 운영 백오피스는 비밀번호 + 인증 앱 코드(TOTP, 처음 로그인할 때 등록), 권리자 포털은 비밀번호
 * (인증 앱을 켠 계정은 코드도). 초대 링크(?invite=)로 들어오면 비밀번호를 정한다. 데모 환경에서는 페르소나로 바로 들어갈 수 있다.
 */
export function LoginPage({ onDone }: { onDone: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"login" | "code" | "enroll">("login");
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const invite = new URLSearchParams(location.search).get("invite");
  useEffect(() => { authApi<Config>("GET", "/config").then(setConfig, (e) => setErr(e as ApiError)); }, []);

  const login = async () => {
    try {
      const r = await authApi<LoginReply>("POST", "/login", { userId, password, ...(step !== "login" && { totp: code }) });
      setErr(null);
      if (r.status === "OK") return onDone();
      if (r.status === "MFA_REQUIRED") setStep("code");
      else { setEnroll({ secret: r.secret, otpauthUrl: r.otpauthUrl }); setStep("enroll"); }
      setCode("");
    } catch (e) { setErr(e as ApiError); }
  };
  const accept = async () => {
    try {
      await authApi("POST", "/invite/accept", { token: invite, password });
      setErr(null); setPassword("");
      setNotice("비밀번호를 정했습니다. 아이디와 새 비밀번호로 로그인하세요.");
      history.replaceState(null, "", location.pathname);
    } catch (e) { setErr(e as ApiError); }
  };
  const persona = async (id: string) => {
    try { await authApi("POST", "/dev-login", { userId: id }); onDone(); } catch (e) { setErr(e as ApiError); }
  };

  return (
    <main className="login">
      <section className="login-card">
        <h1>{APPS[currentApp()].name}</h1>
        {notice && <p role="status">{notice}</p>}
        <ErrorPanel error={err} />
        {invite !== null && !notice ? (
          <form onSubmit={(e) => { e.preventDefault(); void accept(); }}>
            <p className="muted">초대받은 계정의 비밀번호를 정합니다(10자 이상).</p>
            <label className="field"><span>새 비밀번호</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button className="btn primary" type="submit" disabled={password.length < 10}>비밀번호 정하기</button>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void login(); }}>
            <label className="field"><span>아이디</span><input autoComplete="username" value={userId} onChange={(e) => setUserId(e.target.value)} disabled={step !== "login"} /></label>
            <label className="field"><span>비밀번호</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={step !== "login"} /></label>
            {step === "enroll" && enroll && (
              <div className="enroll">
                <p>운영 백오피스는 인증 앱 코드가 필요합니다. 인증 앱(Google Authenticator 등)에 아래 키를 등록하고, 앱에 나온 6자리 코드를 넣으세요.</p>
                <code className="secret" aria-label="인증 앱 등록 키">{enroll.secret}</code>
                <p className="muted small">{enroll.otpauthUrl}</p>
              </div>
            )}
            {step !== "login" && <label className="field"><span>인증 앱 코드</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>}
            <button className="btn primary" type="submit" disabled={userId === "" || password === "" || (step !== "login" && code.length !== 6)}>로그인</button>
            {step !== "login" && <button className="btn" type="button" onClick={() => { setStep("login"); setCode(""); }}>처음으로</button>}
          </form>
        )}
        {config?.devLogin && config.personas.length > 0 && (
          <section className="personas" aria-label="데모 페르소나">
            <h2>데모 페르소나로 들어가기</h2>
            <p className="muted small">데모 환경에만 있는 빠른 로그인입니다. 운영 환경에는 없습니다.</p>
            <ul className="plain">
              {config.personas.map((p) => (
                <li key={p.userId}><button className="btn persona" type="button" onClick={() => void persona(p.userId)}>{p.displayName} <span className="muted small">{p.userId} · {p.roles.join(", ") || "역할 없음"}</span></button></li>
              ))}
            </ul>
          </section>
        )}
      </section>
    </main>
  );
}

import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useClock } from "../api/clock.ts";
import { authApi, devApi, sessionMode } from "../api/client.ts";
import { useGet } from "../api/hooks.ts";
import { ROLE_LABEL, type Me } from "../api/admin.ts";
import type { UserRow } from "../api/types.ts";
import { DEFAULT_ACTOR, setActor, useActor } from "./actor.ts";

/** 포털 주 메뉴(시안 머리글): 작품 · 모아 보기 · 분배 규칙·팩 · 발행·정산 · 조직. 경로 앞부분으로 활성 메뉴를 정한다. */
export const PORTAL_NAV: { to: string; label: string; match: string[] }[] = [
  { to: "/works", label: "작품", match: ["/works"] },
  { to: "/collect", label: "모아 보기", match: ["/collect", "/registry", "/documents", "/confirmations", "/contracts", "/audio", "/validation"] },
  { to: "/policy", label: "분배 규칙·팩", match: ["/policy", "/packs"] },
  { to: "/issues", label: "발행·정산", match: ["/issues", "/statements"] },
  { to: "/", label: "조직", match: ["/accounts", "/links", "/delegation", "/inspections"] },
];
const active = (path: string) => PORTAL_NAV.find((n) => n.match.some((m) => path === m || path.startsWith(`${m}/`))) ?? (path === "/" ? PORTAL_NAV[4] : undefined);

/**
 * 권리자 포털 틀(디자인 가이드 4절, 시안 Song-* 머리글): 사이드바 없이 상단 머리글 한 줄 — dobedupop · 조직 · 가로 메뉴 · 데모 시계 · 사용자.
 * 개발 서버의 시계 조작·사용자 전환은 시안에 없는 도구라 머리글 아래 얇은 띠에 둔다.
 */
export function PortalShell() {
  const loc = useLocation();
  const me = useGet<Me>(["me"], "/me");
  const clock = useClock();
  const cur = active(loc.pathname);
  const org = (me.data?.memberships ?? []).find((m) => m.tenantId === me.data?.tenantId)?.name ?? me.data?.tenantId ?? "";
  const role = me.data?.roles.map((r) => ROLE_LABEL[r] ?? r)[0] ?? "";
  return (
    <div className="p-shell">
      <header className="p-header">
        <strong className="p-brand">dobedupop</strong>
        <span className="p-org">{org} ▾</span>
        <nav className="p-nav" aria-label="주 메뉴">
          {PORTAL_NAV.map((n) => <Link key={n.label} to={n.to} aria-current={cur === n ? "page" : undefined}>{n.label}</Link>)}
        </nav>
        <div className="p-spacer" />
        <span className="p-clock" data-testid="clock-now">{clock.data ? `${clock.data.now.slice(0, 10)} ${clock.data.now.slice(11, 16)}` : "—"}</span>
        {sessionMode ? (
          <span className="p-user" aria-label="로그인한 사용자">{role} · {me.data?.userId} <button type="button" onClick={() => void authApi("POST", "/logout").then(() => location.reload(), () => location.reload())}>로그아웃</button></span>
        ) : <DevUser role={role} />}
      </header>
      {import.meta.env.DEV && <DevStrip />}
      {/* 작품 화면은 시안의 본문 틀을 스스로 그린다. 모아 보기·조직의 기존 화면은 본문 틀 안에 둔다. */}
      {loc.pathname.startsWith("/works") ? <Outlet /> : <main className="p-main"><Outlet /></main>}
    </div>
  );
}

/** 개발 서버: 사용자 이름 자리를 사용자 전환으로(머리글 글자 모양 그대로). */
function DevUser({ role }: { role: string }) {
  const users = useGet<{ items: UserRow[] }>(["users", "dev-switcher"], "/users?limit=200", { api: { actorOverride: DEFAULT_ACTOR } });
  const actor = useActor();
  const rows = users.data?.items ?? [];
  return (
    <span className="p-user">
      {role} · <select aria-label="사용자 전환" value={actor} onChange={(e) => setActor(e.target.value)}>
        {!rows.some((u) => u.userId === actor) && <option value={actor}>{actor}</option>}
        {rows.map((u) => <option key={u.userId} value={u.userId}>{u.userId}</option>)}
      </select>
    </span>
  );
}

const HOUR = 3_600_000;
/** 개발 서버 전용 데모 도구(시계 전진·지정, 다른 앱으로). */
function DevStrip() {
  const qc = useQueryClient();
  const [at, setAt] = useState("");
  const run = (p: Promise<unknown>) => void p.then(() => qc.invalidateQueries());
  return (
    <div className="p-devstrip" aria-label="데모 도구">
      <span>데모 도구</span>
      {([["+1시간", HOUR], ["+1일", 24 * HOUR], ["+3일", 72 * HOUR], ["+30일", 720 * HOUR]] as const).map(([l, ms]) => (
        <button key={l} type="button" onClick={() => run(devApi("POST", "/clock/advance", { ms }))}>{l}</button>
      ))}
      <input type="datetime-local" aria-label="지정 시각(UTC)" value={at} onChange={(e) => setAt(e.target.value)} />
      <button type="button" disabled={!at} onClick={() => run(devApi("POST", "/clock/set", { at: new Date(`${at}Z`).toISOString() }))}>지정</button>
      <a href="/">운영 백오피스로</a><a href="/partner/">참여 기관으로</a>
    </div>
  );
}

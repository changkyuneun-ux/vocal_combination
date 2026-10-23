import { createContext, useContext, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useClock } from "../api/clock.ts";
import { authApi, sessionMode } from "../api/client.ts";
import { useGet } from "../api/hooks.ts";
import { ROLE_LABEL, type Me } from "../api/admin.ts";
import type { WorkOverview } from "../api/works.ts";
import { useActor } from "./actor.ts";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { Sidebar, useSidebarToggles } from "./Sidebar.tsx";
import { activeKey, crumbsFor, sidebarModel, workIdOf, type Counts } from "./sidebar.ts";

const RECENT_KEY = "rc.recentWorks";
const readRecent = (): { workId: string; title: string }[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };
const writeRecent = (xs: { workId: string; title: string }[]) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(xs.slice(0, 6))); } catch { /* 저장 못 해도 메뉴는 동작 */ } };
const total = (path: string, enabled = true) => useGet<{ total: number }>(["sidebar-count", path], path, { enabled }).data?.total; // eslint-disable-line react-hooks/rules-of-hooks

/** 지금 화면의 경로 표시(breadcrumb) — 화면이 위쪽에 그린다. */
const CrumbsCtx = createContext<string[]>([]);
export function Crumbs({ linkWork }: { linkWork?: string }) {
  const c = useContext(CrumbsCtx);
  if (c.length === 0) return null;
  return (
    <nav aria-label="위치" className="p-crumbs">
      {c.map((x, i) => i === c.length - 1 ? <strong key={i}>{x}</strong>
        : [<span key={`x${i}`}>{i === 1 && linkWork ? <Link to={linkWork}>{x}</Link> : x}</span>, <span key={`s${i}`}>›</span>])}
    </nav>
  );
}

/**
 * 권리자 포털 틀(디자인 가이드 4절, 시안 Nav-Works-Stems·Sidebar): 머리글(가로 메뉴 없음) + 왼쪽 사이드 메뉴 + 본문.
 * 개발 서버의 시계 조작·사용자 전환은 시안에 없는 도구라 머리글 아래 얇은 띠에 둔다.
 */
export function PortalShell() {
  const loc = useLocation();
  const actor = useActor();
  const me = useGet<Me & { permissions?: string[] }>(["me"], "/me");
  const clock = useClock();
  const overview = useGet<WorkOverview[]>(["works-overview"], "/works/overview");
  const { closed, onToggle } = useSidebarToggles();
  const [recent, setRecent] = useState(readRecent);
  const org = (me.data?.memberships ?? []).find((m) => m.tenantId === me.data?.tenantId)?.name ?? me.data?.tenantId ?? "";
  const role = me.data?.roles.map((r) => ROLE_LABEL[r] ?? r)[0] ?? "";
  const perms = new Set(me.data?.permissions ?? []);
  const can = (p: string) => me.data === undefined || perms.has(p);
  // 지금 곡: 곡 워크스페이스 경로면 그 곡, 아니면 마지막으로 연 곡.
  const pathWork = workIdOf(loc.pathname);
  // 아직 연 곡이 없으면 작품 목록의 첫 곡(시안: 작품 워크스페이스는 늘 메뉴에 있다).
  const lastId = pathWork ?? recent[0]?.workId ?? overview.data?.[0]?.workId ?? null;
  const w = overview.data?.find((x) => x.workId === lastId);
  useEffect(() => {
    if (!pathWork || !w) return;
    const next = [{ workId: w.workId, title: w.title }, ...readRecent().filter((r) => r.workId !== w.workId)];
    writeRecent(next); setRecent(next);
  }, [pathWork, w?.workId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 사이드 메뉴 배지는 할 일만(시안 Sidebar 2차): 확인 요청 대기 · 서명 대기 계약 · 정합성 경고.
  const counts: Counts = {
    confirmAll: total("/confirmations?status=OPEN&page=1&size=1"), contractsPending: total("/contracts?status=SENT&page=1&size=1"),
    warnings: total("/validation-issues?status=OPEN&severity=WARN&page=1&size=1"),
  };
  const groups = sidebarModel(loc.pathname, w ? { workId: w.workId, title: w.title, status: w.status } : null, counts, can, recent, closed);
  const crumbs = crumbsFor(loc.pathname, groups, w?.title);
  return (
    <div className="p-shell p-shell2">
      <header className="p-header">
        <strong className="p-brand">dobedupop</strong>
        <span className="p-org">{org}</span>
        <span className="p-tenant">권리 테넌트</span>
        <div className="p-spacer" />
        <span className="p-search"><b>/</b> 검색</span>
        <span className="p-clock" data-testid="clock-now">{clock.data ? `${clock.data.now.slice(0, 10)} ${clock.data.now.slice(11, 16)}` : "—"}</span>
        {/* 시안: "역할 · 사용자 id" 글자만. 개발 서버의 사용자 전환·데모 도구는 포털에 두지 않는다(포털은 권리 테넌트 하나로 고정). */}
        <span className="p-user" aria-label="로그인한 사용자">{role} · {me.data?.userId ?? actor}{sessionMode && <> <button type="button" onClick={() => void authApi("POST", "/logout").then(() => location.reload(), () => location.reload())}>로그아웃</button></>}</span>
      </header>
      <div className="p-body">
        <Sidebar groups={groups} closed={closed} onToggle={onToggle} org={org} />
        <div className="p-content">
          <CrumbsCtx.Provider value={crumbs}>
            {/* 작품·운영 관리 화면은 본문 틀(경로·제목)을 스스로 그린다. 그 밖(기존 권리 화면)은 틀 안에 넣는다. */}
            {me.error ? <main className="p-main"><ErrorPanel error={me.error} />
              <p className="p-sub">권리자 포털은 권리 테넌트 소속 계정으로만 씁니다. 플랫폼 운영 업무는 운영 백오피스에서 합니다.</p></main>
              : activeKey(loc.pathname) !== "" ? <Outlet /> : <main className="p-main"><Crumbs /><Outlet /></main>}
          </CrumbsCtx.Provider>
        </div>
      </div>
    </div>
  );
}


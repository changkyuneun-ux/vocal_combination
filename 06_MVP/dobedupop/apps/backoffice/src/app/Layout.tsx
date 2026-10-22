import { NavLink, Outlet } from "react-router";
import { Header } from "./Header.tsx";
import { menuFor } from "./routes.tsx";
import { currentApp } from "./apps.ts";
import { sessionMode } from "../api/client.ts";
import { useGet } from "../api/hooks.ts";

/** 로그인 세션이면 내 역할·권한으로 볼 수 없는 메뉴를 숨긴다(개발 서버는 사용자 전환으로 시험하므로 다 보인다). */
function useVisibleMenu() {
  const me = useGet<{ roles: string[]; permissions?: string[] }>(["me"], "/me", { enabled: sessionMode });
  const roles = new Set(me.data?.roles ?? []);
  const perms = new Set(me.data?.permissions ?? []);
  const visible = (i: { roles?: string[]; perm?: string }) => !sessionMode || ((i.roles === undefined || i.roles.some((r) => roles.has(r))) && (i.perm === undefined || perms.has(i.perm)));
  return menuFor(currentApp())
    .map((g) => ({ ...g, items: g.items.filter(visible) }))
    .filter((g) => g.items.length > 0);
}

export function Layout() {
  const menu = useVisibleMenu();
  return (
    <div className="layout">
      <Header />
      <nav className="menu" aria-label="메뉴">
        {menu.map((g) => (
          <div key={g.title} className="menu-group">
            <h3>{g.title}</h3>
            {g.items.map((i) => <NavLink key={i.to} to={i.to} end={i.to === "/"}>{i.label}</NavLink>)}
          </div>
        ))}
      </nav>
      <main className="content"><Outlet /></main>
    </div>
  );
}

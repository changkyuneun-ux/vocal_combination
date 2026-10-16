import { NavLink, Outlet } from "react-router";
import { Header } from "./Header.tsx";
import { menuFor } from "./routes.tsx";
import { currentApp } from "./apps.ts";

export function Layout() {
  return (
    <div className="layout">
      <Header />
      <nav className="menu" aria-label="메뉴">
        {menuFor(currentApp()).map((g) => (
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

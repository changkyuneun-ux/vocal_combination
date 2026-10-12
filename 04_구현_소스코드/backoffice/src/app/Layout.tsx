import { NavLink, Outlet } from "react-router";
import { Header } from "./Header.tsx";
import { menu } from "./routes.tsx";

export function Layout() {
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

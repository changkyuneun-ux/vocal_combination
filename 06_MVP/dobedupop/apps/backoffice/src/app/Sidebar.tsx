import { useState } from "react";
import { Link } from "react-router";
import type { Badge, Group } from "./sidebar.ts";

const Pill = ({ b }: { b?: Badge }) => (b ? <span className={`p-sb-badge ${b.tone}`}>{b.text}</span> : null);

/**
 * 권리 테넌트 사이드 메뉴(시안 Sidebar.dc.html 2026-10-23 2차, 260px 3단계 아코디온 — 1단계 15px 700 회색 바탕 · 2단계 14px 600 · 3단계 13.5px 500).
 * 모델은 sidebar.ts의 sidebarModel이 만든다.
 * 펼침·접힘은 사용자가 바꾼 것만 기억하고(closed), 나머지는 모델의 기본값을 따른다.
 */
export function Sidebar({ groups, onToggle, org }: { groups: Group[]; closed?: Record<string, boolean>; onToggle: (key: string, open: boolean) => void; org: string }) {
  return (
    <nav aria-label="권리 테넌트 메뉴" className="p-sb">
      {groups.map((g) => (
        <div key={g.key} className="p-sb-group">
          <button type="button" className="p-sb-g" aria-expanded={g.open} onClick={() => onToggle(g.key, g.open)}>
            <span aria-hidden="true" className="chev" data-open={g.open}>▸</span><span className="label">{g.label}</span>
          </button>
          {g.open && g.items.map((it) => (
            <div key={it.key} className="p-sb-itemwrap">
              {it.children.length === 0 ? (
                <Link to={it.to!} className="p-sb-item" aria-current={it.current ? "page" : undefined}>
                  <span aria-hidden="true" className="dot">·</span><span className="label">{it.label}</span><Pill b={it.badge} />
                </Link>
              ) : (
                <button type="button" className={`p-sb-item${it.strong ? " strong" : ""}`} aria-expanded={it.open} onClick={() => onToggle(it.key, it.open)}>
                  <span aria-hidden="true" className="chev" data-open={it.open}>▸</span><span className="label">{it.label}</span><Pill b={it.badge} />
                </button>
              )}
              {it.open && (
                <div className="p-sb-kids">
                  {it.children.map((c) => (
                    <Link key={c.key} to={c.to} className="p-sb-leaf" aria-current={c.current ? "page" : undefined}><span className="label">{c.label}</span><Pill b={c.badge} /></Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      <p className="p-sb-foot">메뉴는 {org} 소속의 권한으로 걸러 보인다.</p>
    </nav>
  );
}

/** 펼침 상태(사용자가 바꾼 것만). */
export function useSidebarToggles() {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return { closed, onToggle: (key: string, open: boolean) => setClosed((c) => ({ ...c, [key]: open })) };
}

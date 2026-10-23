import { Link } from "react-router";
import { menuFor } from "../../app/routes.tsx";

/** 모아 보기: 곡을 가로질러 보는 기존 화면 목록(포털 머리글의 "모아 보기"). */
export function CollectPage() {
  const groups = menuFor("portal").filter((g) => g.title !== "작품" && g.title !== "홈");
  return (
    <>
      <div className="p-pagehead"><div><div className="p-path">작품 밖 화면</div><h1>모아 보기</h1></div></div>
      <div className="p-cols">
        <div className="main">
          {groups.map((g) => (
            <section key={g.title} className="p-card" aria-label={g.title}>
              <div className="p-card-head"><h2>{g.title}</h2></div>
              <div className="p-card-body p-row">{g.items.map((i) => <Link key={i.to} className="p-btn" to={i.to}>{i.label}</Link>)}</div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

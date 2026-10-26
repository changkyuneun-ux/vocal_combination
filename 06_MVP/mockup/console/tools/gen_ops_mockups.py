"""운영 관리 화면 시안(Ops-*.dc.html) 생성기.

머리글·사이드 메뉴·경로·제목·표 마크업을 Nav-Ops-Confirm.dc.html과 같게 찍어 낸다.
화면별 내용만 아래 PAGES에 적는다. 실행: python3 tools/gen_ops_mockups.py
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "project"

# ── 스타일 v2(2026-10-23): 비즈니스 클래식 — 남색 주색, 회색 단계, 흰 카드 + 옅은 그림자, 라벨 왼쪽·값 오른쪽, 큰 현황 숫자 ──
NAVY = "#1e3a8a"
LINE = "#e3e7ee"
CARD = f"background: #ffffff; border: 1px solid {LINE}; border-radius: 14px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05)"
TONE = {
    "ok": "background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0",
    "warn": "background: #fffbeb; color: #b45309; border: 1px solid #fde68a",
    "err": "background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca",
    "ir": "background: #eef2ff; color: #3730a3; border: 1px solid #c7d2fe",
    "gray": "background: #f8fafc; color: #334155; border: 1px solid #e2e8f0",
    "blue": "background: #eff6ff; color: #1e3a8a; border: 1px solid #bfdbfe",
}
MONO = "font-variant-numeric: tabular-nums"


def badge(text, tone="gray"):
    return f'<span style="display: inline-block; font-size: 12px; line-height: 18px; padding: 2px 10px; border-radius: 999px; {TONE[tone]}; font-weight: 700; white-space: nowrap">{text}</span>'


def mono(text):
    return f'<span style="{MONO}; white-space: nowrap">{text}</span>'


def sub(main, small):
    return f'{main}<div style="margin-top: 2px; font-size: 12.5px; font-weight: 400; color: #334155">{small}</div>'


def link(text):
    return f'<a href="#" style="font-weight: 600; text-decoration: none; white-space: nowrap">{text}</a>'


def stats(items):
    """현황 숫자 카드. items: (라벨, 값, 아래 설명, 주의 여부). 위쪽 3px 띠 — 보통 남색, 주의 호박색."""
    cards = []
    for label, val, note, warn in items:
        bar = "#b45309" if warn else NAVY
        color = "#b45309" if warn else "#0f172a"
        cards.append(
            f'<div style="{CARD}; border-top: 3px solid {bar}; padding: 16px 18px; display: flex; flex-direction: column; gap: 6px">'
            f'<div style="font-size: 13px; font-weight: 600; color: #334155">{label}</div>'
            f'<div style="font-size: 28px; line-height: 1.1; font-weight: 800; letter-spacing: -0.01em; color: {color}; {MONO}">{val}</div>'
            f'<div style="font-size: 13px; color: #334155">{note}</div></div>')
    return (f'<div style="display: grid; grid-template-columns: repeat({len(items)}, minmax(0, 1fr)); gap: 14px">'
            + "".join(cards) + "</div>")


SELECT = "font: inherit; font-size: 14px; color: #0f172a; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; background: #ffffff"


def filters(placeholder, selects):
    """검색 + 고르기. 처음 값은 언제나 '전체'(2026-10-23) — 옵션에 '전체'가 없으면 '<이름> 전체'를 앞에 둔다."""
    out = ['<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center">',
           '<label for="q" style="position: absolute; left: -9999px">검색</label>',
           f'<input id="q" placeholder="{placeholder}" style="{SELECT}; flex: 1 1 280px">']
    for name, opts in selects:
        opts = list(opts)
        alls = [x for x in opts if "전체" in x]
        opts = (alls[:1] + [x for x in opts if x != alls[0]]) if alls else [f"{name} 전체"] + opts
        o = "".join(f"<option>{x}</option>" for x in opts)
        out.append(f'<select aria-label="{name}" style="{SELECT}">{o}</select>')
    out.append("</div>")
    return "\n".join(out)


PAGE_SIZE = 10


def pager(total):
    """목록 표 아래 쪽 나눔 줄. 10행 단위, 첫 쪽을 보고 있는 모양."""
    if total == 0:
        return ""
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    btn = "min-width: 32px; height: 32px; padding: 0 8px; border-radius: 8px; font: inherit; font-size: 13px; "
    nums = "".join(
        f'<button aria-current="page" style="{btn}border: 0; background: {NAVY}; color: #ffffff; font-weight: 700">1</button>' if n == 1
        else f'<button style="{btn}border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a; font-weight: 600">{n}</button>' for n in range(1, pages + 1))
    prev = f'<button disabled aria-label="이전 쪽" style="{btn}border: 1px solid #e2e8f0; background: #ffffff; color: #94a3b8">‹</button>'
    nxt_dis = pages == 1
    nxt = (f'<button{" disabled" if nxt_dis else ""} aria-label="다음 쪽" style="{btn}border: 1px solid {"#e2e8f0" if nxt_dis else "#cbd5e1"}; background: #ffffff; color: {"#94a3b8" if nxt_dis else "#0f172a"}">›</button>')
    return (f'<nav aria-label="쪽" style="display: flex; align-items: center; gap: 6px; margin-left: auto">'
            f'<span style="font-size: 13px; color: #334155; margin-right: 6px; {MONO}">1–{min(total, PAGE_SIZE)} / {total}</span>{prev}{nums}{nxt}</nav>')


def head(title, hint="", right=""):
    """카드 머리: 제목 16px 700 왼쪽, 설명은 제목 옆, 오른쪽 끝에 버튼."""
    h = f'<span style="font-size: 13px; color: #334155">{hint}</span>' if hint else ""
    r = f'<span style="margin-left: auto; display: flex; gap: 8px">{right}</span>' if right else ""
    return f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center"><h2 style="margin: 0; font-size: 16px; font-weight: 700; color: #0f172a">{title}</h2>{h}{r}</div>'


def table(cols, rows, foot=None, title=None, min_w=900, empty=None, paged=True):
    """paged=False: 항목 수가 정해진 표(확인 항목·규칙별 결과)는 쪽 나눔 줄을 두지 않는다."""
    th = "".join(f'<th style="padding: 10px 16px; text-align: left; font-size: 12.5px; font-weight: 700; color: #334155; background: #f8fafc; border-bottom: 1px solid {LINE}; white-space: nowrap">{c}</th>' for c in cols)
    total = len(rows)
    body = []
    if total == 0 and empty:
        body.append(f'<tr><td colspan="{len(cols)}" style="padding: 32px 16px; text-align: center; font-size: 14px; color: #334155">{empty}</td></tr>')
    for r in rows[:PAGE_SIZE]:
        tds = []
        for i, cell in enumerate(r):
            weight = "; font-weight: 600" if i == 0 else ""
            tds.append(f'<td style="padding: 12px 16px; vertical-align: middle{weight}">{cell}</td>')
        body.append('<tr style="border-top: 1px solid #eef1f5">' + "".join(tds) + "</tr>")
    hd = f'<div style="padding: 16px 18px 12px">{head(title[0], title[1])}</div>' if title else ""
    pg = pager(total) if paged else ""
    footer = (f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 18px; border-top: 1px solid {LINE}; font-size: 13px; color: #334155">'
              f'<span style="flex: 1 1 320px">{foot or ""}</span>{pg}</div>') if (foot or pg) else ""
    return (f'<section style="{CARD}; overflow: hidden">'
            + hd + f'<div style="overflow-x: auto"><table style="width: 100%; min-width: {min_w}px; border-collapse: collapse; font-size: 14px; color: #0f172a">'
            + f"<thead><tr>{th}</tr></thead><tbody>" + "".join(body) + "</tbody></table></div>" + footer + "</section>")


def card(title, body, hint=""):
    return f'<section style="{CARD}; padding: 18px; display: flex; flex-direction: column; gap: 14px">{head(title, hint)}{body}</section>'


def note(text, tone="blue"):
    bar = {"blue": NAVY, "warn": "#b45309"}[tone]
    return f'<div role="note" style="padding: 12px 16px; border-radius: 10px; background: #f8fafc; border: 1px solid {LINE}; border-left: 3px solid {bar}; color: #1e293b; font-size: 13.5px">{text}</div>'


def kv(pairs):
    """라벨 왼쪽(회색) · 값 오른쪽(굵게) 정렬, 옅은 바탕 상자."""
    rows = "".join(f'<div style="display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-top: 1px solid {"#eef1f5" if i else "transparent"}">'
                   f'<dt style="color: #334155; flex: 0 0 auto">{k}</dt><dd style="margin: 0; font-weight: 600; text-align: right">{v}</dd></div>'
                   for i, (k, v) in enumerate(pairs))
    return f'<dl style="margin: 0; padding: 6px 16px; border-radius: 10px; background: #f8fafc; border: 1px solid {LINE}; font-size: 14px">{rows}</dl>'


def button(text, primary=False, disabled=False):
    if primary:
        s = f"border: 1px solid {NAVY}; background: {NAVY}; color: #ffffff"
    else:
        s = "border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a"
    if disabled:
        s += "; opacity: 0.45; cursor: not-allowed"
    d = " disabled" if disabled else ""
    return f'<button{d} style="font: inherit; font-size: 14px; font-weight: 600; padding: 10px 16px; border-radius: 10px; {s}">{text}</button>'


def page(fname, title, active, clock, crumbs, h1, desc, actions, body, height=1000, before_title="", after_title=""):
    # crumbs: 경로 줄은 두지 않는다(2026-10-23). 위치는 사이드 메뉴 활성과 제목으로 안다
    html = f'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:#1e40af}}a:hover{{color:#1e3a8a;text-decoration:underline}}
</style>
</helmet>
<div style="font-family: 'IBM Plex Sans KR', system-ui, sans-serif; color: #0f172a; background: #f3f5f8; min-height: 100vh; display: flex; flex-direction: column">
<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 12px 24px; background: {NAVY}; color: #ffffff">
<strong style="font-size: 16px">dobedupop</strong>
<span style="font-size: 14px; color: #dbeafe">빅히트 뮤직</span>
<span style="font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: rgba(255, 255, 255, 0.14); border: 1px solid rgba(255, 255, 255, 0.28)">권리 테넌트</span>
<div style="flex: 1 1 40px"></div>
<span style="font-size: 13px; color: #dbeafe"><b>/</b> 검색</span>
<span style="font-size: 14px; padding: 6px 12px; border-radius: 8px; background: #92400e; font-variant-numeric: tabular-nums">{clock}</span>
<span style="font-size: 14px; color: #dbeafe">총괄 · usr_admin</span>
</header>
<div style="flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: stretch">
<dc-import name="Sidebar" active="{active}" hint-size="260px,{height}px"></dc-import>
<main style="flex: 999 1 640px; min-width: 0; padding: 24px 28px 36px; display: flex; flex-direction: column; gap: 18px">
{before_title}<div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: flex-end">
<div><h1 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.01em">{h1}</h1><div style="margin-top: 6px; font-size: 14px; color: #334155">{desc}</div></div>
<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center">{"".join(actions)}</div>
</div>
{after_title}{chr(10).join(body)}
</main>
</div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":{height}}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''
    (OUT / fname).write_text(html, encoding="utf-8")



def grouped(cols, groups, sub_cols, open_idx=0, foot="", title=None, min_w=900):
    """작품 단위 묶음 표(2026-10-24). 작품마다 요약 한 줄 → 누르면 그 작품 상세만 펼친다(한 번에 하나, 전체 펼치기 없음).
    상세는 10행 단위 쪽 나눔, 작품 목록도 10개 단위 쪽 나눔. groups: dict(name, sub, cells, rows)."""
    th = "".join(f'<th style="padding: 10px 16px; text-align: left; font-size: 12.5px; font-weight: 700; color: #334155; background: #f8fafc; border-bottom: 1px solid {LINE}; white-space: nowrap">{c}</th>' for c in ["작품"] + cols + [""])
    sth = "".join(f'<th style="padding: 8px 14px; text-align: left; font-size: 12px; font-weight: 700; color: #334155; background: #ffffff; border-bottom: 1px solid {LINE}; white-space: nowrap">{c}</th>' for c in sub_cols)
    body = []
    for i, g in enumerate(groups[:PAGE_SIZE]):
        is_open = i == open_idx
        chev = f'<span aria-hidden="true" style="display: inline-block; width: 14px; color: #334155; transform: rotate({90 if is_open else 0}deg)">▸</span>'
        name = f'<button aria-expanded="{str(is_open).lower()}" style="display: inline-flex; align-items: center; gap: 8px; border: 0; background: none; padding: 0; font: inherit; font-weight: 700; color: #0f172a; cursor: pointer; text-align: left">{chev}<span>{g["name"]}</span></button>'
        if g.get("sub"):
            name += f'<div style="margin: 2px 0 0 22px; font-size: 12.5px; font-weight: 400; color: #334155">{g["sub"]}</div>'
        act = link("접기" if is_open else "상세 보기")
        bg = "background: #f8fafc; " if is_open else ""
        tds = f'<td style="padding: 12px 16px">{name}</td>' + "".join(f'<td style="padding: 12px 16px">{c}</td>' for c in g["cells"]) + f'<td style="padding: 12px 16px; text-align: right">{act}</td>'
        body.append(f'<tr style="{bg}border-top: 1px solid #eef1f5">{tds}</tr>')
        if is_open:
            rows = g["rows"]
            if rows:
                inner_rows = "".join('<tr style="border-top: 1px solid #eef1f5">' + "".join(
                    f'<td style="padding: 10px 14px{"; font-weight: 600" if k == 0 else ""}">{c}</td>' for k, c in enumerate(r)) + "</tr>" for r in rows[:PAGE_SIZE])
                inner = (f'<div style="margin: 0 16px 16px 38px; border: 1px solid {LINE}; border-radius: 10px; overflow: hidden; background: #ffffff">'
                         f'<div style="overflow-x: auto"><table style="width: 100%; border-collapse: collapse; font-size: 13.5px"><thead><tr>{sth}</tr></thead><tbody>{inner_rows}</tbody></table></div>'
                         f'<div style="display: flex; align-items: center; padding: 8px 14px; border-top: 1px solid {LINE}; font-size: 12.5px; color: #334155"><span style="flex: 1 1 auto">{g.get("note", "")}</span>{pager(len(rows))}</div></div>')
            else:
                inner = f'<div style="margin: 0 16px 16px 38px; padding: 18px; border: 1px solid {LINE}; border-radius: 10px; background: #ffffff; font-size: 13.5px; color: #334155">{g.get("empty", "해당 항목이 없습니다.")}</div>'
            body.append(f'<tr style="background: #f8fafc"><td colspan="{len(cols) + 2}" style="padding: 0">{inner}</td></tr>')
    hd = f'<div style="padding: 16px 18px 12px">{head(title[0], title[1])}</div>' if title else ""
    footer = (f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 18px; border-top: 1px solid {LINE}; font-size: 13px; color: #334155">'
              f'<span style="flex: 1 1 320px">{foot or "작품을 누르면 그 작품 상세만 펼친다. 한 번에 한 작품씩."}</span>{pager(len(groups))}</div>')
    return (f'<section style="{CARD}; overflow: hidden">{hd}<div style="overflow-x: auto"><table style="width: 100%; min-width: {min_w}px; border-collapse: collapse; font-size: 14px; color: #0f172a">'
            f'<thead><tr>{th}</tr></thead><tbody>{"".join(body)}</tbody></table></div>{footer}</section>')


# 곡 진행 ①~⑤(2026-10-24): 원본 계약서 → 권리 등록 → 권리 확정 → 이용 허락 → 분배·출시
PROG_STEPS = ["원본 계약서", "권리 등록", "권리 확정", "이용 허락", "분배·출시"]
PROG_DEFAULT = [("done", "2건"), ("done", "작품·녹음·실연"), ("now", "작가 2 서명 대기"), ("todo", "1 / 4종")]  + [("todo", "")]
PROG_LOCKED = [("done", "2건"), ("done", "작품·녹음·실연"), ("done", "확정"), ("done", "4 / 4종"), ("done", "IR v1 · 판매 중")]


def progress(states):
    cells = []
    for i, (name, (st, note_)) in enumerate(zip(PROG_STEPS, states), 1):
        if st == "done":
            mark, color, wt, line = "✓", "#047857", "700", "#a7f3d0"
        elif st == "now":
            mark, color, wt, line = str(i), NAVY, "800", NAVY
        else:
            mark, color, wt, line = str(i), "#334155", "600", "#e2e8f0"
        circle = (f'<span style="display: inline-flex; width: 22px; height: 22px; border-radius: 999px; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; '
                  + (f'background: {NAVY}; color: #ffffff' if st == "now" else f'background: #ffffff; color: {color}; border: 1.5px solid {line}') + f'">{mark}</span>')
        cells.append(f'<div style="flex: 1 1 150px; display: flex; gap: 8px; align-items: flex-start; padding: 2px 0; border-top: 3px solid {line}; padding-top: 10px">{circle}'
                     f'<div><div style="font-size: 13.5px; font-weight: {wt}; color: {"#0f172a" if st != "todo" else "#334155"}">{name}</div><div style="font-size: 12.5px; color: #334155">{note_}</div></div></div>')
    return f'<div role="status" aria-label="곡 진행" style="{CARD}; display: flex; flex-wrap: wrap; gap: 14px; padding: 12px 18px 14px">{"".join(cells)}</div>\n'


EX = "예시 데이터"
MEMBERS = ["정국", "지민", "뷔", "진", "RM", "제이홉", "슈가"]

# ── 확인·동의 › 확인 요청 전체(작품 묶음) ──
page("Nav-Ops-Confirm.dc.html", "운영 관리 — 확인 요청 전체", "op-confirm-all", "2026-01-12 09:00",
     ["운영 관리", "확인·동의", "확인 요청 전체"], "확인 요청 전체",
     "빅히트 뮤직의 모든 곡에서 상대 당사자에게 보낸 확인 요청. 작품을 누르면 그 작품의 요청만 펼친다",
     [button("엑셀 다운로드")],
     [stats([("대기", "9", "작품 2", False), ("기한 3일 안", "2", "지나면 정합성 차단", True), ("확인됨(이번 달)", "147", "멤버 7", False), ("거절·이의제기", "0", "분쟁으로 이어짐", False)]),
      filters("곡명, 기록, 상대 당사자", [("상대", ["상대 전체", "멤버(실연자 앱)", "작가(전자서명 링크)"]), ("상태", ["전체", "대기", "확인됨", "거절"])]),
      grouped(["대기", "기한 3일 안", "확인됨", "상태"],
              [dict(name="Dynamite", sub="녹음 Vocal Recombination", cells=["2", '<span style="color: #b45309; font-weight: 700">2</span>', "56", badge("작가 서명 대기", "warn")],
                    rows=[["작가 지분 50% · David Stewart", "작가(전자서명 링크)", mono("01-02 09:10"), '<span style="color: #b45309; font-weight: 700">01-16</span>', badge("대기", "warn"), link("확인·동의 탭 →")],
                          ["작가 지분 50% · Jessica Agombar", "작가(전자서명 링크)", mono("01-02 09:10"), '<span style="color: #b45309; font-weight: 700">01-16</span>', badge("대기", "warn"), link("확인·동의 탭 →")]],
                    note="Dynamite 대기 2건"),
               dict(name="푸른 계절", sub=EX, cells=["7", "0", "91", badge("멤버 확인 중", "gray")], rows=[])],
              ["기록", "확인할 상대", "요청", "기한", "상태", ""],
              foot="멤버는 실연자 앱에서 본인이, 계정 없는 작가는 빅히트가 보낸 전자서명 링크로 확인한다. 작품을 누르면 그 작품 요청만 펼친다(한 번에 하나).")])

# ── 확인·동의 › 멤버 이용 동의(작품 묶음) ──
page("Ops-Consents.dc.html", "운영 관리 — 멤버 이용 동의", "op-consents", "2026-02-01 09:00",
     ["운영 관리", "확인·동의", "멤버 이용 동의"], "멤버 이용 동의",
     "멤버가 실연자 앱에서 본인이 한 팬앱 이용 동의. 작품을 누르면 그 작품 멤버만 펼친다",
     [button("엑셀 다운로드")],
     [stats([("동의함", "9 / 9", "작품 2", False), ("동의 대기", "0", "", False), ("철회", "0", "철회하면 그 멤버 스템 조합 노출 중지", False), ("작품", "2", "Dynamite · 푸른 계절", False)]),
      filters("멤버, 보이스", [("상태", ["전체", "동의함", "대기", "철회"])]),
      grouped(["멤버", "동의함", "대기·철회", "상태"],
              [dict(name="Dynamite", sub="녹음 Vocal Recombination", cells=["7", "7", "0", badge("모두 동의", "ok")],
                    rows=[[sub(m, "빅히트 뮤직 매니지먼트 소속"), mono(f"voc_{e}"), "미리듣기·조합 생성·개인 보관 · 팬앱", mono(t), badge("동의함", "ok")]
                          for m, e, t in zip(MEMBERS, ["jungkook", "jimin", "v", "jin", "rm", "jhope", "suga"], ["01-06 10:12", "01-06 11:40", "01-07 09:05", "01-07 14:22", "01-08 10:00", "01-08 16:31", "01-09 09:48"])]),
               dict(name="푸른 계절", sub=EX, cells=["2", "2", "0", badge("모두 동의", "ok")], rows=[])],
              ["멤버", "보이스", "동의 범위", "동의 시각", "상태"],
              foot="동의는 멤버 본인만 하거나 철회한다. 빅히트는 조회와 다시 알림만 한다.")])

# ── 계약·문서 › 표준 계약 전체(작품 묶음, 권리 확정·이용 허락 구분) ──
page("Ops-Contracts.dc.html", "운영 관리 — 표준 계약 전체", "op-contracts-all", "2026-01-05 09:00",
     ["운영 관리", "계약·문서", "표준 계약 전체"], "표준 계약 전체",
     "빅히트 뮤직이 보낸 표준 계약. 권리 확정(권리 확인서)과 이용 허락(이용허락·동의·수령 위임)을 나눠 본다",
     [button("엑셀 다운로드")],
     [stats([("전체", "15", "작품 2", False), ("서명 대기", "8", "Dynamite 8", True), ("반영", "7", "서명본은 원천 문서로", False), ("거절·만료", "0", "", False)]),
      filters("계약, 당사자", [("구분", ["구분 전체", "권리 확정", "이용 허락"]), ("상태", ["전체", "서명 대기", "반영"])]),
      grouped(["계약", "서명 대기", "반영", "상태"],
              [dict(name="Dynamite", sub="녹음 Vocal Recombination", cells=["11", '<span style="color: #b45309; font-weight: 700">8</span>', "3", badge("서명 대기", "warn")],
                    rows=[[badge("권리 확정", "blue"), "권리 확인서 · 레이블용", "빅히트 뮤직 — 레이블", "1", badge("반영", "ok")],
                          [badge("권리 확정", "blue"), "권리 확인서 · 작가용", "작가 2(전자서명 링크)", "1", badge("서명 대기", "warn")],
                          [badge("이용 허락", "gray"), "녹음 이용허락", "빅히트 뮤직 — 레이블", "1", badge("반영", "ok")],
                          [badge("이용 허락", "gray"), "작품 이용허락 · 작가 2명", "작가(전자서명 링크)", "2", badge("서명 대기", "warn")],
                          [badge("이용 허락", "gray"), "실연 수익 수령 위임 · 정국", "정국 · 빅히트 뮤직 매니지먼트", "1", badge("반영", "ok")],
                          [badge("이용 허락", "gray"), "실연 수익 수령 위임 · 지민 외 5명", "멤버 대기 · 소속사 대기", "6", badge("서명 대기", "warn")]],
                    note="Dynamite 11건 · 플랫폼 이용계약은 조직 단위(내 조직)"),
               dict(name="푸른 계절", sub=EX, cells=["4", "0", "4", badge("모두 반영", "ok")], rows=[])],
              ["구분", "계약", "서명 당사자", "건수", "상태"],
              foot="권리 확정 = 누가 몇 %를 갖는지 서명으로 확정. 이용 허락 = 팬앱에서 써도 된다는 허락. 계약 만들기는 곡의 문서·계약 탭에서.")])

# ── 계약·문서 › 원천 문서(작품 묶음, 원본 계약서·서명본 구분) ──
page("Ops-Docs.dc.html", "운영 관리 — 원천 문서", "op-docs", "2026-01-05 09:00",
     ["운영 관리", "계약·문서", "원천 문서"], "원천 문서",
     "작품마다 원본 계약서(권리 근거)와 표준 계약 서명본. 작품을 누르면 그 작품 문서만 펼친다",
     [button("엑셀 다운로드")],
     [stats([("전체", "13", "작품 2 · 조직 2", False), ("원본 계약서", "6", "권리 근거", False), ("서명본", "7", "반영된 표준 계약", False), ("근거로 쓰인 주장", "21", "주장 없는 문서 0", False)]),
      filters("문서명, 당사자", [("종류", ["종류 전체", "원본 계약서", "서명본"])]),
      grouped(["원본 계약서", "서명본", "근거 주장"],
              [dict(name="Dynamite", sub="녹음 Vocal Recombination", cells=["2", "3", "12"],
                    rows=[[badge("원본 계약서", "blue"), "Dynamite 녹음 계약서 v1 (PDF)", "빅히트 뮤직 — 레이블", mono("2026-01-01"), "마스터 보유", link("보기")],
                          [badge("원본 계약서", "blue"), "Dynamite 작품 퍼블리싱 계약서 v1 (PDF)", "작가 2명", mono("2026-01-01"), "작가 지분", link("보기")],
                          [badge("서명본", "gray"), "녹음 이용허락 v1 서명본", "빅히트 뮤직 — 레이블", mono("2026-01-02"), "녹음 이용 허락", link("보기")],
                          [badge("서명본", "gray"), "권리 확인서(레이블용) 서명본", "빅히트 뮤직 — 레이블", mono("2026-01-02"), "마스터 보유 확정", link("보기")],
                          [badge("서명본", "gray"), "수령 위임계약 v1 서명본 · 정국", "정국 · 빅히트 뮤직 매니지먼트", mono("2026-01-04"), "수령 위임", link("보기")]]),
               dict(name="푸른 계절", sub=EX, cells=["2", "4", "9"], rows=[]),
               dict(name="조직 문서(작품 공통)", sub="KYB · 플랫폼 이용계약", cells=["2", "—", "—"], rows=[])],
              ["종류", "문서", "당사자", "효력", "근거가 된 것", ""],
              foot="원본 계약서는 곡의 새 곡·문서·계약 화면에서 그 곡에 묶어 올린다. IR에 쓰인 문서는 지우거나 바꿀 수 없다.")], height=1000)

# ── 계약·문서 › 계약 템플릿 ──
page("Ops-Templates.dc.html", "운영 관리 — 계약 템플릿", "op-templates", "2026-01-05 09:00",
     ["운영 관리", "계약·문서", "계약 템플릿"], "계약 템플릿",
     "표준 계약 템플릿(플랫폼 법무 관리, 빅히트는 골라 쓴다)과 계약서 읽기 틀(빅히트 등록 · 플랫폼 승인)",
     [button("+ 읽기 틀 등록", primary=True)],
     [table(["템플릿", "버전", "쓰는 곳", "서명", "조항", "서명하면", "쓴 계약"],
            [["플랫폼 이용계약", mono("v1"), "테넌트 온보딩", "권리 테넌트", "8", "플랫폼 이용 확정", "1"],
             ["녹음 이용허락 표준계약", mono("v1"), "원곡 권리 › 녹음", "레이블", "6", "녹음 이용 동의", "2"],
             ["작품 이용허락 표준계약", mono("v1"), "원곡 권리 › 작품", "작가(계정 없으면 전자서명 링크)", "6", "작품 이용 동의", "3"],
             ["실연 수익 수령 위임계약", mono("v1"), "원곡 권리 › 수령 위임", "멤버(실연자 앱) → 소속사", "5", "수령 위임", "9"],
             ["멤버 팬앱 이용 동의", mono("v1"), "확인·동의", "멤버(실연자 앱) 본인", "4", "실연 이용 동의", "7"],
             [sub("권리 확인서 · 레이블용", "새 템플릿(CT5)"), mono("v1"), "문서·계약 › 계약서 불러오기", "레이블", "4", "마스터 보유 주장 " + badge("VERIFIED", "ok"), "1"],
             [sub("권리 확인서 · 작가용", "새 템플릿(CT5)"), mono("v1"), "문서·계약 › 계약서 불러오기", "작가 전원(전자서명 링크)", "5", "작가 지분 주장 " + badge("VERIFIED", "ok"), "1"]],
            foot="권리 확인서는 원본 계약을 대체하지 않고 확인·정리한다. 원본은 조항에 근거로 적힌다. 새 버전이 나와도 이미 서명된 계약은 서명 당시 버전에 고정된다.",
            title=("표준 계약 템플릿", "플랫폼 법무 관리"), min_w=900),
      table(["읽기 틀(계약 양식)", "쓰는 계약", "읽는 항목", "등록", "승인", "쓴 횟수"],
            [[sub("빅히트 작품 퍼블리싱 계약 양식", "v1 · 쪽 4"), "작품 퍼블리싱 계약", "곡명 · 작가 · 작가별 지분 · 효력 시작", sub("usr_admin", "01-02 10:20"), badge("플랫폼 승인 01-02", "ok"), "1"],
             [sub("빅히트 녹음 계약 양식", "v1 · 쪽 6"), "녹음 계약", "녹음 · 마스터 보유자 · 효력 시작", sub("usr_admin", "01-02 10:05"), badge("플랫폼 승인 01-02", "ok"), "1"]],
            foot="읽기 틀은 계약 양식에서 값이 있는 위치(쪽·조항)를 IR 항목에 대응시킨 것이다. 같은 양식의 계약을 불러오면 값이 후보로 채워진다. 계약서는 플랫폼 밖으로 보내지 않는다(CT1). 처음 보는 양식은 사람이 조항을 표시한다.",
            title=("계약서 읽기 틀", "빅히트 등록 · 플랫폼 승인(CT2)"), min_w=900)], height=1100)

# ── 점검 › 정합성 점검 전체(작품 묶음) ──
page("Ops-Validation.dc.html", "운영 관리 — 정합성 점검 전체", "op-validation", "2026-01-12 09:00",
     ["운영 관리", "점검", "정합성 점검 전체"], "정합성 점검 전체",
     "작품마다 정합성 점검 결과. 차단이 있으면 그 곡의 분배 규칙을 활성화하지 못한다. 작품을 누르면 걸린 항목을 펼친다",
     [button("다시 점검")],
     [stats([("차단", "0", "", False), ("경고", "2", "Dynamite 2 · 기한 01-16", True), ("통과 작품", "1 / 2", "푸른 계절", False), ("마지막 점검", "09:00", "2026-01-12", False)]),
      filters("곡명, 규칙", [("수준", ["전체", "경고 이상", "차단"])]),
      grouped(["차단", "경고", "통과 규칙", "상태"],
              [dict(name="Dynamite", sub="녹음 Vocal Recombination", cells=["0", '<span style="color: #b45309; font-weight: 700">2</span>', "5 / 7", badge("경고", "warn")],
                    rows=[["확인 대기", badge("경고", "warn"), "작가 지분 50% · David Stewart", "작가 서명 대기 · 기한 01-16 지나면 차단", link("확인·동의 탭 →")],
                          ["확인 대기", badge("경고", "warn"), "작가 지분 50% · Jessica Agombar", "작가 서명 대기 · 기한 01-16 지나면 차단", link("확인·동의 탭 →")]],
                    note="통과: 지분 합계 · 근거 문서 · 마스터 보유자 · 스템 실연자 · 파트 원곡 스템"),
               dict(name="푸른 계절", sub=EX, cells=["0", "0", "7 / 7", badge("통과", "ok")], rows=[], empty="걸린 항목이 없습니다. 규칙 7개 모두 통과.")],
              ["규칙", "수준", "대상", "내용", ""],
              foot="수준 '전체'가 처음 값이다. 작품을 누르면 그 작품의 걸린 항목만 펼친다.")], height=1000)

# ── 정산 › 명세·지급 ──
page("Ops-Statements.dc.html", "운영 관리 — 명세·지급", "op-statements", "2026-05-01 09:01",
     ["운영 관리", "정산", "명세·지급"], "명세·지급",
     "빅히트 뮤직 당사자가 받는 정산 명세와 지급. 금액은 플랫폼이 확정한 정산 배치에서 온다",
     [button("명세 내려받기(PDF)")],
     [stats([("이번 지급", "4,910,080원", "pay-2026-05 · 05-01", False), ("받는 당사자", "4", "레이블 · 소속사 · 작가 2", False),
             ("정산 기간", "2026년 3월", "bat_bts_2026_03 확정", False), ("보류", "1건", "이상거래 · 2,310원", True)]),
      filters("당사자", [("기간", ["2026년 3월", "2026년 2월"]), ("상태", ["전체", "PAID", "대기"])]),
      table(["받는 당사자", "역할", "정산 기간", "지급(원)", "계좌", "상태", ""],
            [["빅히트 뮤직(레이블)", "녹음 몫", "2026-03", mono("2,030,952"), mono("••••abel"), badge("PAID", "ok"), link("명세 보기")],
             ["빅히트 뮤직 매니지먼트(소속사)", "실연 몫(멤버 7 수령 위임)", "2026-03", mono("2,285,920"), mono("••••ency"), badge("PAID", "ok"), link("명세 보기")],
             [sub("David Stewart(작가)", "해외 · 원천징수"), "작품 몫 50%", "2026-03", mono("296,604"), mono("••••_ds"), badge("PAID", "ok"), link("명세 보기")],
             [sub("Jessica Agombar(작가)", "해외 · 원천징수"), "작품 몫 50%", "2026-03", mono("296,604"), mono("••••_ja"), badge("PAID", "ok"), link("명세 보기")]],
            foot="작가는 빅히트가 관리하는 당사자다. 작가 지급액은 원천징수 뒤 금액(원천징수 작가 각 83,650원, 합계 167,300원). 계좌·세금 정보는 빅히트가 등록하고 플랫폼은 지급만 실행한다. 멤버별 기여분은 실연자 앱에서 본인이 본다."),
      card("조합별 매출(이번 정산)", table(["조합", "구매", "매출(원)"],
           [["원곡 배치 · " + mono("vc_bts_orig"), "1,200", mono("3,960,000")], ["정국·지민 맞바꾸기 · " + mono("vc_bts_swap"), "500", mono("1,650,000")],
            ["랩 파트를 보컬 멤버가 · " + mono("vc_bts_vocal"), "300", mono("990,000")], ["진이 정국·지민 파트까지 · " + mono("vc_bts_jin"), "200", mono("660,000") + " · 보류 1"]], min_w=600),
           hint="합계 7,260,000원 · 발행 조합 화면과 같다")])

# ── 정산 › 발행 조합(작품 묶음) ──
page("Ops-Issues.dc.html", "운영 관리 — 발행 조합", "op-issues", "2026-04-01 09:00",
     ["운영 관리", "정산", "발행 조합"], "발행 조합",
     "팬앱에서 발행된 보컬 조합. 발행 순간의 IR(facts·정책·조합 지분·멤버)이 봉인되어 정산 근거가 된다. 작품을 누르면 조합을 펼친다",
     [button("엑셀 다운로드")],
     [stats([("발행 조합", "4", "작품 1", False), ("구매", "2,200", "2026년 3월", False), ("매출", "7,260,000원", "", False), ("보류", "1건", "이상거래", True)]),
      filters("조합 id, 이름", [("팩", ["팩 전체", "DYNAMITE-FAN"])]),
      grouped(["조합", "구매", "매출(원)", "보류"],
              [dict(name="Dynamite", sub="팩 DYNAMITE-FAN", cells=["4", mono("2,200"), mono("7,260,000"), badge("1건", "warn")],
                    rows=[[sub("원곡 배치", "vc_bts_orig"), "없음(원곡 스템 그대로)", mono("02-01 09:30"), badge("facts v1 · 정책 v1", "ir"), mono("1,200"), mono("3,960,000")],
                          [sub("정국·지민 맞바꾸기", "vc_bts_swap"), "정국 ↔ 지민 파트", mono("02-03 18:12"), badge("facts v1 · 정책 v1", "ir"), mono("500"), mono("1,650,000")],
                          [sub("랩 파트를 보컬 멤버가", "vc_bts_vocal"), "Verse 2 (Rap) 파트 3", mono("02-05 20:40"), badge("facts v1 · 정책 v1", "ir"), mono("300"), mono("990,000")],
                          [sub("진이 정국·지민 파트까지", "vc_bts_jin"), "정국 · 지민 파트 → 진", mono("02-09 11:05"), badge("facts v1 · 정책 v1", "ir"), mono("200"), sub(mono("660,000"), "이상거래 1건 보류")]])],
              ["조합", "바꾼 곳", "발행", "봉인", "구매", "매출(원)"],
              foot="발행 승인 대기는 없다 — 게이트를 통과하면 바로 봉인된다(MD8).")])

# ── 조직 › 내 조직 ──
page("Ops-Org.dc.html", "운영 관리 — 내 조직", "op-org", "2026-01-20 09:00",
     ["운영 관리", "조직", "내 조직"], "빅히트 뮤직",
     "권리 테넌트 · 레이블 · tnt_bighit",
     [badge("활성 · 01-20", "ok")],
     [card("조직 정보", kv([("이름", "빅히트 뮤직"), ("구분", "권리 테넌트 · 레이블"), ("사업자 번호", mono("BRN-DEMO-BIGHIT")), ("국가", "KR"),
                            ("상태", "신청 01-01 → 확인됨 01-02 → 활성 01-20"), ("플랫폼 이용계약", "v1 반영 · 01-02")])),
      card("확인 항목(KYB)", table(["항목", "근거", "상태"],
           [["사업자 확인", "사업자 확인서", badge("확인됨", "ok")], ["대표자", "대표자 확인서", badge("확인됨", "ok")],
            ["플랫폼 이용 계약", "플랫폼 이용계약 v1 서명본", badge("확인됨", "ok")], ["권리 보유 증빙", "Dynamite 녹음 계약서 v1", badge("확인됨", "ok")]], min_w=600, paged=False),
           hint="플랫폼이 확인한다. 빅히트는 조회만"),
      card("당사자", table(["당사자", "역할", "쓰인 곳"],
           [["빅히트 뮤직(레이블)", "녹음 권리 · 마스터 보유", "Dynamite · 푸른 계절"], ["빅히트 뮤직 매니지먼트(소속사)", "실연 수익 수령 위임", "멤버 7 · 블루노트 · 하람"]], min_w=600),
           hint="당사자 등록(E09)")], height=1100)

# ── 조직 › 담당자 계정 ──
page("Ops-Accounts.dc.html", "운영 관리 — 담당자 계정", "op-accounts", "2026-01-20 09:00",
     ["운영 관리", "조직", "담당자 계정"], "담당자 계정",
     "빅히트 뮤직 소속으로 일하는 계정과 역할",
     [button("담당자 초대 — 상용 단계", disabled=True)],
     [table(["계정", "역할", "할 수 있는 일", "소속 시작", "상태"],
            [[sub("총괄 · usr_admin", "플랫폼 운영 소속도 가짐"), mono("RIGHTS_ALL"), "권리 편집 · 정책 편집 · 승인 · 활성화 · 조직 관리", mono("01-01"), badge("소속됨", "ok")]],
            foot="MVP는 총괄 한 사람이 전부 처리한다(RD1). 직무 분리는 꺼져 있다(RD6). 역할은 기능 → 권한 → 역할 데이터로 되어 있어, 나중에 역할을 나눠 담당자를 초대할 수 있다(테넌트 자체 역할은 상용 단계, RD8).", min_w=860),
      note("멤버(실연자)는 이 목록에 없다. 멤버는 실연자 앱에서 본인 계정으로 확인·동의한다.")])

# ── 조직 › 위임 대행 (MVP 빈 화면) ──
page("Ops-Delegation.dc.html", "운영 관리 — 위임 대행", "op-delegation", "2026-01-20 09:00",
     ["운영 관리", "조직", "위임 대행"], "위임 대행",
     "다른 조직이 빅히트 뮤직을 대신해 업무를 하도록 맡긴 것",
     [],
     [table(["대행 조직", "맡긴 업무", "열리는 권한", "기간", "상태"], [], min_w=860,
            empty="맡긴 업무가 없습니다. MVP에서는 쓰지 않는 메뉴입니다.")])

# ── 조직 › 신탁·유통 연결 (MVP 빈 화면) ──
page("Ops-Links.dc.html", "운영 관리 — 신탁·유통 연결", "op-links", "2026-01-20 09:00",
     ["운영 관리", "조직", "신탁·유통 연결"], "신탁·유통 연결",
     "참여 기관(신탁단체·유통 파트너)과 양쪽이 확인한 연결",
     [],
     [table(["상대 기관", "구분", "대상", "기간", "상태"], [], min_w=860,
            empty="연결이 없습니다. MVP에서는 쓰지 않는 메뉴입니다.")])


WS_TABS = ["원곡 권리", "스템", "확인·동의", "문서·계약", "분배 규칙·팩", "승인·출시", "변경 기록"]


def ws_page(fname, title, active_tab, clock, crumbs, h1, desc, actions, body, ready, height=1100, status=None, band_label="IR 생성 준비"):
    """작품 워크스페이스 화면: 경로 → IR 생성 준비 띠 → 제목(IR 상태 배지) → 탭 줄 → 본문 (시안 Nav-Works-Stems와 같은 틀)."""
    # 위쪽 띠는 곡 진행 ①~⑤(2026-10-24). ready는 옛 호출 호환용으로만 받는다
    band = progress(PROG_LOCKED if band_label == "IR 상태" else PROG_DEFAULT)
    tabs = "".join(
        f'<span style="padding: 10px 16px; font-weight: 700; color: {NAVY}; border-bottom: 3px solid {NAVY}; margin-bottom: -1px">{t}</span>' if t == active_tab
        else (f'<span style="padding: 10px 16px; font-weight: 600; color: #334155">{t}</span>' if t == "변경 기록" else f'<a href="#" style="padding: 10px 16px; font-weight: 600; text-decoration: none; color: #334155">{t}</a>')
        for t in WS_TABS)
    tabrow = f'<div role="tablist" aria-label="워크스페이스 탭" style="display: flex; gap: 4px; border-bottom: 1px solid #cbd5e1; overflow-x: auto; font-size: 15px">{tabs}</div>\n'
    key = "ws"  # 사이드 메뉴는 곡 단위로 활성, 곡 안의 화면은 탭으로 고른다
    page(fname, title, key, clock, crumbs, h1, desc,
         actions + [status or badge("IR 생성 전 — 등록·조회·수정 가능", "ok")], body, height=height, before_title=band, after_title=tabrow)


def steps(items, current):
    """단계 표시: 완료 = 완료 토큰, 지금 = 흰 바탕 2px 주색, 남음 = 흰 바탕 점선."""
    out = []
    for i, label in enumerate(items, 1):
        if i < current:
            st = "background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; font-weight: 600"
            mark = "✓ "
        elif i == current:
            st = f"background: #ffffff; border: 2px solid {NAVY}; color: {NAVY}; font-weight: 700"
            mark = ""
        else:
            st = "background: #ffffff; border: 1px dashed #cbd5e1; color: #334155; font-weight: 600"
            mark = ""
        out.append(f'<div style="flex: 1 1 140px; padding: 10px 14px; border-radius: 10px; font-size: 13.5px; {st}">{mark}{i} {label}</div>')
    return '<div style="display: flex; flex-wrap: wrap; gap: 6px">' + "".join(out) + "</div>"


def check(on):
    return ('<span aria-label="확인함" style="display: inline-flex; width: 18px; height: 18px; border-radius: 4px; background: #1e3a8a; color: #ffffff; font-size: 12px; align-items: center; justify-content: center">✓</span>'
            if on else '<span aria-label="확인 안 함" style="display: inline-block; width: 16px; height: 16px; border-radius: 4px; border: 1px solid #94a3b8; background: #ffffff"></span>')


def field(label, control, hint=""):
    h = f'<div style="font-size: 12px; color: #334155">{hint}</div>' if hint else ""
    return f'<label style="display: flex; flex-direction: column; gap: 6px; font-size: 14px"><span style="font-weight: 700; color: #0f172a">{label}</span>{control}{h}</label>'


def chips(opts, on):
    return '<div style="display: flex; flex-wrap: wrap; gap: 6px">' + "".join(
        f'<span style="font-size: 13px; padding: 4px 10px; border-radius: 999px; {"background: #eff6ff; color: #1e3a8a; border: 1px solid #93c5fd; font-weight: 700" if o in on else "background: #ffffff; color: #334155; border: 1px solid #cbd5e1; font-weight: 600"}">{o}</span>'
        for o in opts) + "</div>"


# 이용 범위 어휘는 표준 계약 템플릿(마이그레이션 0032)과 같다
USE_ACTIONS = ["미리듣기", "조합 생성", "개인 보관", "링크 공유", "내려받기"]
USE_TERRITORIES = ["대한민국", "일본", "미국"]
USE_MEDIA = ["팬앱", "외부 SNS"]
USE_AUDIENCE = ["팬 커뮤니티", "전체 공개"]
INPUT = SELECT
READY_IMPORT = [("✓ 합계 100%", "#047857"), ("✓ 근거 문서", "#047857"), ("! 원곡 스템 34 중 2 등록", "#b45309"), ("! 확인 대기", "#b45309"), ("· 위임 서명 1/7", "#334155")]
IMPORT_STEPS = ["계약서 불러오기", "후보 값 확인", "IR 정보 대조", "빠진 것 입력", "권리 확인서 서명"]

# ── 작품 워크스페이스 › 문서·계약 › 계약서 불러오기 ──
cand = lambda item, val, where, quote, state, ok: [item, val, sub(where, "“" + quote + "”"), state, check(ok)]
ws_page("Song-Import.dc.html", "Dynamite — 계약서 불러오기", "문서·계약", "2026-01-03 09:00",
        ["작품 관리", "작품 워크스페이스", "Dynamite", "문서·계약", "계약서 불러오기"], "계약서 불러오기",
        "원본 계약서에서 권리 정보 후보를 채우고, IR에 필요한 것 중 빠진 것을 입력한 뒤 권리 확인서로 서명한다",
        [],
        [steps(IMPORT_STEPS, 4),
         card("불러온 계약서", kv([
             ("문서", "Dynamite 작품 퍼블리싱 계약서 v1 (PDF) · 4쪽 · " + link("원문 보기")),
             ("읽기 틀", badge("양식 일치", "ok") + " 빅히트 작품 퍼블리싱 계약 양식 v1 — 값 4개를 후보로 채움"),
             ("원천 문서", mono("doc_pub_dynamite") + " · sha256 " + mono("9f3c…a71e") + " · 01-03 08:52 저장(원본 보존)"),
             ("당사자", "David Stewart · Jessica Agombar(작가, 빅히트 관리 당사자)")]), hint="① 완료"),
         table(["항목", "후보 값", "근거(쪽·조항)", "기존 입력과", "확인"],
               [cand("곡명", "Dynamite", "1쪽 제1조", "본 계약의 대상 저작물은 「Dynamite」", badge("일치", "ok"), True),
                cand("작가 · 지분 1", "David Stewart · 작사·작곡 50%", "2쪽 제3조 1항", "작가 갑의 지분은 50퍼센트", badge("일치", "ok"), True),
                cand("작가 · 지분 2", "Jessica Agombar · 작사·작곡 50%", "2쪽 제3조 2항", "작가 을의 지분은 50퍼센트", badge("일치", "ok"), True),
                cand("효력 시작", mono("2026-01-01"), "1쪽 제2조", "2026년 1월 1일부터 효력", badge("새 값", "blue"), True)],
               foot="후보 값은 사람이 하나씩 확인한다. 기존 입력(원곡 권리)과 다르면 '다름'으로 표시되고 어느 쪽을 쓸지 고른다.",
               title=("② 후보 값", "4 / 4 확인함"), paged=False, min_w=860),
         card("③ IR 정보 대조 — 이 곡 전체", table(["묶음", "필요한 것", "어디서 채우나", "상태"],
              [["작품", "곡명 · 작가 · 지분 합 100%", "이 계약서", badge("채움", "ok")],
               ["작품", "팬앱 이용 범위 · 기간", "원본 계약에 없음 → 아래 입력", badge("빠짐", "warn")],
               ["녹음", "녹음 · 마스터 보유자", "녹음 계약서(01-02 불러옴, 레이블용 확인서 서명됨)", badge("채움", "ok")],
               ["실연", "슬롯·파트 담당 · 보이스 소유", "실연자 앱 확인(멤버 본인)", badge("진행 중", "gray")],
               ["수령 위임", "멤버 → 소속사", "수령 위임계약", badge("1 / 7", "gray")]], paged=False, min_w=760),
              hint="빠짐이 남아 있으면 권리 확인서로 넘어가지 않는다"),
         card("④ 빠진 것 입력", '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px">'
              + field("이용 행위", chips(USE_ACTIONS, ["미리듣기", "조합 생성", "개인 보관"]), "멤버 이용 동의·팩 이용 범위와 같아야 한다")
              + field("지역", chips(USE_TERRITORIES, USE_TERRITORIES))
              + field("매체 · 공개 대상", chips(USE_MEDIA + USE_AUDIENCE, ["팬앱", "팬 커뮤니티"]))
              + field("기간 끝", f'<input value="2030-12-31" style="{INPUT}; font-variant-numeric: tabular-nums">', "원본 계약 기간을 넘지 않게")
              + "</div>", hint="원본 계약에 없는 값"),
         '<div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end">' + button("임시 저장") + button("권리 확인서 만들기 →", primary=True) + "</div>"],
        READY_IMPORT, height=1600)

# ── 작품 워크스페이스 › 문서·계약 › 권리 확인서 ──
clause = lambda no, head, body_: f'<div style="display: flex; flex-direction: column; gap: 4px"><strong style="font-size: 14px">{no} {head}</strong><div style="font-size: 14px; color: #1e293b; line-height: 1.6">{body_}</div></div>'
share_tbl = ('<table style="border-collapse: collapse; font-size: 14px; margin-top: 4px"><thead><tr>'
             + "".join(f'<th style="padding: 6px 12px; text-align: left; font-size: 13px; color: #334155; background: #f8fafc">{h}</th>' for h in ["작가", "역할", "지분", "수령"])
             + '</tr></thead><tbody>'
             + '<tr style="border-top: 1px solid #e2e8f0"><td style="padding: 6px 12px">David Stewart</td><td style="padding: 6px 12px">작사·작곡</td><td style="padding: 6px 12px; font-variant-numeric: tabular-nums">50.00%</td><td style="padding: 6px 12px">작가 본인(빅히트 관리)</td></tr>'
             + '<tr style="border-top: 1px solid #e2e8f0"><td style="padding: 6px 12px">Jessica Agombar</td><td style="padding: 6px 12px">작사·작곡</td><td style="padding: 6px 12px; font-variant-numeric: tabular-nums">50.00%</td><td style="padding: 6px 12px">작가 본인(빅히트 관리)</td></tr>'
             + '</tbody></table>')
doc = ('<article style="display: flex; flex-direction: column; gap: 14px; padding: 18px 22px; border: 1px solid #cbd5e1; border-radius: 10px; background: #ffffff">'
       '<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center"><h3 style="margin: 0; font-size: 18px">권리 확인서 — 작가용</h3>' + badge("템플릿 v1", "gray") + badge("미리보기", "blue") + '</div>'
       + clause("제1조", "대상", "작품 「Dynamite」, 녹음 Vocal Recombination(빅히트 뮤직 레이블)")
       + clause("제2조", "작가와 지분", "아래 작가와 지분을 확인한다. 지분의 합은 100%다." + share_tbl)
       + clause("제3조", "이용 범위", "이용 행위 미리듣기·조합 생성·개인 보관, 지역 대한민국·일본·미국, 매체 팬앱, 공개 대상 팬 커뮤니티, 2026-01-01 ~ 2030-12-31")
       + clause("제4조", "근거", "Dynamite 작품 퍼블리싱 계약서 v1 제3조(" + mono("doc_pub_dynamite") + ", sha256 " + mono("9f3c…a71e") + ")")
       + clause("제5조", "원본과의 관계", "이 확인서는 원본 계약을 대체하지 않는다. 원본과 다르면 원본이 우선하고, 다름은 분쟁으로 처리한다.")
       + '</article>')
ws_page("Song-ClaimConfirm.dc.html", "Dynamite — 권리 확인서", "문서·계약", "2026-01-03 09:20",
        ["작품 관리", "작품 워크스페이스", "Dynamite", "문서·계약", "권리 확인서"], "권리 확인서",
        "불러온 계약서와 입력한 값으로 만든 표준 계약. 서명하면 권리 주장이 서명본을 근거로 바로 VERIFIED가 된다",
        [],
        [steps(IMPORT_STEPS, 5),
         '<div style="display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start">'
         + '<div style="flex: 2 1 560px; min-width: 0">' + doc + '</div>'
         + '<div style="flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 14px">'
         + card("서명", table(["서명자", "방법", "상태"],
                [["David Stewart", "전자서명 링크(계정 없음) · 이메일", badge("대기", "warn")],
                 ["Jessica Agombar", "전자서명 링크(계정 없음) · 이메일", badge("대기", "warn")]], paged=False, min_w=320), hint="작가 전원 · 한 부")
         + card("서명하면 만들어지는 기록", kv([("권리 주장", "작가 지분 2건(WRITTEN_BY) " + badge("VERIFIED", "ok")),
                                               ("이용 동의", "작품 이용 동의 2건(작가마다 1건) " + badge("VERIFIED", "ok")),
                                               ("원천 문서", "확인서 서명본 + 원본 계약 근거 연결"),
                                               ("확인 요청", "상대 확인 14일 대기 없음 — 경고 2건이 닫힌다")]))
         + '</div></div>',
         table(["확인서", "담는 권리", "서명", "상태", ""],
               [["레이블용", "마스터 보유 · 빅히트 뮤직(레이블)", "빅히트 뮤직(레이블)", badge("서명됨 · 01-02", "ok"), link("서명본 보기")],
                ["작가용", "작가 지분 2 · 작품 이용 범위", "작가 2(전자서명 링크)", badge("서명 요청 전", "gray"), link("미리보기")]],
               foot="멤버의 보이스 소유·파트 담당은 확인서가 아니라 실연자 앱 확인으로 받는다.", title=("이 곡의 권리 확인서", "2부"), min_w=760),
         '<div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end">' + button("← 입력으로") + button("서명 요청 보내기", primary=True) + "</div>"],
        READY_IMPORT, height=1500)


# ── 계약서 불러오기 ① 문서 고르기 ──
ws_page("Song-Import-Start.dc.html", "Dynamite — 계약서 불러오기 시작", "문서·계약", "2026-01-03 08:50",
        ["작품 관리", "작품 워크스페이스", "Dynamite", "문서·계약", "계약서 불러오기"], "계약서 불러오기",
        "원본 계약서에서 권리 정보 후보를 채우고, IR에 필요한 것 중 빠진 것을 입력한 뒤 권리 확인서로 서명한다",
        [],
        [steps(IMPORT_STEPS, 1),
         card("① 계약서 고르기", '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; align-items: end">'
              + field("원천 문서", f'<select style="{INPUT}"><option>Dynamite 작품 퍼블리싱 계약서 v1 (PDF) · 4쪽 · 01-02</option><option>Dynamite 녹음 계약서 v1 (PDF) · 6쪽 · 01-02</option></select>',
                      "이 곡의 원천 문서에서 고른다. 없으면 " + link("+ 새 문서 올리기"))
              + field("읽기 틀", '<div style="padding: 8px 0">' + badge("양식 일치", "ok") + " 빅히트 작품 퍼블리싱 계약 양식 v1 — 값 4개를 후보로 채운다</div>",
                      "일치하는 읽기 틀이 없으면 사람이 조항을 표시해 값을 넣는다")
              + "</div>"
              + '<div style="display: flex; justify-content: flex-end">' + button("불러오기", primary=True) + "</div>", hint="계약서는 플랫폼 밖으로 보내지 않는다"),
         table(["계약서", "읽기 틀", "불러온 때", "단계", "확인서", ""],
               [["Dynamite 녹음 계약서 v1", "빅히트 녹음 계약 양식 v1", mono("01-02 10:30"), badge("끝", "ok"), "레이블용 · 서명됨", link("보기")]],
               foot="한 문서는 한 번에 하나만 불러온다. 끝난 불러오기는 조회만 한다.", title=("이 곡의 불러오기", "1건"), min_w=860)],
        READY_IMPORT, height=1000)

# ── 계약서 불러오기 — 후보 값 상태(다름 · 사람이 입력) ──
small = lambda ph, w="120px", mono_=False: f'<input placeholder="{ph}" style="{INPUT}; width: {w}' + ('; font-variant-numeric: tabular-nums' if mono_ else '') + '">'
radio = lambda label, on: (f'<label style="display: inline-flex; align-items: center; gap: 6px; font-size: 13px; margin-right: 12px">'
                           f'<span style="display: inline-block; width: 14px; height: 14px; border-radius: 999px; border: {"4px solid #1e3a8a" if on else "1px solid #94a3b8"}; background: #ffffff; box-sizing: border-box"></span>{label}</label>')
ws_page("Song-Import-Values.dc.html", "Dynamite — 후보 값(다름 · 사람이 입력)", "문서·계약", "2026-01-03 09:00",
        ["작품 관리", "작품 워크스페이스", "Dynamite", "문서·계약", "계약서 불러오기"], "계약서 불러오기",
        "후보 값이 기존 입력과 다를 때와, 읽기 틀이 값을 찾지 못해 사람이 입력할 때",
        [],
        [steps(IMPORT_STEPS, 2),
         table(["항목", "후보 값", "근거(쪽·조항)", "기존 입력과", "확인"],
               [["작가 · 지분 1", sub("David Stewart · 작사·작곡 50%", "기존 입력: 45%"), sub("2쪽 제3조 1항", "“작가 갑의 지분은 50퍼센트”"),
                 badge("다름", "err") + '<div style="margin-top: 6px">' + radio("계약서 값 50%", True) + radio("기존 값 45%", False) + "</div>", check(False)],
                ["효력 시작", '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + small("2026-01-01", "130px", True) + "</div>",
                 '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + small("쪽", "60px") + small("조항", "90px") + small("인용 문장(선택)", "220px") + "</div>",
                 badge("사람이 입력", "gray"), check(False)]],
               foot="다름: 고른 값으로 확인서를 만든다. 계약서 값을 고르면 원곡 권리의 기존 주장이 새 버전으로 바뀌고, 기존 값을 고르면 원본과 다르다는 표시가 남는다(확인서 제5조 — 원본 우선, 다름은 분쟁). 사람이 입력: 값과 근거 위치를 넣고 확인한다.",
               title=("② 후보 값", "2 / 4 확인함"), paged=False, min_w=900)],
        READY_IMPORT, height=900)

# ── 권리 확인서 — 서명 끝, 기록 반영 ──
ws_page("Song-ClaimConfirm-Apply.dc.html", "Dynamite — 권리 확인서 기록 반영", "문서·계약", "2026-01-12 15:30",
        ["작품 관리", "작품 워크스페이스", "Dynamite", "문서·계약", "권리 확인서"], "권리 확인서",
        "모든 서명자가 끝나면 기록을 반영한다. 반영하면 권리 주장이 서명본을 근거로 VERIFIED가 된다",
        [],
        [steps(IMPORT_STEPS, 5),
         '<div style="display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start">'
         + '<div style="flex: 1 1 520px; min-width: 0">' + card("서명", table(["서명자", "방법", "상태"],
                [["David Stewart", "전자서명 링크(계정 없음) · 이메일", badge("서명 · 01-10", "ok")],
                 ["Jessica Agombar", "전자서명 링크(계정 없음) · 이메일", badge("서명 · 01-12", "ok")]], paged=False, min_w=420), hint="작가용 · 2 / 2 끝") + '</div>'
         + '<div style="flex: 1 1 380px; min-width: 0">' + card("반영하면 만들어지는 기록", kv([("권리 주장", "작가 지분 2건(WRITTEN_BY) " + badge("VERIFIED", "ok")),
                                               ("이용 동의", "작품 이용 동의 2건(작가마다 1건) " + badge("VERIFIED", "ok")),
                                               ("원천 문서", "확인서 서명본 + 원본 계약 근거 연결"),
                                               ("확인 요청", "열린 확인 요청 2건이 닫히고 정합성 경고 2건이 닫힌다")])) + '</div></div>',
         note("반영은 한 번만 한다. 반영한 뒤에는 확인서와 만들어진 기록을 고칠 수 없고, 바로잡기는 새 확인서로 한다."),
         '<div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end">' + button("서명본 보기") + button("기록 반영", primary=True) + "</div>"],
        [("✓ 합계 100%", "#047857"), ("✓ 근거 문서", "#047857"), ("! 확인 대기 2 → 반영하면 닫힘", "#b45309"), ("· 위임 서명 7/7", "#334155")], height=900)

# ── 운영 관리 › 계약 템플릿 › 읽기 틀 등록 ──
filled = lambda v, w: f'<input value="{v}" style="{INPUT}; width: {w}">'
frow = lambda item, pg, cl, pat, quote, got: [item, filled(pg, "56px"), filled(cl, "96px"), f'<input value="{pat}" style="{INPUT}; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px">', f'<span style="font-size: 13px; color: #1e293b">“{quote}”</span>', got]
page("Ops-FrameNew.dc.html", "운영 관리 — 읽기 틀 등록", "op-templates", "2026-01-02 10:10",
     ["운영 관리", "계약·문서", "계약 템플릿", "읽기 틀 등록"], "읽기 틀 등록",
     "계약 양식에서 값이 있는 위치(쪽·조항)와 값 모양을 IR 항목에 대응시킨다. 빅히트가 등록하고 플랫폼이 승인한다(CT2)",
     [],
     [card("양식", '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px">'
           + field("양식 이름", f'<input value="빅히트 작품 퍼블리싱 계약 양식" style="{INPUT}">')
           + field("쓰는 계약", f'<select style="{INPUT}"><option>작품 퍼블리싱 계약</option><option>녹음 계약</option></select>')
           + field("기준 문서", f'<select style="{INPUT}"><option>Dynamite 작품 퍼블리싱 계약서 v1 (PDF) · 4쪽</option></select>', "이 양식으로 쓴 계약서 하나를 골라 위치를 맞춘다")
           + "</div>"),
      table(["IR 항목", "쪽", "조항", "값 모양", "기준 문서 인용", "미리보기"],
            [frow("곡명", "1", "제1조", "대상 저작물은 「{text}」", "본 계약의 대상 저작물은 「Dynamite」", "Dynamite"),
             frow("작가 · 지분", "2", "제3조 1항", "작가 갑의 지분은 {percent}퍼센트", "작가 갑의 지분은 50퍼센트", "50%"),
             frow("작가 · 지분", "2", "제3조 2항", "작가 을의 지분은 {percent}퍼센트", "작가 을의 지분은 50퍼센트", "50%"),
             frow("효력 시작", "1", "제2조", "{date}부터 효력", "2026년 1월 1일부터 효력", mono("2026-01-01"))],
            foot="값 모양의 기호: {text} 글자 · {percent} 퍼센트 · {bps} 만분율 · {date} 날짜 · {party} 당사자 이름. 기준 문서 인용에 값 모양이 맞으면 미리보기에 값이 나온다. 맞지 않으면 빨간 글씨로 '모양 안 맞음'.",
            title=("항목", "4개 · " + link("+ 항목 추가")), paged=False, min_w=1000),
      '<div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end">' + button("임시 저장") + button("승인 요청", primary=True) + "</div>"],
     height=1000)



# ── 원곡 권리(IR 생성 뒤) — 새 버전 만들기: 안내 띠 자리에 열린다(취소·저장하면 다시 안내 띠) ──
LOCK_STATUS = badge("IR 생성됨 v1 · 2026-02-01 09:00 — 조회만", "ir")
LOCK_READY = [("IR v1", "#3730a3"), ("facts v1 · 정책 v1 digest 고정", "#334155"), ("원곡 권리·스템은 조회만(바로잡기는 새 버전)", "#334155")]
TYPES = ["작품 · 작사·작곡", "녹음 · 마스터", "실연 · 보이스·파트 담당"]


def type_select(on):
    return f'<select aria-label="권리자 유형" style="{SELECT}; font-weight: 700">' + "".join(f'<option{" selected" if t == on else ""}>{t}</option>' for t in TYPES) + "</select>"


def fix_box(kind, rows_html, side, foot):
    """안내 띠를 대신하는 편집 상자: 머리(제목 · 권리자 유형) → 입력 → 저장하면 순서 → 취소·저장."""
    return (f'<section aria-label="새 버전 만들기" style="{CARD}; border: 2px solid #3730a3; padding: 18px; display: flex; flex-direction: column; gap: 14px">'
            f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center"><h2 style="margin: 0; font-size: 16px; font-weight: 700">새 버전 만들기</h2>'
            f'{field("권리자 유형", type_select(kind))}<span style="font-size: 13px; color: #334155">권리자·근거 문서 목록은 고른 유형으로 걸러진다. v1은 그대로 남는다</span></div>'
            f'{rows_html}{side}{note(foot)}'
            f'<div style="display: flex; gap: 8px; justify-content: flex-end">{button("취소")}{button("새 버전 저장", primary=True)}</div></section>')


locked_cards = [
    table(["권리자", "역할", "지분", "버전", "IR v1", "상태"],
          [["David Stewart", "작사·작곡", mono("50%"), "v1", "포함", badge("확정", "ok")], ["Jessica Agombar", "작사·작곡", mono("50%"), "v1", "포함", badge("확정", "ok")]],
          title=("작품 · 작사·작곡", "수정·삭제 닫힘"), paged=False, min_w=760),
    table(["권리자", "지분", "버전", "IR v1", "상태"], [["빅히트 뮤직 — 레이블", mono("100%"), "v1", "포함", badge("확정", "ok")]],
          title=("녹음 · 마스터", "수정·삭제 닫힘"), paged=False, min_w=760),
    table(["멤버", "보이스", "원곡 파트 담당", "버전", "IR v1", "상태"],
          [[m, mono(v), n, "v1", "포함", badge("확정", "ok")] for m, v, n in
           [("정국", "voc_jungkook", "파트 6"), ("지민", "voc_jimin", "파트 5"), ("뷔", "voc_v", "파트 3"), ("진", "voc_jin", "파트 3"), ("RM", "voc_rm", "파트 1"), ("제이홉", "voc_jhope", "파트 1"), ("슈가", "voc_suga", "파트 1")]],
          title=("실연 · 멤버 보이스·파트 담당", "수정·삭제 닫힘 · 지분 없음(조합마다 부른 시간으로 계산)"), paged=False, min_w=760),
]
SEL = lambda opts, w="100%": f'<select style="{SELECT}; width: {w}">' + "".join(f"<option>{o}</option>" for o in opts) + "</select>"
NUM = lambda v: f'<input value="{v}" style="{SELECT}; width: 90px; text-align: right; {MONO}">'

work_rows = table(["권리자(작가만)", "지분(%)", "저장하면"],
                  [["David Stewart · v1 50% → v2", NUM("40"), badge("작가 전자서명 링크로 확인", "warn")],
                   ["Jessica Agombar · v1 50% → v2", NUM("40"), badge("작가 전자서명 링크로 확인", "warn")],
                   [SEL(["(새) 작가 — 빅히트 관리 작가 명부에서", "김작가(작가)", "Lee Writer(작가)"]), NUM("20"), badge("작가 전자서명 링크로 확인", "warn")]],
                  foot="합계 100%여야 저장된다(지금 100%).", paged=False, min_w=700)
work_side = ('<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px">'
             + field("효력 시작", f'<input value="2026-03-01" style="{SELECT}; {MONO}">')
             + field("근거 문서(작품 계약만)", SEL(["Dynamite 작품 퍼블리싱 계약서 v1 (PDF)", "공동 작사 추가 계약서 (새로 올림)"]), "작품 퍼블리싱 계약·권리 확인서(작가용)만 보인다 · " + link("+ 새 문서 올리기"))
             + "</div>")
ws_page("Song-Locked-Fix.dc.html", "Dynamite — 원곡 권리 새 버전(작품)", "원곡 권리", "2026-02-20 10:00",
        [], "Dynamite · 원곡 권리", "녹음 Vocal Recombination · 빅히트 뮤직(레이블)", [],
        [fix_box("작품 · 작사·작곡", work_rows, work_side,
                 "저장하면: 새 버전 기록 → 작가 서명이 끝나면 ⑧ \"재고정 필요\" → 분배 규칙 재고정 → 다음 발행부터 IR v2. 이미 발행된 조합과 정산은 v1 그대로.")] + locked_cards,
        LOCK_READY, height=1700, status=LOCK_STATUS, band_label="IR 상태")

perf_rows = table(["바로잡을 것", "지금(v1)", "새 값", "저장하면"],
                  [[SEL(["4 Pre-Chorus 1 · 파트 2 원곡 담당", "2 Intro Chorus · 파트 1 원곡 담당", "3 Verse 1 · 파트 1 원곡 담당"], "260px") + '<div style="margin-top: 4px; font-size: 12.5px; font-weight: 400; color: #334155">보컬 파트만</div>', "뷔", SEL(["진", "정국", "지민", "뷔", "RM", "제이홉", "슈가"], "160px") + '<div style="margin-top: 4px; font-size: 12.5px; color: #334155">이 곡의 멤버 7명만</div>', badge("진·뷔 실연자 앱 확인", "warn")],
                   ["보이스 소유", "voc_v → 뷔", SEL(["바꾸지 않음"], "160px"), badge("바꾸지 않음", "gray")]],
                  foot="실연은 %가 아니다 — 멤버 몫은 조합마다 부른 시간으로 계산된다. 여기서는 원곡 파트 담당과 보이스 소유만 바로잡는다.", paged=False, min_w=700)
perf_side = ('<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px">'
             + field("효력 시작", f'<input value="2026-03-01" style="{SELECT}; {MONO}">')
             + field("근거 문서(실연 관련만)", SEL(["멤버 팬앱 이용 동의 v1 서명본 · 진", "실연 수익 수령 위임계약 v1 서명본 · 진"]), "실연 이용 동의·수령 위임·녹음 세션 기록만 보인다")
             + "</div>")
ws_page("Song-Locked-FixPerf.dc.html", "Dynamite — 원곡 권리 새 버전(실연)", "원곡 권리", "2026-02-20 10:00",
        [], "Dynamite · 원곡 권리", "녹음 Vocal Recombination · 빅히트 뮤직(레이블)", [],
        [fix_box("실연 · 보이스·파트 담당", perf_rows, perf_side,
                 "저장하면: 새 버전 기록 → 바뀐 멤버들이 실연자 앱에서 확인 → ⑧ \"재고정 필요\" → 분배 규칙 재고정 → 다음 발행부터 IR v2. 이미 발행된 조합의 몫은 그대로.")] + locked_cards,
        LOCK_READY, height=1650, status=LOCK_STATUS, band_label="IR 상태")


# ── 스템 탭 오른쪽 칸: 상세 · 수정 · 추가(토글). 같은 칸을 다시 누르거나 × 를 누르면 닫힌다 ──
def side_panel(kicker, title, body, actions, sid=""):
    close = '<button aria-label="닫기" style="font: inherit; font-size: 18px; line-height: 1; width: 32px; height: 32px; border-radius: 8px; border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a">×</button>'
    sid_html = f'<div style="font-size: 13px; color: #334155; {MONO}">{sid}</div>' if sid else ""
    return (f'<section style="{CARD}; border: 2px solid {NAVY}; display: flex; flex-direction: column">'
            f'<div style="padding: 16px 18px; display: flex; gap: 10px; align-items: flex-start; border-bottom: 1px solid {LINE}">'
            f'<div style="flex: 1 1 auto"><div style="font-size: 12.5px; color: #334155">{kicker}</div><div style="font-size: 17px; font-weight: 800">{title}</div>{sid_html}</div>{close}</div>'
            f'<div style="padding: 16px 18px; display: flex; flex-direction: column; gap: 14px">{body}</div>'
            f'<div style="padding: 14px 18px; border-top: 1px solid {LINE}; display: flex; gap: 8px; justify-content: flex-end">{actions}</div></section>')


detail = side_panel("멤버 추가 녹음 · 슬롯 2 Intro Chorus", "Intro Chorus 정국 파트를 지민이 부름",
    kv([("슬롯", "2 Intro Chorus · 0:04~0:13"), ("파트", "파트 1 · 리드 · 원곡 담당 정국"), ("부른 멤버", "지민"), ("오디오", "stm_s02_p1_jimin.wav · READY"), ("권리 부담", "예")])
    + '<div style="font-size: 14px; font-weight: 700">이 스템의 권리</div>'
    + kv([("실연", "지민(voc_jimin) · " + badge("본인 확인됨", "ok")), ("녹음", "빅히트 뮤직 — 레이블 100%(원곡 권리)"), ("작품", "작가 2명 50·50")]),
    button("쓰지 않음") + button("수정", primary=True), sid="stm_s02_p1_jimin")
edit = side_panel("스템 수정 · stm_s02_p1_jimin", "Intro Chorus 정국 파트를 지민이 부름",
    field("오디오 파일", f'<div style="{SELECT}; display: flex; justify-content: space-between"><span>stm_s02_p1_jimin.wav</span>{link("바꾸기")}</div>', "오디오를 바꾸면 새 버전 — 이미 발행된 조합은 이전 오디오 그대로")
    + field("부른 멤버", f'<select style="{SELECT}"><option>지민</option></select>', "슬롯·파트와 부른 멤버는 바꿀 수 없다 — 잘못 넣었으면 쓰지 않음 후 새로 추가")
    + field("권리 부담", chips(["예", "아니오(반주)"], ["예"])),
    button("취소") + button("저장", primary=True))
add = side_panel("스템 추가", "새 스템",
    field("슬롯 · 파트", f'<select style="{SELECT}"><option>2 Intro Chorus · 파트 1(원곡 담당 정국)</option></select>')
    + field("부른 멤버", f'<select style="{SELECT}"><option>지민</option><option>뷔</option></select>', "이 곡의 멤버만. 원곡 담당이면 원곡 스템")
    + field("오디오 파일", f'<div style="{SELECT}; color: #334155">파일 끌어 놓기 또는 {link("고르기")} · WAV 48kHz</div>')
    + field("권리 부담", chips(["예", "아니오(반주)"], ["예"]))
    + note("저장하면 실연 주장이 함께 만들어지고 부른 멤버에게 확인 요청이 간다(ID3)."),
    button("취소") + button("추가", primary=True))
locked = side_panel("멤버 추가 녹음 · IR v1 포함", "Intro Chorus 정국 파트를 지민이 부름",
    note("IR v1로 고정된 스템이다. 지울 수 없고 '쓰지 않음'으로 새 발행에서 뺀다. 오디오를 바꾸면 새 버전으로 다음 재고정부터 쓰인다.", "warn")
    + kv([("상태", badge("IR v1 포함", "ir")), ("이미 발행된 조합", "3개 — 그대로 유지")]),
    button("쓰지 않음") + button("새 버전(오디오 바꾸기)", primary=True), sid="stm_s02_p1_jimin")
grid = ('<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; align-items: start">'
        + "".join(f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-size: 13px; font-weight: 700; color: #334155">{t}</div>{c}</div>'
                  for t, c in [("① 칸을 누르면 상세(같은 칸 다시·× → 닫힘)", detail), ("② 수정 → 같은 칸이 수정 폼(취소 → 상세)", edit),
                               ("③ + 스템 추가 → 추가 폼(다시 누르기·취소·× → 닫힘)", add), ("④ IR 고정 뒤: 추가는 됨, 지우기 대신 쓰지 않음", locked)])
        + "</div>")
ws_page("Song-Stems-Panel.dc.html", "Dynamite — 스템 오른쪽 칸", "스템", "2026-01-05 09:00",
        [], "Dynamite · 스템", "녹음 Vocal Recombination · 빅히트 뮤직(레이블)", [button("+ 스템 추가", primary=True)],
        [note("스템 표에서 칸을 누르면 오른쪽 칸이 열린다. 같은 칸을 다시 누르거나 × 를 누르면 닫히고 표가 넓어진다. 한 번에 하나만 열린다(상세·수정·추가)."), grid],
        READY_IMPORT, height=1200)


# ── 곡 절차 정리(2026-10-24): 문서·계약 탭 = 원본 계약서 / 권리 확정 / 이용 허락 ──
contracts_body = [
    table(["문서", "근거가 된 권리", "당사자", "효력", "올린 때", ""],
          [["Dynamite 녹음 계약서 v1 (PDF)", "녹음 · 마스터 보유", "빅히트 뮤직 — 레이블", mono("2026-01-01"), mono("01-02"), link("보기") + " · " + link("불러오기")],
           ["Dynamite 작품 퍼블리싱 계약서 v1 (PDF)", "작품 · 작가 지분", "작가 2명", mono("2026-01-01"), mono("01-02"), link("보기") + " · " + link("불러오기")]],
          foot="이 곡에 묶인 원본 계약서만 보인다. '불러오기'로 계약서의 값을 원곡 권리에 채운다(읽기 틀).",
          title=("① 원본 계약서", "권리의 근거 · 빅히트가 이미 맺은 계약서"), min_w=900),
    table(["확인서", "확정하는 권리", "서명", "상태", ""],
          [["권리 확인서 · 레이블용", "마스터 보유 100%", "빅히트 뮤직 — 레이블", badge("반영 · 01-02", "ok"), link("서명본")],
           ["권리 확인서 · 작가용", "작가 지분 50 · 50", "작가 2명 · 전자서명 링크", badge("서명 대기 · 01-03 보냄", "warn"), link("다시 보내기")],
           ["멤버 확인(실연자 앱)", "보이스 소유 · 원곡 파트 담당", "멤버 7명 본인", badge("1 / 7", "warn"), link("확인·동의 탭 →")]],
          foot="권리 확정 = 누가 몇 %를 갖는지 확정한다. 레이블 몫은 바로, 작가는 확인서 전자서명, 멤버는 실연자 앱 확인.",
          title=("③ 권리 확정", "누가 무엇을 갖는가"), paged=False, min_w=900),
    table(["계약", "허락하는 것", "서명", "상태", ""],
          [["녹음 이용허락 표준계약 v1", "녹음을 팬앱에서 쓴다(미리듣기·조합 생성·개인 보관)", "빅히트 뮤직 — 레이블", badge("반영", "ok"), link("서명본")],
           ["작품 이용허락 표준계약 v1 · 작가 2명", "작품을 팬앱에서 쓴다", "작가 2명 · 전자서명 링크", badge("서명 대기", "warn"), link("다시 보내기")],
           ["실연 이용 동의 · 멤버 7명", "보이스를 팬앱에서 쓴다", "멤버 본인(실연자 앱)", badge("0 / 7", "warn"), link("확인·동의 탭 →")],
           ["실연 수익 수령 위임 · 멤버 7명 → 소속사", "실연 몫을 소속사가 받는다", "멤버 → 빅히트 뮤직 매니지먼트", badge("1 / 7", "warn"), link("펼치기")]],
          foot="이용 허락 = 팬앱에서 써도 된다는 허락. 권리를 갖는 것과 별개다. 서명본은 원천 문서로 쌓인다.",
          title=("④ 이용 허락", "팬앱에서 써도 되는가"), paged=False, min_w=900),
]
ws_page("Song-Contracts.dc.html", "Dynamite — 문서·계약", "문서·계약", "2026-01-05 09:00",
        [], "Dynamite · 문서·계약", "녹음 Vocal Recombination · 빅히트 뮤직(레이블)",
        [button("+ 원본 계약서 올리기"), button("+ 계약 만들기", primary=True)],
        [note("문서·계약은 곡 진행 ①·③·④를 다룬다. ② 권리 등록은 원곡 권리 탭, ⑤ 분배·출시는 분배 규칙·팩 · 승인·출시 탭.")] + contracts_body,
        READY_IMPORT, height=1300)

# ── 새 곡 워크스페이스 ① 곡·녹음: 이 곡의 원본 계약서를 바로 올린다 ──
upload = (f'<div style="border: 1.5px dashed #cbd5e1; border-radius: 10px; padding: 18px; display: flex; gap: 12px; align-items: center; background: #f8fafc">'
          f'<div style="flex: 1 1 auto"><div style="font-weight: 700">녹음 계약서를 끌어 놓거나 {link("파일 고르기")}</div><div style="font-size: 12.5px; color: #334155">PDF · 이 곡에 묶여 원본 계약서가 된다 — 다른 곡의 계약서는 보이지 않는다</div></div></div>')
uploaded = table(["올린 문서", "근거가 될 권리", "상태"],
                 [["butter 녹음 계약서 (PDF) · 3쪽", "녹음 · 마스터 보유", badge("올림", "ok")]], paged=False, min_w=600)
create_body = [
    steps(["곡·녹음 · 녹음 계약서", "원곡 권리 · 작품 계약서", "멤버 · 보이스·파트", "확인 · 확인 요청 보내기"], 1),
    '<div style="display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start">'
    + '<div style="flex: 2 1 640px; min-width: 0">'
    + card("곡·녹음",
           '<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px">'
           + field("곡 제목", f'<input value="butter" style="{SELECT}">')
           + field("녹음 버전", f'<input value="Original" style="{SELECT}">')
           + field("마스터 보유", f'<select style="{SELECT}"><option>빅히트 뮤직 — 레이블</option></select>', "레이블만 보인다")
           + field("녹음 계약서", '<div style="padding: 10px 0; font-size: 14px">아래에서 올린 문서가 근거가 된다</div>')
           + "</div>" + upload + uploaded)
    + '</div>'
    + '<div style="flex: 1 1 300px; min-width: 0">'
    + card("저장하면", kv([("마스터 보유", "빅히트 뮤직 — 레이블 100% · 바로 확정"), ("녹음 계약서", "이 곡의 원본 계약서로 저장"), ("다음 단계", "② 작품 계약서 올리기 · 작가 지분")])
           + note("단계마다 저장된다. 나가도 '입력 중'으로 남고 이어서 한다. 당사자가 명부에 없으면 운영 관리 › 조직 › 내 조직에서 등록한다."))
    + '</div></div>',
    '<div style="display: flex; gap: 8px; justify-content: flex-end">' + button("나중에 이어서") + button("이전", disabled=True) + button("저장하고 ② 원곡 권리로", primary=True) + "</div>",
]
page("Song-Create.dc.html", "새 곡 워크스페이스", "works-list", "2026-05-01 10:34", [], "새 곡",
     "곡 진행 ① 원본 계약서 → ② 권리 등록까지 이 마법사에서 한다. 4단계 뒤 곡 화면의 원곡 권리 탭으로 간다", [], create_body, height=1000)


# ── 문서·계약 › + 원본 계약서 올리기(오른쪽 칸, 토글) ──
up_panel = side_panel("원본 계약서 올리기", "Dynamite에 묶을 계약서",
    field("종류", f'<select style="{SELECT}"><option>녹음 계약서 — 마스터 보유 근거</option><option>작품 계약서 — 작가 지분 근거</option></select>', "종류에 따라 근거가 될 권리가 정해진다")
    + field("파일", f'<div style="border: 1.5px dashed #cbd5e1; border-radius: 10px; padding: 14px; background: #f8fafc; font-size: 13.5px">끌어 놓거나 {link("파일 고르기")} · PDF</div>')
    + field("효력 시작", f'<input value="2026-01-01" style="{SELECT}; {MONO}">')
    + note("올리면 이 곡의 ① 원본 계약서가 된다. 값을 원곡 권리에 채우려면 표의 '불러오기'를 누른다."),
    button("취소") + button("올리기", primary=True))
ws_page("Song-Contracts-Upload.dc.html", "Dynamite — 원본 계약서 올리기", "문서·계약", "2026-01-05 09:00",
        [], "Dynamite · 문서·계약", "녹음 Vocal Recombination · 빅히트 뮤직(레이블)",
        [button("+ 원본 계약서 올리기", primary=True), button("+ 계약 만들기")],
        ['<div style="display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start">'
         + '<div style="flex: 2 1 640px; min-width: 0; display: flex; flex-direction: column; gap: 18px">' + contracts_body[0] + contracts_body[1] + '</div>'
         + '<div style="flex: 1 1 360px; max-width: 440px; min-width: 0">' + up_panel + '</div></div>'],
        READY_IMPORT, height=1100)


# ── 조직 › 내 조직: 당사자 등록과 지급 정보(2026-10-26) ──
party_rows = [["빅히트 뮤직 — 레이블", badge("레이블", "gray"), "Dynamite · Butter", badge("등록됨", "ok"), link("상세")],
              ["빅히트 뮤직 매니지먼트", badge("소속사", "gray"), "멤버 7 수령 위임", badge("등록됨", "ok"), link("상세")],
              ["David Stewart", badge("작가", "gray"), "Dynamite", badge("등록됨", "ok"), link("상세")],
              ["Jenna Andrews", badge("작가", "gray"), "Butter", badge("지급 정보 없음", "warn"), link("상세")]]
party_add = side_panel("당사자 등록", "새 당사자",
    field("유형", f'<select style="{SELECT}"><option>작가</option><option>레이블</option><option>소속사</option><option>멤버(아티스트)</option></select>', "작가·멤버도 빅히트가 관리하는 당사자로 등록한다")
    + field("표시 이름", f'<input value="Jenna Andrews" style="{SELECT}">')
    + field("국가 · 구분", f'<select style="{SELECT}"><option>해외 · 개인</option><option>국내 · 개인</option><option>국내 · 법인</option></select>', "세금(원천징수) 계산에 쓰인다")
    + field("연락 이메일(전자서명 링크)", f'<input value="jenna@example.com" style="{SELECT}">', "계정이 없는 당사자는 이 주소로 서명 링크를 받는다"),
    button("취소") + button("등록", primary=True))
pay_panel = side_panel("당사자 상세 · 지급 정보", "Jenna Andrews",
    kv([("유형", "작가 · 해외 개인"), ("쓰인 곳", "Butter · 작가 지분 14.28%"), ("서명 링크", "jenna@example.com")])
    + field("지급 계좌", f'<input placeholder="은행 · 계좌번호(끝 4자만 보관)" style="{SELECT}">')
    + field("세금", f'<select style="{SELECT}"><option>해외 · 원천징수</option><option>국내 · 원천징수</option><option>사업자</option></select>')
    + note("지급 정보는 빅히트가 등록하고, 플랫폼은 지급만 실행한다(WD4). 없으면 정합성 경고가 남는다.", "warn"),
    button("취소") + button("저장", primary=True))
page("Ops-Org-Parties.dc.html", "운영 관리 — 내 조직 › 당사자", "op-org", "2026-05-01 09:00", [], "빅히트 뮤직",
     "권리 테넌트 · 레이블 · tnt_bighit — 당사자를 등록하고 지급 정보를 관리한다",
     [badge("활성 · 01-20", "ok")],
     ['<div style="display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start">'
      + '<div style="flex: 2 1 640px; min-width: 0">'
      + table(["당사자", "유형", "쓰인 곳", "상태", ""], party_rows,
              foot="작가·레이블·소속사·멤버 모두 빅히트가 관리하는 당사자다. 행을 누르면 오른쪽에 상세(지급 정보)가 열린다.",
              title=("당사자", "4명 · " + link("+ 당사자 등록")), min_w=760)
      + '</div><div style="flex: 1 1 360px; max-width: 440px; min-width: 0; display: flex; flex-direction: column; gap: 18px">'
      + party_add + pay_panel + '</div></div>'],
     height=1150)

print("ok")

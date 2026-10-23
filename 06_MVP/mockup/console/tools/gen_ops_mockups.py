"""운영 관리 화면 시안(Ops-*.dc.html) 생성기.

머리글·사이드 메뉴·경로·제목·표 마크업을 Nav-Ops-Confirm.dc.html과 같게 찍어 낸다.
화면별 내용만 아래 PAGES에 적는다. 실행: python3 tools/gen_ops_mockups.py
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "project"

TONE = {
    "ok": "background: #dcfce7; color: #166534",
    "warn": "background: #fef3c7; color: #92400e",
    "err": "background: #fee2e2; color: #991b1b",
    "ir": "background: #e0e7ff; color: #3730a3",
    "gray": "background: #f1f5f9; color: #475569",
    "blue": "background: #dbeafe; color: #1e3a8a",
}
MONO = "font-family: 'IBM Plex Mono', monospace; font-size: 13px"


def badge(text, tone="gray"):
    return f'<span style="font-size: 12px; padding: 3px 8px; border-radius: 999px; {TONE[tone]}; font-weight: 600; white-space: nowrap">{text}</span>'


def mono(text):
    return f'<span style="{MONO}">{text}</span>'


def sub(main, small):
    return f'{main}<div style="font-size: 12px; font-weight: 400; color: #475569">{small}</div>'


def link(text):
    return f'<a href="#">{text}</a>'


def stats(items):
    """items: (라벨, 값, 아래 설명, 주의 여부)"""
    cards = []
    for label, val, note, warn in items:
        border = "#fdba74" if warn else "#e2e8f0"
        color = "; color: #92400e" if warn else ""
        cards.append(
            f'<div style="padding: 12px 14px; border-radius: 10px; background: #ffffff; border: 1px solid {border}">'
            f'<div style="font-size: 12px; color: #475569">{label}</div>'
            f'<div style="font-size: 22px; font-weight: 700{color}">{val}</div>'
            f'<div style="font-size: 12px; color: #475569">{note}</div></div>')
    return (f'<div style="display: grid; grid-template-columns: repeat({len(items)}, minmax(0, 1fr)); gap: 10px">'
            + "".join(cards) + "</div>")


def filters(placeholder, selects):
    out = ['<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center">',
           '<label for="q" style="position: absolute; left: -9999px">검색</label>',
           f'<input id="q" placeholder="{placeholder}" style="font: inherit; font-size: 14px; flex: 1 1 280px; padding: 9px 12px; border: 1px solid #94a3b8; border-radius: 8px">']
    for name, opts in selects:
        o = "".join(f"<option>{x}</option>" for x in opts)
        out.append(f'<select aria-label="{name}" style="font: inherit; font-size: 14px; padding: 9px 10px; border: 1px solid #94a3b8; border-radius: 8px">{o}</select>')
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
        f'<button aria-current="page" style="{btn}border: 0; background: #1d4ed8; color: #ffffff; font-weight: 600">1</button>' if n == 1
        else f'<button style="{btn}border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a">{n}</button>' for n in range(1, pages + 1))
    prev = f'<button disabled aria-label="이전 쪽" style="{btn}border: 1px solid #e2e8f0; background: #ffffff; color: #94a3b8">‹</button>'
    nxt_dis = pages == 1
    nxt = (f'<button{" disabled" if nxt_dis else ""} aria-label="다음 쪽" style="{btn}border: 1px solid {"#e2e8f0" if nxt_dis else "#cbd5e1"}; background: #ffffff; color: {"#94a3b8" if nxt_dis else "#0f172a"}">›</button>')
    return (f'<nav aria-label="쪽" style="display: flex; align-items: center; gap: 6px; margin-left: auto">'
            f'<span style="font-size: 13px; color: #475569; margin-right: 6px; font-family: \'IBM Plex Mono\', monospace">1–{min(total, PAGE_SIZE)} / {total}</span>{prev}{nums}{nxt}</nav>')


def table(cols, rows, foot=None, title=None, min_w=900, empty=None, paged=True):
    """paged=False: 항목 수가 정해진 표(확인 항목·규칙별 결과)는 쪽 나눔 줄을 두지 않는다."""
    th = "".join(f'<th style="padding: 8px 14px; text-align: left; font-size: 13px; color: #475569; background: #f8fafc">{c}</th>' for c in cols)
    total = len(rows)
    body = []
    if total == 0 and empty:
        body.append(f'<tr style="border-top: 1px solid #e2e8f0"><td colspan="{len(cols)}" style="padding: 28px 14px; text-align: center; color: #475569">{empty}</td></tr>')
    for r in rows[:PAGE_SIZE]:
        tds = []
        for i, cell in enumerate(r):
            weight = "; font-weight: 600" if i == 0 else ""
            tds.append(f'<td style="padding: 9px 14px{weight}">{cell}</td>')
        body.append('<tr style="border-top: 1px solid #e2e8f0">' + "".join(tds) + "</tr>")
    head = ""
    if title:
        head = f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 16px"><h2 style="margin: 0; font-size: 17px">{title[0]}</h2><span style="font-size: 13px; color: #475569">{title[1]}</span></div>'
    pg = pager(total) if paged else ""
    footer = (f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 16px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #475569">'
              f'<span style="flex: 1 1 320px">{foot or ""}</span>{pg}</div>') if (foot or pg) else ""
    return ('<section style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden">'
            + head + f'<div style="overflow-x: auto"><table style="width: 100%; min-width: {min_w}px; border-collapse: collapse; font-size: 14px">'
            + f"<thead><tr>{th}</tr></thead><tbody>" + "".join(body) + "</tbody></table></div>" + footer + "</section>")


def card(title, body, hint=""):
    h = f'<span style="font-size: 13px; color: #475569">{hint}</span>' if hint else ""
    return ('<section style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px">'
            f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center"><h2 style="margin: 0; font-size: 17px">{title}</h2>{h}</div>{body}</section>')


def note(text, tone="blue"):
    style = {"blue": "background: #eff6ff; border: 1px solid #93c5fd; color: #1e3a8a",
             "warn": "background: #fffbeb; border: 1px solid #fcd34d; color: #92400e"}[tone]
    return f'<div role="note" style="padding: 10px 14px; border-radius: 10px; {style}; font-size: 13px">{text}</div>'


def kv(pairs):
    rows = "".join(f'<div style="display: contents"><dt style="color: #475569">{k}</dt><dd style="margin: 0">{v}</dd></div>' for k, v in pairs)
    return f'<dl style="display: grid; grid-template-columns: 160px 1fr; gap: 8px 16px; margin: 0; font-size: 14px">{rows}</dl>'


def button(text, primary=False, disabled=False):
    if primary:
        s = "border: 0; background: #1d4ed8; color: #ffffff"
    else:
        s = "border: 1px solid #94a3b8; background: #ffffff"
    if disabled:
        s += "; opacity: 0.5; cursor: not-allowed"
    d = " disabled" if disabled else ""
    return f'<button{d} style="font: inherit; font-size: 14px; padding: 9px 14px; border-radius: 8px; {s}">{text}</button>'


def page(fname, title, active, clock, crumbs, h1, desc, actions, body, height=1000):
    crumb = "".join(f"<span>{c}</span><span>›</span>" for c in crumbs[:-1]) + f'<strong style="color: #0f172a">{crumbs[-1]}</strong>'
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
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:#1d4ed8}}a:hover{{color:#1e3a8a}}
</style>
</helmet>
<div style="font-family: 'IBM Plex Sans KR', system-ui, sans-serif; color: #0f172a; background: #f8fafc; min-height: 100vh; display: flex; flex-direction: column">
<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 12px 24px; background: #1e3a8a; color: #ffffff">
<strong style="font-size: 16px">dobedupop</strong>
<span style="font-size: 14px; color: #dbeafe">빅히트 뮤직 ▾</span>
<span style="font-size: 13px; padding: 4px 10px; border-radius: 999px; background: #1d4ed8">권리 테넌트</span>
<div style="flex: 1 1 40px"></div>
<span style="font-size: 13px; color: #dbeafe"><b>/</b> 검색</span>
<span style="font-size: 14px; padding: 6px 12px; border-radius: 8px; background: #92400e; font-family: 'IBM Plex Mono', monospace">{clock}</span>
<span style="font-size: 14px; color: #dbeafe">총괄 · usr_admin</span>
</header>
<div style="flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: stretch">
<dc-import name="Sidebar" active="{active}" hint-size="260px,{height}px"></dc-import>
<main style="flex: 999 1 640px; min-width: 0; padding: 18px 24px 32px; display: flex; flex-direction: column; gap: 14px">
<nav aria-label="위치" style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 14px; color: #475569">{crumb}</nav>
<div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: flex-end">
<div><h1 style="margin: 0; font-size: 26px">{h1}</h1><div style="font-size: 13px; color: #475569">{desc}</div></div>
<div style="display: flex; flex-wrap: wrap; gap: 8px">{"".join(actions)}</div>
</div>
{chr(10).join(body)}
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


EX = "예시 데이터"
MEMBERS = ["정국", "지민", "뷔", "진", "RM", "제이홉", "슈가"]

# ── 확인·동의 › 멤버 이용 동의 ──
page("Ops-Consents.dc.html", "운영 관리 — 멤버 이용 동의", "op-consents", "2026-02-01 09:00",
     ["운영 관리", "확인·동의", "멤버 이용 동의"], "멤버 이용 동의",
     "멤버가 실연자 앱에서 본인이 한 팬앱 이용 동의. 동의가 없는 멤버의 스템은 조합 발행이 거부된다(ISSUE_NOT_LICENSED)",
     [button("엑셀 다운로드")],
     [stats([("동의함", "7 / 7", "멤버 7", False), ("동의 대기", "0", "다시 알림 보낼 대상 없음", False),
             ("철회", "0", "철회하면 그 멤버 스템 조합 노출 중지", False), ("적용 곡", "1", "Dynamite", False)]),
      filters("멤버, 보이스", [("곡", ["곡 전체", "Dynamite"]), ("상태", ["전체", "동의함", "대기", "철회"])]),
      table(["멤버", "보이스", "동의 범위", "적용 곡", "동의 시각", "동의서", "상태"],
            [[sub(m, "빅히트 뮤직 매니지먼트 소속"), mono(f"voc_{e}"), "팬앱 조합·구매·감상", "Dynamite",
              mono(t), "멤버 팬앱 이용 동의 v1", badge("동의함", "ok")]
             for m, e, t in zip(MEMBERS, ["jk", "jm", "v", "jin", "rm", "jh", "suga"],
                                ["01-06 10:12", "01-06 11:40", "01-07 09:05", "01-07 14:22", "01-08 10:00", "01-08 16:31", "01-09 09:48"])],
            foot="동의는 멤버 본인만 하거나 철회한다. 빅히트는 조회와 다시 알림만 한다. 동의 범위는 팩 이용 범위와 같아야 한다(분배 규칙·팩).")])

# ── 계약·문서 › 표준 계약 전체 ──
page("Ops-Contracts.dc.html", "운영 관리 — 표준 계약 전체", "op-contracts-all", "2026-01-05 09:00",
     ["운영 관리", "계약·문서", "표준 계약 전체"], "표준 계약 전체",
     "빅히트 뮤직의 모든 곡에서 쓴 표준 계약(작성 → 서명 → 반영). 계약 만들기는 작품 워크스페이스 › 문서·계약에서",
     [button("엑셀 다운로드")],
     [stats([("전체", "15", "곡 2", False), ("서명 대기", "8", "Dynamite 8", True),
             ("반영", "7", "서명본은 원천 문서로 자동 등록", False), ("거절·만료", "0", "", False)]),
      filters("곡명, 계약, 당사자", [("곡", ["곡 전체", "Dynamite", "푸른 계절"]), ("템플릿", ["템플릿 전체", "플랫폼 이용계약 v1", "녹음 이용허락 표준계약 v1", "작품 이용허락 표준계약 v1", "실연 수익 수령 위임계약 v1"]), ("상태", ["전체", "서명 대기", "반영"])]),
      table(["곡", "계약", "템플릿", "서명 당사자", "건수", "상태", ""],
            [["Dynamite", "플랫폼 이용계약", "플랫폼 이용계약 v1", "빅히트 뮤직(레이블) ✓", "1", badge("반영", "ok"), link("곡 워크스페이스 › 문서·계약 →")],
             ["Dynamite", "녹음 이용허락", "녹음 이용허락 표준계약 v1", "빅히트 뮤직(레이블) ✓", "1", badge("반영", "ok"), link("곡 워크스페이스 › 문서·계약 →")],
             ["Dynamite", "작품 이용허락 · David Stewart", "작품 이용허락 표준계약 v1", sub("작가(전자서명 공급자) 대기", "플랫폼이 작성(위탁 작가) · 조회만"), "1", badge("서명 대기", "warn"), link("곡 워크스페이스 › 문서·계약 →")],
             ["Dynamite", "작품 이용허락 · Jessica Agombar", "작품 이용허락 표준계약 v1", sub("작가(전자서명 공급자) 대기", "플랫폼이 작성(위탁 작가) · 조회만"), "1", badge("서명 대기", "warn"), link("곡 워크스페이스 › 문서·계약 →")],
             ["Dynamite", "실연 수익 수령 위임 · 정국", "실연 수익 수령 위임계약 v1", "정국 ✓ · 빅히트 뮤직 매니지먼트 ✓", "1", badge("반영", "ok"), link("곡 워크스페이스 › 문서·계약 →")],
             ["Dynamite", "실연 수익 수령 위임 · 지민 외 5명", "실연 수익 수령 위임계약 v1", "멤버 대기 · 소속사 대기", "6", badge("서명 대기", "warn"), link("곡 워크스페이스 › 문서·계약 →")],
             [sub("푸른 계절", EX), "녹음 이용허락", "녹음 이용허락 표준계약 v1", "빅히트 뮤직(레이블) ✓", "1", badge("반영", "ok"), link("곡 워크스페이스 › 문서·계약 →")],
             [sub("푸른 계절", EX), "작품 이용허락 · 최유진", "작품 이용허락 표준계약 v1", "최유진 ✓", "1", badge("반영", "ok"), link("곡 워크스페이스 › 문서·계약 →")],
             [sub("푸른 계절", EX), "실연 수익 수령 위임 · 블루노트 외 1명", "실연 수익 수령 위임계약 v1", "멤버 ✓ · 소속사 ✓", "2", badge("반영", "ok"), link("곡 워크스페이스 › 문서·계약 →")]],
            foot="표준 계약 15건(Dynamite 11 · 푸른 계절 4). 이 화면은 조회와 이동만 한다.")])

# ── 계약·문서 › 원천 문서 ──
DOC = lambda song, name, kind, who, eff, basis, how: [song, sub(name, kind), who, mono(eff), basis, how, link("보기")]
page("Ops-Docs.dc.html", "운영 관리 — 원천 문서", "op-docs", "2026-01-05 09:00",
     ["운영 관리", "계약·문서", "원천 문서"], "원천 문서",
     "권리 주장의 근거가 되는 문서. 직접 올린 문서와 반영된 표준 계약의 서명본(자동 등록)",
     [button("엑셀 다운로드"), button("+ 문서 올리기", primary=True)],
     [stats([("전체", "13", "곡 2 · 조직 2", False), ("직접 올림", "6", "PDF", False),
             ("서명본(자동)", "7", "반영된 표준 계약", False), ("근거로 쓰인 주장", "21", "주장 없는 문서 0", False)]),
      filters("문서명, 당사자", [("곳", ["전체", "조직", "Dynamite", "푸른 계절"]), ("종류", ["종류 전체", "직접 올림", "서명본"])]),
      table(["곳", "문서", "당사자", "효력", "근거가 된 것", "등록", ""],
            [DOC("조직", "사업자 확인서 (PDF)", "직접 올림", "빅히트 뮤직", "2026-01-01", "온보딩 확인(KYB)", "직접 올림"),
             DOC("조직", "대표자 확인서 (PDF)", "직접 올림", "빅히트 뮤직", "2026-01-01", "온보딩 확인(KYB)", "직접 올림"),
             DOC("Dynamite", "Dynamite 녹음 계약서 v1 (PDF)", "직접 올림", "빅히트 뮤직(레이블)", "2026-01-01", "녹음 권리 · 테넌트 권리 보유 증빙", "직접 올림"),
             DOC("Dynamite", "Dynamite 작품 퍼블리싱 계약서 v1 (PDF)", "직접 올림", "작가 2명", "2026-01-01", "작가 지분", "직접 올림"),
             DOC("Dynamite", "플랫폼 이용계약 v1 서명본", "서명본", "빅히트 뮤직(레이블)", "2026-01-02", "플랫폼 이용", "자동(반영)"),
             DOC("Dynamite", "녹음 이용허락 표준계약 v1 서명본", "서명본", "빅히트 뮤직(레이블)", "2026-01-02", "녹음 동의 확정", "자동(반영)"),
             DOC("Dynamite", "수령 위임계약 v1 서명본 · 정국", "서명본", "정국 · 빅히트 뮤직 매니지먼트", "2026-01-04", "위임 확정", "자동(반영)"),
             DOC(sub("푸른 계절", EX), "푸른 계절 녹음 계약서 (PDF)", "직접 올림", "빅히트 뮤직(레이블)", "2025-11-01", "녹음 권리", "직접 올림"),
             DOC(sub("푸른 계절", EX), "푸른 계절 작품 계약서 (PDF)", "직접 올림", "최유진", "2025-11-01", "작가 지분", "직접 올림"),
             DOC(sub("푸른 계절", EX), "녹음 이용허락 표준계약 v1 서명본", "서명본", "빅히트 뮤직(레이블)", "2025-11-03", "녹음 동의 확정", "자동(반영)"),
             DOC(sub("푸른 계절", EX), "작품 이용허락 표준계약 v1 서명본 · 최유진", "서명본", "최유진", "2025-11-03", "작품 이용 확정", "자동(반영)"),
             DOC(sub("푸른 계절", EX), "수령 위임계약 v1 서명본 · 블루노트", "서명본", "블루노트 · 빅히트 뮤직 매니지먼트", "2025-11-04", "위임 확정", "자동(반영)"),
             DOC(sub("푸른 계절", EX), "수령 위임계약 v1 서명본 · 하람", "서명본", "하람 · 빅히트 뮤직 매니지먼트", "2025-11-04", "위임 확정", "자동(반영)")],
            foot="IR에 쓰인 문서는 지우거나 바꿀 수 없다. 바로잡기는 새 문서를 올리고 주장을 새 버전으로 바꾼다.")], height=1100)

# ── 계약·문서 › 계약 템플릿 ──
page("Ops-Templates.dc.html", "운영 관리 — 계약 템플릿", "op-templates", "2026-01-05 09:00",
     ["운영 관리", "계약·문서", "계약 템플릿"], "계약 템플릿",
     "표준 계약을 만들 때 고르는 템플릿. 플랫폼이 관리하고 빅히트는 골라 쓴다(자체 템플릿은 상용 단계)",
     [],
     [table(["템플릿", "버전", "쓰는 곳", "서명 순서", "조항", "반영하면", "쓴 계약"],
            [["플랫폼 이용계약", mono("v1"), "테넌트 온보딩", "권리 테넌트", "8", "플랫폼 이용 확정", "1"],
             ["녹음 이용허락 표준계약", mono("v1"), "원곡 권리 › 녹음", "레이블", "6", "녹음 동의 확정", "2"],
             ["작품 이용허락 표준계약", mono("v1"), "원곡 권리 › 작품", "작가(위탁이면 플랫폼이 작성)", "6", "작품 이용 확정", "3"],
             ["실연 수익 수령 위임계약", mono("v1"), "원곡 권리 › 수령 위임", "멤버(실연자 앱) → 소속사", "5", "위임(MANDATE) 확정", "9"],
             ["멤버 팬앱 이용 동의", mono("v1"), "확인·동의", "멤버(실연자 앱) 본인", "4", "이용 동의 확정", "7"]],
            foot="템플릿 내용·조항 미리보기는 행을 눌러 본다. 새 버전이 나오면 이미 반영된 계약은 그대로, 새 계약부터 새 버전을 쓴다.", min_w=860)])

# ── 점검 › 정합성 점검 전체 ──
page("Ops-Validation.dc.html", "운영 관리 — 정합성 점검 전체", "op-validation", "2026-01-12 09:00",
     ["운영 관리", "점검", "정합성 점검 전체"], "정합성 점검 전체",
     "모든 곡의 정합성 점검 결과. 차단이 있으면 그 곡의 분배 규칙을 활성화하지 못한다. 곡 하나는 작품 워크스페이스 › 분배 규칙·팩 ① 정합성 점검",
     [button("다시 점검")],
     [stats([("차단", "0", "", False), ("경고", "2", "Dynamite 2 · 기한 01-16", True),
             ("통과 규칙", "12 / 14", "곡 2 × 규칙 7 · 진행 중 1", False), ("마지막 점검", "09:00", "2026-01-12", False)]),
      filters("곡명, 규칙", [("곡", ["곡 전체", "Dynamite", "푸른 계절"]), ("수준", ["경고 이상", "차단", "전체"])]),
      table(["곡", "규칙", "수준", "대상", "내용", ""],
            [["Dynamite", "확인 대기", badge("경고", "warn"), "작가 지분 50% · David Stewart", "운영 원문 대조 대기 · 기한 01-16 지나면 차단", link("곡 워크스페이스 › 확인·동의 →")],
             ["Dynamite", "확인 대기", badge("경고", "warn"), "작가 지분 50% · Jessica Agombar", "운영 원문 대조 대기 · 기한 01-16 지나면 차단", link("곡 워크스페이스 › 확인·동의 →")]],
            foot="경고 이상만 보인다. 수준을 '전체'로 바꾸면 통과한 규칙도 보인다.", title=("걸린 항목", "2건")),
      card("규칙별 결과", table(["규칙", "Dynamite", "푸른 계절"],
           [["지분 합계 100%", "✓", "✓"], ["근거 문서", "✓", "✓"],
            ["마스터 보유자 ↔ 녹음 권리 주장", "✓", "✓"], ["스템 실연자 ↔ 실연 주장", "✓", "✓"],
            ["파트 원곡 스템 · 보이스 누락", "✓ 원곡 스템 등록 중(발행 때 검사)", "✓"],
            ["확인 대기", '<span style="color: #92400e; font-weight: 600">! 경고 2</span>', "✓"],
            ["멤버 이용 동의", "— 진행 중(발행 때 검사)", "✓"]], min_w=700, paged=False), hint="곡 2 · 규칙 7")], height=1100)

# ── 정산 › 명세·지급 ──
page("Ops-Statements.dc.html", "운영 관리 — 명세·지급", "op-statements", "2026-05-01 09:01",
     ["운영 관리", "정산", "명세·지급"], "명세·지급",
     "빅히트 뮤직 당사자가 받는 정산 명세와 지급. 금액은 플랫폼이 확정한 정산 배치에서 온다",
     [button("명세 내려받기(PDF)")],
     [stats([("이번 지급", "4,316,872원", "pay-2026-05 · 05-01", False), ("받는 당사자", "2", "레이블 · 소속사", False),
             ("정산 기간", "2026년 3월", "bat_bts_2026_03 확정", False), ("보류", "1건", "이상거래 · 2,310원", True)]),
      filters("당사자", [("기간", ["2026년 3월", "2026년 2월"]), ("상태", ["전체", "PAID", "대기"])]),
      table(["받는 당사자", "역할", "정산 기간", "지급(원)", "계좌", "상태", ""],
            [["빅히트 뮤직(레이블)", "녹음 몫", "2026-03", mono("2,030,952"), mono("••••abel"), badge("PAID", "ok"), link("명세 보기")],
             ["빅히트 뮤직 매니지먼트(소속사)", "실연 몫(멤버 7 수령 위임)", "2026-03", mono("2,285,920"), mono("••••ency"), badge("PAID", "ok"), link("명세 보기")]],
            foot="작가 2명의 작품 몫은 플랫폼 위탁이라 이 명세에 보이지 않는다(다른 관리 주체). 멤버별 기여분은 실연자 앱에서 본인이 본다."),
      card("조합별 매출(이번 정산)", table(["조합", "구매", "매출(원)"],
           [["원곡 배치 · " + mono("vc_bts_orig"), "1,200", mono("3,960,000")], ["정국·지민 맞바꾸기 · " + mono("vc_bts_swap"), "500", mono("1,650,000")],
            ["랩 파트를 보컬 멤버가 · " + mono("vc_bts_vocal"), "300", mono("990,000")], ["진이 정국·지민 파트까지 · " + mono("vc_bts_jin"), "200", mono("660,000") + " · 보류 1"]], min_w=600),
           hint="합계 7,260,000원 · 발행 조합 화면과 같다")])

# ── 정산 › 발행 조합 ──
page("Ops-Issues.dc.html", "운영 관리 — 발행 조합", "op-issues", "2026-04-01 09:00",
     ["운영 관리", "정산", "발행 조합"], "발행 조합",
     "팬앱에서 발행된 Dynamite 보컬 조합. 발행 순간의 IR(facts·정책·조합 지분·멤버)이 봉인되어 정산 근거가 된다",
     [button("엑셀 다운로드")],
     [stats([("발행 조합", "4", "Dynamite", False), ("구매", "2,200", "2026년 3월", False),
             ("매출", "7,260,000원", "", False), ("보류", "1건", "이상거래", True)]),
      filters("조합 id, 이름", [("곡", ["곡 전체", "Dynamite"]), ("팩", ["DYNAMITE-FAN"])]),
      table(["조합", "바꾼 곳", "발행", "봉인", "구매", "매출(원)", ""],
            [[sub("원곡 배치", "vc_bts_orig"), "없음(원곡 스템 그대로)", mono("02-01 09:30"), badge("facts v1 · 정책 v1", "ir"), "1,200", mono("3,960,000"), link("조합 지분 보기")],
             [sub("정국·지민 맞바꾸기", "vc_bts_swap"), "정국 ↔ 지민 파트", mono("02-03 18:12"), badge("facts v1 · 정책 v1", "ir"), "500", mono("1,650,000"), link("조합 지분 보기")],
             [sub("랩 파트를 보컬 멤버가", "vc_bts_vocal"), "Verse 2 (Rap) 파트 3", mono("02-05 20:40"), badge("facts v1 · 정책 v1", "ir"), "300", mono("990,000"), link("조합 지분 보기")],
             [sub("진이 정국·지민 파트까지", "vc_bts_jin"), "정국 · 지민 파트 → 진", mono("02-09 11:05"), badge("facts v1 · 정책 v1", "ir"), "200", sub(mono("660,000"), "이상거래 1건 보류"), link("조합 지분 보기")]],
            foot="발행 승인 대기는 없다 — 게이트를 통과하면 바로 봉인된다(MD8). 봉인된 조합은 고칠 수 없고, 권리가 바뀌면 다음 발행부터 새 버전이 쓰인다.")])

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
      card("우리 당사자", table(["당사자", "역할", "쓰인 곳"],
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

print("ok")

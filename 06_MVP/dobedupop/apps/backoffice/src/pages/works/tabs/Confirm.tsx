import { Link } from "react-router";
import { useClock } from "../../../api/clock.ts";
import { useGet } from "../../../api/hooks.ts";
import type { ConfirmationRow, ConsentRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { currentClaims, memberProgress, pctText } from "../model.ts";
import type { WsCtx } from "../Workspace.tsx";

const ROLE_DETAIL: Record<string, string> = { LYRICS_COMPOSITION: "작사·작곡", LYRICS: "작사", COMPOSITION: "작곡" };
const NO_REMIND = "확인 요청 다시 알림 API가 없다";
const NO_IDENTITY = "실연자 본인 인증 상태를 포털에서 읽는 API가 없다";

/**
 * 확인·동의 탭(시안 Song-Confirm.dc.html): 멤버 확인·동의 진행 표 · 작가 지분 확인 · 확인이 IR 생성·출시에 주는 영향.
 */
export function ConfirmTab({ ctx }: { ctx: WsCtx }) {
  const clock = useClock();
  const consents = useGet<ConsentRow[]>(["work-consents", ctx.scopeId], `/consents?scope=${encodeURIComponent(ctx.scopeId)}`);
  const confs = useGet<ConfirmationRow[]>(["work-confirmations"], "/confirmations");
  const now = clock.data?.now ?? ctx.now;
  const rows = memberProgress(ctx.members, ctx.facts.claims, ctx.rows, ctx.facts.stems, consents.data ?? [], ctx.facts.mandates, now);
  const mine = (confs.data ?? []).filter((c) => c.factsScopeId === ctx.scopeId);
  const work = currentClaims(ctx.facts.claims).filter((c) => c.edge === "WRITTEN_BY");
  const st = (ok: boolean) => (ok ? "p-ok" : "p-warn");
  const th = ["멤버", "본인 인증", "보이스 소유", "원곡 파트 실연", "추가 녹음 스템 실연", "팬앱 이용 동의", "수령 위임 서명", "남은 것", ""];
  return (
    <>
      <section className="p-card">
        <div className="p-card-head">
          <h2>멤버 확인·동의 진행</h2>
          <span className="p-badge sm muted">{now.slice(0, 10)} 시점</span>
          <span className="p-sub">멤버는 실연자 앱에서 본인이 확인·동의한다. 빅히트는 진행을 보고 알림을 다시 보낸다</span>
          <span style={{ marginLeft: "auto" }} />
          <button type="button" className="p-btn mid" disabled title={NO_REMIND}>확인 안 한 멤버에게 다시 알림</button>
        </div>
        <ErrorPanel error={consents.error ?? confs.error} />
        <div className="p-scroll"><table className="p-table" style={{ minWidth: 980 }} aria-label="멤버 확인 진행">
          <thead><tr>{th.map((h) => <th key={h} style={{ padding: "8px 14px" }}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => {
            const left = r.left === 0 ? "없음" : `${r.left - (r.consent ? 0 : 1) - (r.mandate ? 0 : 1)}건${!r.consent || !r.mandate ? " + " + [!r.consent && "동의", !r.mandate && "서명"].filter(Boolean).join("·") : ""}`;
            return (
              <tr key={r.member}>
                <td style={{ padding: "9px 14px", fontWeight: 600 }}>{r.name}</td>
                <td style={{ padding: "9px 14px" }} className="p-todo" title={NO_IDENTITY}>—</td>
                <td style={{ padding: "9px 14px" }} className={st(r.ownership === "확인됨")}>{r.ownership === "확인됨" ? "확인됨" : r.ownership}</td>
                <td style={{ padding: "9px 14px" }}>{r.origParts[0]} / {r.origParts[1]}</td>
                <td style={{ padding: "9px 14px" }}>{r.extraStems[0]} / {r.extraStems[1]}</td>
                <td style={{ padding: "9px 14px" }} className={st(r.consent)}>{r.consent ? "동의 · 1년" : "대기"}</td>
                <td style={{ padding: "9px 14px" }} className={st(r.mandate)}>{r.mandate ? "서명" : "대기"}</td>
                <td style={{ padding: "9px 14px", fontWeight: 600 }}>{left}</td>
                <td style={{ padding: "9px 14px", whiteSpace: "nowrap" }}><Link to={`/confirmations?party=${encodeURIComponent(r.member)}`}>자세히</Link> · <button type="button" className="p-linkbtn" disabled title="실연자 앱은 다른 앱(실연자 계정으로 로그인)이라 포털에서 바로 들어갈 수 없다">실연자로 들어가기</button></td>
              </tr>
            );
          })}</tbody>
        </table></div>
        <div className="p-card-foot" style={{ fontSize: 13 }}>멤버는 실연자 앱에서 "내 보이스와 내가 부른 스템"을 한 번에 확인한다(항목마다 거절·이의제기 가능). 원곡 파트 담당 지정도 이 확인에 포함된다(SL3).</div>
      </section>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
        <section className="p-card">
          <div className="p-card-head"><h2>작가 지분 확인</h2><span className="p-badge sm warn">운영이 원문 대조</span></div>
          <table className="p-table"><tbody>{work.map((c, i) => {
            const q = mine.filter((x) => x.recordId === c.claimId).sort((a, b) => b.requestId - a.requestId)[0];
            const done = c.status === "VERIFIED";
            return (
              <tr key={c.claimId} style={i === 0 ? { borderTop: 0 } : undefined}>
                <td style={{ padding: "9px 14px" }}>{ctx.name(c.targetId)} · {ROLE_DETAIL[c.roleDetail ?? ""] ?? c.roleDetail ?? ""} {pctText(c.shareBps)}</td>
                <td style={{ padding: "9px 14px" }}>{c.evidenceDigest ? "근거 문서 연결" : "근거 없음"}</td>
                <td style={{ padding: "9px 14px" }} className={done ? "p-ok" : "p-warn"}>{done ? "확정" : q ? `대기 · 기한 ${Number(q.dueAt.slice(5, 7))}/${Number(q.dueAt.slice(8, 10))} 뒤 운영 대조` : "대기"}</td>
              </tr>
            );
          })}</tbody></table>
          <div className="p-card-foot" style={{ fontSize: 13, borderTop: 0 }}>플랫폼 위탁 작가라 빅히트는 조회만 한다. 대조가 끝나면 확정으로 바뀐다(P5 E31).</div>
        </section>
        <section className="p-card">
          <div className="p-card-head"><h2>확인이 IR 생성·출시에 주는 영향</h2></div>
          <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
            <div>· 확인 대기는 정합성 점검 <b>경고</b>. 기한(14일)이 지나면 <b>차단</b>으로 오른다</div>
            <div>· 차단이 있으면 분배 규칙을 활성화하지 못한다(출시 불가)</div>
            <div>· 팬앱 이용 동의가 없는 멤버의 스템은 조합 발행이 거부된다(ISSUE_NOT_LICENSED)</div>
            <div>· 멤버가 거절·이의제기하면 그 권리는 분쟁이 되고 팩이 멈춘다</div>
          </div>
        </section>
      </div>
    </>
  );
}

import { Link } from "react-router";
import { useGet } from "../../../api/hooks.ts";
import type { ConfirmationRow, ConsentRow } from "../../../api/works.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Section } from "../../../components/Section.tsx";
import { currentClaims, memberProgress, pctText } from "../model.ts";
import type { WsCtx } from "../Workspace.tsx";

const CONF_STATUS: Record<string, [string, string]> = {
  OPEN: ["대기", "warn"], CONFIRMED: ["확인됨", "ok"], PLATFORM_VERIFIED: ["운영 원문 대조 확인", "ok"], DECLINED: ["거절 → 분쟁", "bad"], SUPERSEDED: ["새 버전으로 대체", "muted"],
};

/**
 * 확인·동의 탭(시안 Song-Confirm, P3): 멤버별 보이스 소유·원곡 파트 실연·추가 녹음 스템 실연·팬앱 이용 동의·수령 위임 진행과 작가 지분 대조.
 * 멤버는 실연자 앱에서 본인이 확인·동의한다. 빅히트는 진행을 본다(본인 인증 상태와 "다시 알림"은 포털 API가 없어 이 화면에 없다).
 */
export function ConfirmTab({ ctx }: { ctx: WsCtx }) {
  const consents = useGet<ConsentRow[]>(["work-consents", ctx.scopeId], `/consents?scope=${encodeURIComponent(ctx.scopeId)}`);
  const confs = useGet<ConfirmationRow[]>(["work-confirmations"], "/confirmations");
  const rows = memberProgress(ctx.members, ctx.facts.claims, ctx.rows, ctx.facts.stems, consents.data ?? [], ctx.facts.mandates, ctx.now);
  const mine = (confs.data ?? []).filter((c) => c.factsScopeId === ctx.scopeId);
  const work = currentClaims(ctx.facts.claims).filter((c) => c.edge === "WRITTEN_BY");
  const ok = (b: boolean, yes: string, no = "대기") => <span className={b ? "mark-ok" : "mark-warn"}>{b ? yes : no}</span>;
  const frac = ([a, b]: [number, number]) => <span className={a === b ? "mark-ok" : "mark-warn"}>{a} / {b}</span>;
  return (
    <>
      <Section title="멤버 확인·동의 진행">
        <p className="muted small">멤버는 실연자 앱에서 본인이 확인·동의한다(내 보이스와 내가 부른 스템을 한 번에, 항목마다 거절·이의제기 가능). 원곡 파트 담당 지정도 이 확인에 포함된다(SL3).</p>
        <ErrorPanel error={consents.error ?? confs.error} />
        {rows.length === 0 ? <p className="muted">멤버가 없습니다.</p> : (
          <table className="data" aria-label="멤버 확인 진행">
            <thead><tr>{["멤버", "보이스 소유", "원곡 파트 실연", "추가 녹음 스템 실연", "팬앱 이용 동의", "수령 위임", "남은 것"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.member}>
                <td><b>{r.name}</b><div className="small muted">{r.voice ?? "보이스 없음"}</div></td>
                <td>{ok(r.ownership === "확인됨", "확인됨", r.ownership)}</td>
                <td>{frac(r.origParts)}</td><td>{frac(r.extraStems)}</td>
                <td>{ok(r.consent, "동의")}</td><td>{ok(r.mandate, "반영")}</td>
                <td>{r.left === 0 ? <span className="mark-ok">없음</span> : `${r.left}건`}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      <div className="split">
        <Section title="작가 지분 확인">
          {work.length === 0 ? <p className="muted">작가 지분이 없습니다.</p> : (
            <table className="data"><tbody>{work.map((c) => {
              const q = mine.filter((x) => x.recordId === c.claimId).sort((a, b) => b.requestId - a.requestId)[0];
              const st = q ? CONF_STATUS[q.status] ?? [q.status, "muted"] : c.status === "VERIFIED" ? ["확정", "ok"] : ["확인 요청 없음", "muted"];
              return (
                <tr key={c.claimId}><td>{ctx.name(c.targetId)} · {pctText(c.shareBps)}</td><td>{c.evidenceDigest ? "근거 문서 연결" : "근거 없음"}</td>
                  <td><span className={`badge ${st[1]}`}>{st[0]}</span>{q?.status === "OPEN" && <> · 기한 <Instant iso={q.dueAt} /> 뒤 운영 대조</>}</td></tr>
              );
            })}</tbody></table>
          )}
          <p className="muted small">플랫폼 위탁 작가는 조회만 한다. 상대가 확인하거나 기한 뒤 운영이 원문과 대조하면 확정으로 바뀐다.</p>
        </Section>
        <Section title="확인이 IR 생성·출시에 주는 영향">
          <ul className="plain small">
            <li>· 확인 대기는 정합성 점검 <b>경고</b>. 기한(14일)이 지나면 <b>차단</b>으로 오른다</li>
            <li>· 차단이 있으면 분배 규칙을 활성화하지 못한다(출시 불가)</li>
            <li>· 팬앱 이용 동의가 없는 멤버의 스템은 조합 발행이 거부된다(ISSUE_NOT_LICENSED)</li>
            <li>· 멤버가 거절·이의제기하면 그 권리는 분쟁이 되고 팩이 멈춘다</li>
          </ul>
          <p className="small"><Link to="/confirmations">보낸 확인 요청 전체</Link> · <Link to="/validation">정합성 점검</Link></p>
        </Section>
      </div>
    </>
  );
}

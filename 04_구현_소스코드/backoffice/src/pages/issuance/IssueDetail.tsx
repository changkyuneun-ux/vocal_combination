import { api } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { currentApp } from "../../app/apps.ts";
import { useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Digest } from "../../components/Digest.tsx";
import { Instant } from "../../components/Instant.tsx";
import { useGet } from "../../api/hooks.ts";
import type { IssueAudit } from "../../api/types.ts";

type Share = { role: string; party: string; share: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 투영 봉인의 vectors({역할: {party: "n/d"}})를 권리자별 몫 행으로 편다. */
function shares(projection: unknown): Share[] {
  if (!isObj(projection) || !isObj(projection.vectors)) return [];
  return Object.entries(projection.vectors).flatMap(([role, v]) =>
    isObj(v) ? Object.entries(v).map(([party, share]) => ({ role, party, share: String(share) })) : []);
}
function memberShares(doc: unknown): { party: string; share: string }[] {
  if (!isObj(doc) || !isObj(doc.members)) return [];
  return Object.entries(doc.members).map(([party, share]) => ({ party, share: String(share) }));
}

const sealHref = (d: string) => `/api/seals/${encodeURIComponent(d)}`;
const SealLink = ({ digest, label }: { digest: string; label: string }) => (
  <span className="row-actions"><Digest value={digest} label={`봉인 ${label}`} /> <a href={sealHref(digest)} target="_blank" rel="noreferrer" aria-label={`${label} 봉인 보기`}>봉인 보기</a></span>
);
const Match = ({ ok }: { ok: boolean }) => <span className={`badge ${ok ? "ok" : "bad"}`}>{ok ? "일치" : "불일치"}</span>;

type RenderInfo = { snapshotId: string; status: string; watermarkId: string; renderSha256: string | null; durationMs: number | null; error: string | null; renderedAt: string | null; verifyResult: string | null };

/** 마스터 렌더(운영 백오피스에서만): 상태·렌더 해시·워터마크 ID, 렌더 무결성 검증(봉인된 배정으로 다시 렌더해 비교). */
function RenderPanel({ snapshotId }: { snapshotId: string }) {
  const q = useGet<RenderInfo>(["render", snapshotId], `/renders/${encodeURIComponent(snapshotId)}`, { refetchInterval: (d) => (d?.status === "PENDING" ? 2000 : false) });
  const verify = useAction(() => api("POST", `/renders/${encodeURIComponent(snapshotId)}/verify`, {}), ["render"]);
  if (q.error?.status === 404) return <Section title="마스터 렌더"><p className="muted">렌더 기록 없음(렌더 연동 전에 발행된 조합)</p></Section>;
  const r = q.data;
  return (
    <Section title="마스터 렌더" actions={<button type="button" className="btn" disabled={r?.status !== "RENDERED" || verify.isPending} onClick={() => verify.mutate(undefined)}>렌더 무결성 검증</button>}>
      <ErrorPanel error={q.error && q.error.status !== 404 ? q.error : verify.error} />
      {r && (
        <dl className="kv">
          <dt>상태</dt><dd><span className={`badge ${r.status === "RENDERED" ? "ok" : r.status === "FAILED" ? "bad" : "muted"}`}>{r.status}</span>{r.error && <span className="muted"> {r.error}</span>}</dd>
          <dt>워터마크 ID</dt><dd><code>{r.watermarkId}</code></dd>
          <dt>렌더 해시</dt><dd>{r.renderSha256 ? <code>{r.renderSha256.slice(0, 16)}…</code> : "—"}</dd>
          <dt>길이</dt><dd>{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}초` : "—"}</dd>
          <dt>검증</dt><dd>{r.verifyResult ? <span className={`badge ${r.verifyResult === "MATCH" ? "ok" : "bad"}`}>{r.verifyResult}</span> : "미검증"}</dd>
        </dl>
      )}
    </Section>
  );
}

export function IssueDetail() {
  const { snapshotId = "" } = useParams();
  const audit = useGet<IssueAudit>(["audit", snapshotId], `/issues/${encodeURIComponent(snapshotId)}/audit`);
  const a = audit.data;
  const projection = useGet<unknown>(["seal", a?.expected.projectionDigest], `/seals/${encodeURIComponent(a?.expected.projectionDigest ?? "")}`, { enabled: !!a });
  const members = useGet<unknown>(["seal", a?.expected.membersDigest], `/seals/${encodeURIComponent(a?.expected.membersDigest ?? "")}`, { enabled: !!a });
  return (
    <>
      {currentApp() === "ops" && <RenderPanel snapshotId={snapshotId} />}
      <Section title={`발행 ${snapshotId}`}>
        <ErrorPanel error={audit.error} />
        {a && (
          <dl className="kv">
            <dt>기준 시각</dt><dd><Instant iso={a.expected.asOf} /></dd>
            <dt>알려진 시각</dt><dd><Instant iso={a.expected.knownAt} /></dd>
          </dl>
        )}
      </Section>
      {a && (
        <>
          <Section title="봉인 묶음">
            <table className="data">
              <thead><tr><th scope="col">봉인</th><th scope="col">digest</th></tr></thead>
              <tbody>
                <tr><td>facts</td><td><SealLink digest={a.expected.factsDigest} label="facts" /></td></tr>
                <tr><td>정책</td><td><SealLink digest={a.expected.policyDigest} label="policy" /></td></tr>
                <tr><td>투영</td><td><SealLink digest={a.expected.projectionDigest} label="투영" /></td></tr>
                <tr><td>멤버</td><td><SealLink digest={a.expected.membersDigest} label="멤버" /></td></tr>
              </tbody>
            </table>
          </Section>
          <Section title="재도출 대조">
            <p role="status">전체 결과: <Match ok={a.ok} /> · 정책 digest 대조: <Match ok={a.policyMatch} /></p>
            <table className="data">
              <thead><tr><th scope="col">항목</th><th scope="col">봉인된 값</th><th scope="col">재도출 값</th><th scope="col">결과</th></tr></thead>
              <tbody>
                <tr><td>투영</td><td><Digest value={a.expected.projectionDigest} label="대조 투영 봉인" /></td><td><Digest value={a.recomputed.projectionDigest} label="대조 투영 재도출" /></td>
                  <td><Match ok={a.expected.projectionDigest === a.recomputed.projectionDigest} /></td></tr>
                <tr><td>멤버</td><td><Digest value={a.expected.membersDigest} label="대조 멤버 봉인" /></td><td><Digest value={a.recomputed.membersDigest} label="대조 멤버 재도출" /></td>
                  <td><Match ok={a.expected.membersDigest === a.recomputed.membersDigest} /></td></tr>
              </tbody>
            </table>
          </Section>
          <Section title="분배 결과 표">
            <ErrorPanel error={projection.error} />
            <DataTable<Share> rows={shares(projection.data)} empty="투영의 권리자별 몫이 없습니다."
              columns={[{ key: "role", label: "역할" }, { key: "party", label: "권리자" }, { key: "share", label: "몫(역할 안 비율)" }]} />
          </Section>
          <Section title="멤버 비율">
            <ErrorPanel error={members.error} />
            <DataTable rows={memberShares(members.data)} empty="멤버 비율이 없습니다."
              columns={[{ key: "party", label: "멤버" }, { key: "share", label: "비율" }]} />
          </Section>
        </>
      )}
    </>
  );
}

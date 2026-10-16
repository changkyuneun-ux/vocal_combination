import { useGet } from "../../api/hooks.ts";
import { DOCUMENT_KIND_LABEL } from "../../api/documents.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { ScopeSelect, useScopeParam } from "../../components/ScopeSelect.tsx";
import { Section } from "../../components/Section.tsx";

type Line = { area: string; subject: string; text: string; records: { type: string; id: string; version: number; status: string }[]; evidence: { documentId: string; version: number; title: string; kind: string; status: string }[] };
type Summary = {
  scopeId: string; title: string; lines: Line[]; evidenceCoverage: { records: number; withEvidence: number };
  seal: { policyId: string; policyVersion: number; factsDigest: string; factsKnownAt: string; changedSinceSeal: number; signatures: { role: string; signerId: string }[] } | null;
};
const AREA: Record<string, string> = { MASTER: "녹음", WORK: "작품", VOICE: "실연", MANDATE: "위임" };

/** 권리 요약(원천 문서 설계 S1): 봉인 IR 대신 사람이 읽는 문장, 문장마다 근거 문서, 봉인 상태 배지. */
export function RightsSummaryPage() {
  const [scope, setScope] = useScopeParam();
  const q = useGet<Summary>(["summary", scope], `/scopes/${encodeURIComponent(scope)}/summary`, { enabled: scope !== "" });
  const s = q.data;
  return (
    <>
      <Section title="곡 선택"><ScopeSelect scope={scope} onChange={setScope} /><ErrorPanel error={q.error} /></Section>
      {s && <>
        <Section title={`권리 요약 · ${s.title}`}>
          <p className="muted" aria-label="봉인 상태">
            {s.seal === null ? "활성 정책이 없어 봉인된 facts가 없습니다." : <>
              정책 {s.seal.policyId} v{s.seal.policyVersion} · facts 봉인 {s.seal.factsKnownAt.slice(0, 10)} · 서명 {s.seal.signatures.length}/3 ·{" "}
              <span className={`badge ${s.seal.changedSinceSeal === 0 ? "ok" : "warn"}`}>{s.seal.changedSinceSeal === 0 ? "봉인 이후 변경 없음" : `봉인 이후 바뀐 기록 ${s.seal.changedSinceSeal}건(재고정 필요)`}</span>
            </>}
            {" "}· 근거 문서가 있는 기록 {s.evidenceCoverage.withEvidence}/{s.evidenceCoverage.records}
          </p>
          <table className="data" aria-label="권리 요약">
            <thead><tr><th scope="col">구분</th><th scope="col">내용</th><th scope="col">근거 문서</th></tr></thead>
            <tbody>{s.lines.map((l) => (
              <tr key={`${l.area}-${l.subject}`} data-line={l.subject}>
                <td>{AREA[l.area] ?? l.area}</td>
                <td>{l.text}</td>
                <td>{l.evidence.length === 0 ? <span className="badge warn">근거 없음</span>
                  : l.evidence.map((e) => <div key={`${e.documentId}@${e.version}`}>{e.title} <span className="muted small">({DOCUMENT_KIND_LABEL[e.kind] ?? e.kind}, v{e.version})</span></div>)}</td>
              </tr>
            ))}</tbody>
          </table>
        </Section>
      </>}
    </>
  );
}

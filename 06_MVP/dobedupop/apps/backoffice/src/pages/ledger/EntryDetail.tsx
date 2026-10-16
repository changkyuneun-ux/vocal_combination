import { Link, useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Money } from "../../components/Money.tsx";
import { useGet } from "../../api/hooks.ts";
import type { EntryDetailData } from "../../api/types.ts";

export function EntryDetail() {
  const { entryId = "" } = useParams();
  const q = useGet<EntryDetailData>(["ledger-entry", entryId], `/ledger/entries/${encodeURIComponent(entryId)}`);
  const sum = (q.data?.postings ?? []).reduce((a, p) => a + BigInt(p.amountKrw), 0n);
  const zero = sum === 0n;
  return (
    <>
      <Section title={`분개 ${entryId}`}>
        <p><Link to="/ledger">← 목록으로</Link></p>
        <ErrorPanel error={q.error} />
        {q.data && (
          <dl className="kv">
            <dt>종류</dt><dd>{q.data.kind}</dd><dt>출처</dt><dd>{q.data.sourceRef}</dd>
            <dt>발생(UTC)</dt><dd><Instant iso={q.data.occurredAt} /></dd><dt>생성자</dt><dd>{q.data.createdBy}</dd>
          </dl>
        )}
      </Section>
      <Section title="전기 표">
        {q.data && (
          <>
            <DataTable rows={q.data.postings} empty="전기가 없습니다."
              columns={[
                { key: "postingId", label: "전기" }, { key: "accountId", label: "계정" },
                { key: "amountKrw", label: "금액", render: (r) => <Money krw={r.amountKrw} /> },
                { key: "eventId", label: "이벤트", render: (r) => r.eventId ?? "—" },
                { key: "runId", label: "run", render: (r) => r.runId ?? "—" },
              ]} />
            <p role="status" className={zero ? "muted" : "error-text"}>전기 합계 <Money krw={sum.toString()} /> — {zero ? "합 0 확인됨" : "합이 0이 아닙니다(불일치)"}</p>
          </>
        )}
      </Section>
    </>
  );
}

import { useState } from "react";
import { Link } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Digest } from "../../components/Digest.tsx";
import { useList } from "../../api/hooks.ts";
import type { IssueRow } from "../../api/types.ts";

const dg = (d: string | null, label: string) => (d ? <Digest value={d} label={label} /> : <span className="muted">—</span>);

export function IssueTable({ pack, vc }: { pack?: string; vc?: string }) {
  const list = useList<IssueRow>("issues", "/issues", { pack, vc });
  return (
    <>
      <ErrorPanel error={list.error} />
      <DataTable<IssueRow> rows={list.pages} empty="발행이 없습니다."
        columns={[
          { key: "vcId", label: "vcId", render: (r) => <Link to={`/issues/${encodeURIComponent(r.snapshotId)}`}>{r.vcId}</Link> },
          { key: "packId", label: "팩" },
          { key: "policy", label: "정책 버전", render: (r) => `${r.policyId}@${r.policyVersion}` },
          { key: "factsDigest", label: "facts", render: (r) => dg(r.factsDigest, `${r.vcId} facts`) },
          { key: "policyDigest", label: "정책", render: (r) => dg(r.policyDigest, `${r.vcId} 정책`) },
          { key: "projectionDigest", label: "조합 지분", render: (r) => dg(r.projectionDigest, `${r.vcId} 조합 지분`) },
          { key: "membersDigest", label: "멤버", render: (r) => dg(r.membersDigest, `${r.vcId} 멤버`) },
          { key: "quarantined", label: "격리", render: (r) => (r.quarantined ? <span className="badge warn">QUARANTINED</span> : <span className="muted">—</span>) },
          { key: "createdAt", label: "발행(UTC)", render: (r) => <Instant iso={r.createdAt} /> },
        ]} />
      <Pager next={list.next} loadMore={list.loadMore} />
    </>
  );
}

export function Issues() {
  const [pack, setPack] = useState("");
  const [vc, setVc] = useState("");
  return (
    <Section title="발행 목록">
      <div className="inline-form">
        <label className="field"><span>팩 필터</span><input value={pack} onChange={(e) => setPack(e.target.value)} placeholder="pak_nova_summer" /></label>
        <label className="field"><span>조합으로 거르기</span><input value={vc} onChange={(e) => setVc(e.target.value)} /></label>
      </div>
      <IssueTable pack={pack.trim()} vc={vc.trim()} />
    </Section>
  );
}

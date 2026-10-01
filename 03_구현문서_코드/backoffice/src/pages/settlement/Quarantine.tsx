import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Pager } from "../../components/Pager.tsx";
import { setActor, useActor } from "../../app/actor.ts";
import { useAction, useList } from "../../api/hooks.ts";
import { releaseQuarantine } from "../../api/settlement.ts";
import type { QuarantineRow } from "../../api/types.ts";

const SETTLE_ACTOR = "usr_settle";

export function Quarantine() {
  const actor = useActor();
  const list = useList<QuarantineRow>("quarantine", "/quarantine", { open: "true" });
  const m = useAction(releaseQuarantine, ["quarantine"]);
  return (
    <Section title="열린 격리" actions={
      <button type="button" className="btn primary" disabled={actor === SETTLE_ACTOR} onClick={() => setActor(SETTLE_ACTOR)}>usr_settle로 전환</button>
    }>
      <p>격리 해제는 정산 담당(SPACE_SETTLE)이 합니다. 현재 사용자: <strong>{actor}</strong></p>
      <ErrorPanel error={list.error} />
      <ErrorPanel error={m.error} />
      {m.isSuccess && <p className="muted" role="status">격리를 해제했습니다.</p>}
      <DataTable<QuarantineRow> rows={list.pages} empty="열린 격리가 없습니다."
        columns={[
          { key: "quarantineId", label: "격리" }, { key: "snapshotId", label: "발행 봉인" }, { key: "reason", label: "사유" },
          { key: "diagnostics", label: "진단", render: (r) => <details><summary>보기</summary><pre>{JSON.stringify(r.diagnostics, null, 2)}</pre></details> },
          { key: "createdAt", label: "생성(UTC)", render: (r) => <Instant iso={r.createdAt} /> },
          { key: "act", label: "작업", render: (r) => (
            <button type="button" className="btn tiny" aria-label={`격리[${r.snapshotId}] 해제`} disabled={m.isPending} onClick={() => m.mutate(r.snapshotId)}>해제</button>
          ) },
        ]} />
      <Pager next={list.next} loadMore={list.loadMore} />
    </Section>
  );
}

import { Section } from "../../components/Section.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { devApi, type ApiError } from "../../api/client.ts";
import type { SeedResult } from "../../api/types.ts";

/** Task 9에서 확장한다. 지금은 합성 곡 시드(POST)만 둔다. 응답은 ["dev","seed"] 캐시에 둔다. */
export function DevData() {
  const qc = useQueryClient();
  const seed = useMutation<SeedResult, ApiError>({
    mutationFn: () => devApi<SeedResult>("POST", "/seed/synthetic-song", {}),
    onSuccess: (r) => { qc.setQueryData(["dev", "seed"], r); },
  });
  return (
    <Section title="개발 데이터">
      <div className="stack">
        <div><button type="button" className="btn primary" disabled={seed.isPending} onClick={() => seed.mutate()}>합성 곡 불러오기</button></div>
        {seed.data && <p className="muted" role="status">불러왔습니다: 팩 {seed.data.packId}, 범위 {seed.data.factsScopeId}, 정책 {seed.data.policyId}</p>}
        <ErrorPanel error={seed.error} />
      </div>
    </Section>
  );
}

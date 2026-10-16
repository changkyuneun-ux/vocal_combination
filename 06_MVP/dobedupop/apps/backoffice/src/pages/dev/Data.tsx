import { Section } from "../../components/Section.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiError } from "../../api/client.ts";
import { resetDb, seedSong } from "../../api/dev.ts";
import { setActor } from "../../app/actor.ts";
import type { SeedResult } from "../../api/types.ts";

const DEFAULT_ACTOR = "usr_editor";

/** 합성 곡 시드(응답은 ["dev","seed"] 캐시에 둔다)와 검증 DB 초기화. 둘 다 성공하면 모든 쿼리를 무효화한다. */
export function DevData() {
  const qc = useQueryClient();
  const seed = useMutation<SeedResult, ApiError>({
    mutationFn: seedSong,
    onSuccess: async (r) => { qc.setQueryData(["dev", "seed"], r); await qc.invalidateQueries(); },
  });
  const reset = useMutation<{ ok: true }, ApiError>({
    mutationFn: resetDb,
    onSuccess: async () => {
      qc.removeQueries({ queryKey: ["dev", "seed"] });
      setActor(DEFAULT_ACTOR);
      await qc.invalidateQueries();
    },
  });
  const confirmReset = () => {
    if (window.confirm("검증 DB를 초기화합니다. 모든 데이터가 지워지고 가상 시계·사용자도 처음 상태로 돌아갑니다. 계속할까요?")) reset.mutate();
  };
  return (
    <Section title="개발 데이터">
      <div className="stack">
        <div className="inline-form">
          <button type="button" className="btn primary" disabled={seed.isPending} onClick={() => seed.mutate()}>합성 곡 불러오기</button>
          <button type="button" className="btn" disabled={reset.isPending} onClick={confirmReset}>검증 DB 초기화</button>
        </div>
        {seed.data && <p className="muted" role="status">불러왔습니다: 팩 {seed.data.packId}, 범위 {seed.data.factsScopeId}, 정책 {seed.data.policyId}</p>}
        {reset.isSuccess && <p className="muted" role="status">초기화했습니다. 사용자를 {DEFAULT_ACTOR}로 되돌렸습니다.</p>}
        <ErrorPanel error={seed.error} />
        <ErrorPanel error={reset.error} />
      </div>
    </Section>
  );
}

import { useGet } from "../../api/hooks.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Section } from "../../components/Section.tsx";

type Me = { userId: string; displayName: string; roles: string[]; tenantId: string; scope: string };
type MyParty = { partyId: string; partyType: string; displayName: string };

/** 권리자 포털 첫 화면: 로그인한 테넌트와 그 테넌트 소속 파티(정산 금액이 귀속되는 권리자). */
export function PortalHome() {
  const me = useGet<Me>(["me"], "/me");
  const parties = useGet<MyParty[]>(["my-parties"], "/my/parties");
  return (
    <>
      <Section title="내 테넌트">
        {me.error ? <ErrorPanel error={me.error} /> : me.data && (
          <p>{me.data.displayName} · 테넌트 <code>{me.data.tenantId}</code> · 범위 {me.data.scope === "platform" ? "플랫폼(전체)" : "자기 테넌트"} · 역할 {me.data.roles.join(", ") || "없음"}</p>
        )}
      </Section>
      <Section title="소속 파티">
        {parties.error ? <ErrorPanel error={parties.error} /> : (
          <DataTable rows={parties.data ?? []} empty="이 테넌트에 소속된 파티가 없습니다."
            columns={[{ key: "partyId", label: "파티", render: (r) => <code>{r.partyId}</code> }, { key: "partyType", label: "유형" }, { key: "displayName", label: "이름" }]} />
        )}
      </Section>
    </>
  );
}

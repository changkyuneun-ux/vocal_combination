import { useGet } from "../../api/hooks.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Money } from "../../components/Money.tsx";
import { Section } from "../../components/Section.tsx";

type TrustWork = {
  factsScopeId: string; workId: string; title: string; iswc: string | null;
  authors: { partyId: string; displayName: string; shareBps: number }[];
  usage: { combinations: number; purchases: number; amountKrw: string };
};

/** 신탁 작품(연결 열쇠, 테넌트 정책 4절): 신탁 연결이 활성인 작가의 작품 정보·작품 몫 지분·이용 실적만 보인다. 녹음·실연·레이블 몫·계약서는 보이지 않는다. */
export function TrustWorksPage() {
  const q = useGet<TrustWork[]>(["trust-works"], "/trust/works");
  return (
    <Section title="신탁 작품">
      <p className="muted">신탁 연결이 활성인 작가의 작품만 보입니다. 작품 몫은 신탁 수령 위임으로 이 조직 당사자가 받고, 금액은 "명세서"에서 봅니다.</p>
      <ErrorPanel error={q.error} />
      <DataTable<TrustWork> rows={q.data ?? []} empty="신탁 작품이 없습니다(활성 신탁 연결이 없거나, 그 작가의 작품이 아직 등록되지 않았습니다)." columns={[
        { key: "title", label: "작품", render: (w) => <><strong>{w.title}</strong><div className="muted small"><code>{w.workId}</code>{w.iswc && <> · ISWC {w.iswc}</>}</div></> },
        { key: "authors", label: "신탁 작가 · 작품 몫 지분", render: (w) => w.authors.map((a) => `${a.displayName} ${(a.shareBps / 100).toFixed(2)}%`).join(", ") },
        { key: "combos", label: "발행 조합", render: (w) => `${w.usage.combinations}개` },
        { key: "purchases", label: "구매 건수", render: (w) => `${w.usage.purchases}건` },
        { key: "amount", label: "구매 금액(전체)", render: (w) => <Money krw={w.usage.amountKrw} /> },
      ]} />
    </Section>
  );
}

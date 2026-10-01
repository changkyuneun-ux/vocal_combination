export function Pager({ next, loadMore }: { next: string | null; loadMore: () => void }) {
  if (!next) return null;
  return <button className="btn" onClick={loadMore}>더 보기</button>;
}

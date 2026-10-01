import { shortDigest } from "../format.ts";

export function Digest({ value }: { value: string }) {
  const copy = () => { void navigator.clipboard?.writeText(value).catch(() => undefined); };
  return (
    <span className="digest" title={value}>
      <code>{shortDigest(value)}</code>
      <button type="button" className="btn tiny" onClick={copy} aria-label="다이제스트 복사">복사</button>
    </span>
  );
}

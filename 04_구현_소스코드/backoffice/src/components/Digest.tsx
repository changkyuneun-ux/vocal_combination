import { shortDigest } from "../format.ts";

/** label은 같은 화면의 다이제스트 복사 버튼을 구분하는 이름이다(접근성 이름 "다이제스트[label] 복사"). */
export function Digest({ value, label }: { value: string; label?: string }) {
  const copy = () => { void navigator.clipboard?.writeText(value).catch(() => undefined); };
  return (
    <span className="digest" title={value}>
      <code>{shortDigest(value)}</code>
      <button type="button" className="btn tiny" onClick={copy} aria-label={label ? `다이제스트[${label}] 복사` : "다이제스트 복사"}>복사</button>
    </span>
  );
}

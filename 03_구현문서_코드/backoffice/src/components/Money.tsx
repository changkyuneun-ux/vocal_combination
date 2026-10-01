import { formatKrw } from "../format.ts";

export function Money({ krw }: { krw: string }) {
  return <span className={`money${krw.startsWith("-") ? " neg" : ""}`}>{formatKrw(krw)}</span>;
}

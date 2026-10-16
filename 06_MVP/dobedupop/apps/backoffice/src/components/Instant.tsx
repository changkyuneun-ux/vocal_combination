import { formatInstant } from "../format.ts";

export function Instant({ iso }: { iso: string | null }) {
  return iso ? <time dateTime={iso} title={iso}>{formatInstant(iso)}</time> : <span className="muted">—</span>;
}

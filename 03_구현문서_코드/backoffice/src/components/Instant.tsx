import { formatInstant } from "../format.ts";

export function Instant({ iso }: { iso: string | null }) {
  return iso ? <time dateTime={iso}>{formatInstant(iso)}</time> : <span className="muted">—</span>;
}

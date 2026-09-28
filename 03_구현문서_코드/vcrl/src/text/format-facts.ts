import type { Interval } from "../core/time.ts";
import type { FactsDocument } from "../facts/types.ts";
import { formatPercent, idText, quoteText } from "./format-allocation.ts";

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function idsText(ids: Readonly<Record<string, string>> | undefined): string {
  if (ids === undefined) return "";
  return ` ids: { ${Object.keys(ids).sort(byKey).map((k) => `${k}: ${quoteText(ids[k]!)}`).join(", ")} };`;
}

const interval = (v: Interval) => `[${v.from}, ${v.to ?? ""})`;
const opt = (label: string, v: string | undefined, render: (s: string) => string = (s) => s) =>
  v === undefined ? "" : ` ${label} ${render(v)}`;

/** 원문 facts IR을 사람이 검토할 수 있는 텍스트로 표시한다(스펙 4.1 스타일, 파싱하지 않는다). */
export function formatFacts(doc: FactsDocument): string {
  const b = doc.body;
  const lines: string[] = [`facts ${quoteText(doc.id)} version ${doc.version} {`];
  for (const p of b.parties) {
    lines.push(`  party ${idText(p.id)} { kind: ${p.kind};${idsText(p.ids)}${p.visibility === undefined ? "" : ` visibility: ${p.visibility};`} }`);
  }
  for (const w of b.works) lines.push(`  work ${idText(w.id)} {${idsText(w.ids)} }`);
  for (const r of b.recordings) lines.push(`  recording ${idText(r.id)} { of: ${idText(r.of)};${idsText(r.ids)} }`);
  for (const v of b.voices) lines.push(`  voice ${idText(v.id)} { kind: ${v.kind}; }`);
  for (const s of b.stems) {
    lines.push(`  stem ${idText(s.id)} { of: ${idText(s.of)}; slot: ${idText(s.slot)}; rights_bearing: ${s.rights_bearing}; }`);
  }
  for (const c of b.claims) {
    lines.push(
      `  claim ${idText(c.id)}: ${idText(c.source)} ${c.edge} ${idText(c.target)} share ${formatPercent(c.share)}` +
        `${opt("role", c.performer_role)}${opt("detail", c.role_detail, quoteText)}` +
        ` status ${c.status} valid ${interval(c.valid)} recorded ${c.recorded_at}` +
        `${opt("superseded", c.superseded_at)}${opt("evidence", c.evidence, quoteText)}${opt("visibility", c.visibility)};`,
    );
  }
  for (const m of b.mandates) {
    lines.push(
      `  mandate ${idText(m.id)}: ${idText(m.from)} -> ${idText(m.to)} right ${m.right} share ${formatPercent(m.share)}` +
        ` status ${m.status} valid ${interval(m.valid)} recorded ${m.recorded_at}` +
        `${opt("superseded", m.superseded_at)}${opt("visibility", m.visibility)};`,
    );
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

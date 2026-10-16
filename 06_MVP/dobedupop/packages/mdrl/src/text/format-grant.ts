import type { GrantDoc, GrantRule } from "../grant/types.ts";
import type { Scope } from "../core/scope.ts";
import type { Interval } from "../core/time.ts";
import { displayText } from "./format-facts.ts";
import { idText as bareOrQuoted } from "./format-allocation.ts";

const idText = (s: string) => bareOrQuoted(s, displayText);
const interval = (v: Interval) => `[${v.from}, ${v.to ?? ""})`;

function formatScope(s: Scope, indent = "    "): string {
  const lines: string[] = ["{"];
  lines.push(`${indent}  actions: [${s.actions.join(", ")}];`);
  lines.push(`${indent}  territories: [${s.territories.join(", ")}];`);
  lines.push(`${indent}  media: [${s.media.join(", ")}];`);
  lines.push(`${indent}  period: ${interval(s.period)};`);
  lines.push(`${indent}  audience: [${s.audience.join(", ")}];`);
  lines.push(`${indent}}`);
  return lines.join("\n");
}

export function formatGrant(doc: GrantDoc): string {
  const lines: string[] = [`grant ${displayText(doc.id)} version ${doc.version} {`];
  for (const g of doc.body.grants) {
    lines.push(`  rule ${idText(g.id)} {`);
    lines.push(`    grantor: ${idText(g.grantor)};`);
    if (g.grantee !== undefined) {
      lines.push(`    grantee: ${idText(g.grantee)};`);
    }
    lines.push(`    asset: ${idText(g.asset)};`);
    lines.push(`    right: ${g.right_type};`);
    lines.push(`    scope: ${formatScope(g.scope)};`);
    if (g.obligations !== undefined && g.obligations.length > 0) {
      lines.push(`    obligations: [${g.obligations.join(", ")}];`);
    }
    lines.push(`    status: ${g.status};`);
    lines.push(`    valid: ${interval(g.valid)};`);
    lines.push(`    recorded: ${g.recorded_at};`);
    lines.push(`  }`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

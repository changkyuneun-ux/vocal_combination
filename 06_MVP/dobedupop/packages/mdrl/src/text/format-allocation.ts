import { fail } from "../core/errors.ts";
import { parseRef } from "../core/ref.ts";
import type { AllocationDocument, VectorExpr } from "../allocation/types.ts";
import { inferRole } from "./roles.ts";

const BARE_ID = /^[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*$/;

export function quoteText(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 식별자 형태면 그대로, 아니면 `quote`로 따옴표 문자열을 쓴다(안분 텍스트는 렉서가 읽는 quoteText). */
export function idText(s: string, quote: (s: string) => string = quoteText): string {
  return BARE_ID.test(s) ? s : quote(s);
}

/** bps 문자열을 `%` 표기로 바꾼다(정수 연산, 소수 둘째 자리까지). */
export function formatPercent(bps: string): string {
  const n = BigInt(bps);
  const whole = n / 100n;
  const frac = n % 100n;
  return frac === 0n ? `${whole}%` : `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

const POOL_ARGS = ["fixed", "usage", "featured_weight"] as const;

function vectorText(e: VectorExpr): string {
  switch (e.fn) {
    case "graph":
      return `graph(${e.role})${e.via_mandate === true ? " via mandate" : ""}`;
    case "contract":
      return `contract(${idText(e.party)})`;
    case "member_pct":
      return "member_pct()";
    case "performance_pool":
      return `performance_pool(${e.mode}${POOL_ARGS.filter((k) => e[k] !== undefined).map((k) => `, ${k}: ${formatPercent(e[k]!)}`).join("")})`;
    case "mix":
      return `mix(${e.parts.map((p) => `${formatPercent(p.weight)}: ${vectorText(p.of)}`).join(", ")})`;
    case "cap":
      return `${vectorText(e.of)} |> cap(${formatPercent(e.max)})`;
    case "floor_guarantee":
      return `${vectorText(e.of)} |> floor_guarantee(${formatPercent(e.min)})`;
  }
}

/** 안분 정책 IR을 정규 텍스트로 쓴다. parseAllocation(formatAllocation(ir))은 ir과 같다. */
export function formatAllocation(doc: AllocationDocument): string {
  const b = doc.body;
  const lines: string[] = [`allocation ${quoteText(doc.id)} version ${doc.version} {`];
  doc.depends_on.forEach((dep, i) => {
    const ref = parseRef(dep.ref, `$.depends_on[${i}].ref`);
    if (ref.kind !== "facts") fail("CORE_TYPE_ERROR", `$.depends_on[${i}].ref`, "only facts dependencies can be written as text");
    lines.push(`  uses facts ${quoteText(ref.id)}@${ref.version} digest ${quoteText(dep.digest)};`);
  });
  if (doc.visibility_default !== "PARTIES") lines.push(`  visibility ${doc.visibility_default};`);
  lines.push(`  scope { pack: ${idText(b.scope.pack)}; events: [${b.scope.events.join(", ")}]; currency: ${b.scope.currency}; }`);
  lines.push(`  bind { time: ${b.bind.time}; }`);
  lines.push("  tier1 {");
  for (const t of b.tier1.buckets) lines.push(`    ${t.name} = ${formatPercent(t.bps)};`);
  lines.push("  }");
  lines.push(`  tier2 ${b.tier1.rights} {`);
  lines.push("    split {");
  for (const s of b.tier2.split) {
    const role = inferRole(s.vector) === s.role ? "" : ` as ${s.role}`;
    const via = s.via_mandate === true ? " via mandate" : "";
    lines.push(`      ${s.name} = ${vectorText(s.vector)}${via} : ${formatPercent(s.bps)}${role};`);
  }
  lines.push("    }");
  lines.push("  }");
  lines.push(`  rounding { method: ${b.rounding.method}; tie: ${b.rounding.tie}; }`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

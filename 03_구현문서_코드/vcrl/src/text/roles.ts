import type { VectorExpr } from "../allocation/types.ts";
import type { ClaimantRole } from "../facts/types.ts";

const PERFORMER_ROLES: ReadonlySet<string> = new Set(["PERFORMER_FEATURED", "PERFORMER_NON_FEATURED"]);
const POOL = "@pool";

/** 텍스트에서 `as ROLE`을 생략한 버킷의 역할을 벡터 식에서 추론한다(스펙 12.38). 추론할 수 없으면 undefined. */
export function inferRole(v: VectorExpr): ClaimantRole | undefined {
  const leaves = new Set<string>();
  const walk = (e: VectorExpr): void => {
    switch (e.fn) {
      case "graph":
        leaves.add(e.role);
        break;
      case "performance_pool":
      case "member_pct":
        leaves.add(POOL);
        break;
      case "mix":
        for (const p of e.parts) walk(p.of);
        break;
      case "cap":
      case "floor_guarantee":
        walk(e.of);
        break;
      case "contract":
        break;
    }
  };
  walk(v);
  if (leaves.size === 0) return undefined;
  const all = [...leaves];
  if (all.every((r) => r === POOL || PERFORMER_ROLES.has(r))) {
    const graphs = all.filter((r) => r !== POOL);
    return graphs.length === 1 && !leaves.has(POOL) ? (graphs[0] as ClaimantRole) : "PERFORMER_FEATURED";
  }
  return all.length === 1 ? (all[0] as ClaimantRole) : undefined;
}

import { commitValue } from "../core/commit.ts";
import { digestOf } from "../core/digest.ts";
import type { FactsDocument } from "./types.ts";

export type SaltFor = (path: string) => Uint8Array;

/**
 * 공개본: share·evidence는 visibility가 PUBLIC이 아니면(기본 PARTIES) 커밋먼트로 치환한다.
 * party·work·recording·voice·stem의 존재와 식별자는 공개한다(스펙 3.4).
 * `PRIVATE` party는 id·kind만 공개하고 외부 식별자 `ids`는 커밋먼트로 치환한다(스펙 12.17).
 */
export function publicFacts(doc: FactsDocument, saltFor: SaltFor): { doc: unknown; digest: string } {
  const b = doc.body;
  const parties = b.parties.map((p) =>
    p.visibility === "PRIVATE" && p.ids !== undefined
      ? { ...p, ids: commitValue(p.ids, saltFor(`$.body.parties.${p.id}.ids`)) }
      : p);
  const claims = b.claims.map((c) => {
    if ((c.visibility ?? "PARTIES") === "PUBLIC") return c;
    const base = `$.body.claims.${c.id}`;
    return {
      ...c,
      share: commitValue(c.share, saltFor(`${base}.share`)),
      ...(c.evidence === undefined ? {} : { evidence: commitValue(c.evidence, saltFor(`${base}.evidence`)) }),
    };
  });
  const mandates = b.mandates.map((m) => {
    if ((m.visibility ?? "PARTIES") === "PUBLIC") return m;
    const base = `$.body.mandates.${m.id}`;
    return {
      ...m,
      share: commitValue(m.share, saltFor(`${base}.share`)),
      ...(m.evidence === undefined ? {} : { evidence: commitValue(m.evidence, saltFor(`${base}.evidence`)) }),
    };
  });
  const pub = { ...doc, body: { ...b, parties, claims, mandates } };
  return { doc: pub, digest: digestOf(pub) };
}

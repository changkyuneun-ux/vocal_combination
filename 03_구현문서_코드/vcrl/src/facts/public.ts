import { commitValue } from "../core/commit.ts";
import { digestOf } from "../core/digest.ts";
import type { FactsDocument } from "./types.ts";

export type SaltFor = (path: string) => Uint8Array;

/**
 * 공개본: share·evidence는 visibility가 PUBLIC이 아니면(기본 PARTIES) 커밋먼트로 치환한다.
 * party·work·recording·voice·stem의 존재와 식별자는 공개한다(스펙 3.4).
 */
export function publicFacts(doc: FactsDocument, saltFor: SaltFor): { doc: unknown; digest: string } {
  const b = doc.body;
  const claims = b.claims.map((c) => {
    if ((c.visibility ?? "PARTIES") === "PUBLIC") return c;
    const base = `$.body.claims.${c.id}`;
    return {
      ...c,
      share: commitValue(c.share, saltFor(`${base}.share`)),
      ...(c.evidence === undefined ? {} : { evidence: commitValue(c.evidence, saltFor(`${base}.evidence`)) }),
    };
  });
  const mandates = b.mandates.map((m) =>
    (m.visibility ?? "PARTIES") === "PUBLIC" ? m : { ...m, share: commitValue(m.share, saltFor(`$.body.mandates.${m.id}.share`)) });
  const pub = { ...doc, body: { ...b, claims, mandates } };
  return { doc: pub, digest: digestOf(pub) };
}

/**
 * 전자서명 공급자(원천 문서 설계 S4, 결정 D1). 국내 사업자로 정했지만 사업자는 아직 고르지 않았다. 그때까지 이 인터페이스 뒤에
 * 개발용 임의 공급자를 붙이고, 사업자가 정해지면 공급자만 바꾼다(본인 인증 공급자와 같은 방식).
 * 공급자는 서명 요청을 받아 당사자 본인 확인과 서명을 맡고, 모든 서명이 끝나면 서명 증명이 붙은 서명본을 돌려준다.
 */
export type SignerInfo = { partyId: string; displayName: string };
export type SignatureEvidence = SignerInfo & { signedAt: string; method: string; signedBy?: string };
export type SignatureProvider = {
  /** 서명 기록에 남는 방법 이름(예: DEV_ESIGN). */
  name: string;
  /** 서명 요청을 보낸다. 서명은 문서 해시(sha256)에 대해 받는다. */
  send(req: { contractId: string; title: string; sha256: string; signers: SignerInfo[] }): Promise<{ providerRef: string }>;
  /** 모든 당사자가 서명한 뒤 서명본을 받는다. 서명 증명(서명자·시각·방법·원문 해시)이 문서 안에 들어간다. */
  finalize(req: { contractId: string; providerRef: string; html: string; sha256: string; signatures: SignatureEvidence[] }): Promise<{ html: string }>;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 개발·시험용 임의 공급자: 밖으로 보내지 않는다. 플랫폼 사용자는 앱에서 서명하고, 플랫폼 밖 당사자는 개발 도구(/dev/esign)가 공급자 통지를 흉내 낸다. */
export const devSignatureProvider: SignatureProvider = {
  name: "DEV_ESIGN",
  send: async (req) => ({ providerRef: `dev_${req.contractId}` }),
  finalize: async (req) => {
    const rows = req.signatures.map((s) => `<tr><td>${esc(s.displayName)} (${esc(s.partyId)})</td><td>${esc(s.signedAt)}</td><td>${esc(s.method)}${s.signedBy ? ` · ${esc(s.signedBy)}` : ""}</td></tr>`).join("");
    const cert = `<section class="certificate"><h2>서명 증명(개발용 공급자 — 법적 효력 없음)</h2><p>원문 SHA-256: <code>${esc(req.sha256)}</code> · 공급자 참조: <code>${esc(req.providerRef)}</code></p>`
      + `<table><thead><tr><th>서명 당사자</th><th>서명 시각</th><th>방법</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    return { html: req.html.replace("</body>", `${cert}</body>`) };
  },
};

import { advance, as, BACKEND, expect, ok, prepareSettled, test } from "./fixtures.ts";

/**
 * 근거 연결과 확인(원천 문서 설계 S3): 계약서를 올리고 조항을 표시해 권리 주장에 연결한다. 플랫폼 밖 작가의 지분 주장은
 * ASSERTED로 등록되면 확인 요청이 간다. 기한(14일)이 지나도 플랫폼은 원문 대조로 확정하지 않는다(결정 WD3) — 운영 화면에 확인 버튼이 없고
 * 요청은 확인 대기로 남는다(정합성 경고가 차단으로 오른다). 확정은 작가 본인의 확인·서명으로만 된다.
 */
test("조항 표시·기록 연결, 기한 뒤에도 플랫폼 확정은 없다", async ({ page, request }) => {
  const s = await prepareSettled(request);
  await ok(request, "usr_editor", "POST", "/parties", { partyId: "pty_e2e_writer", partyType: "AUTHOR", displayName: "작가 E" });

  await page.goto("/documents");
  await as(page, "usr_editor");
  await page.getByLabel("문서 종류").selectOption("PUBLISHING");
  await page.getByLabel("문서 제목").fill("작가 E 계약");
  await page.getByLabel("당사자").fill("pty_e2e_writer");
  await page.getByLabel("원문 파일").setInputFiles({ name: "writer.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% writer E share 10%\n%%EOF\n") });
  await page.getByRole("button", { name: "올리기" }).click();
  await expect(page.getByRole("heading", { name: /^문서 doc_/ })).toBeVisible();
  const docs = await ok<{ documentId: string; title: string }[]>(request, "usr_editor", "GET", "/documents");
  const doc = docs.find((d) => d.title === "작가 E 계약")!;

  // 지분 주장(ASSERTED, 근거 문서 연결) → 상대에게 확인 요청이 자동으로 간다.
  await ok(request, "usr_editor", "POST", "/claims", {
    claimId: "c_e2e_writer", factsScopeId: s.factsScopeId, sourceId: "wrk_nova_summer", edge: "WRITTEN_BY", targetId: "pty_e2e_writer", shareBps: 1000,
    status: "ASSERTED", validFrom: "2026-01-01T00:00:00.000Z", evidenceDocuments: [{ documentId: doc.documentId, version: 1 }],
  });

  await page.getByLabel("쪽").fill("3");
  await page.getByLabel("조항 종류").selectOption("SHARE");
  await page.getByLabel("조항 원문").fill("작가 E는 작품의 10%를 가진다");
  await page.getByRole("button", { name: "조항 표시" }).click();
  await expect(page.getByRole("status").filter({ hasText: "조항을 표시했습니다" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "작가 E 계약" }).click();
  const clause = page.locator("[data-clause]").first();
  await expect(clause).toContainText("작가 E는 작품의 10%를 가진다");
  await clause.getByLabel("연결할 기록 id").fill("c_e2e_writer");
  await clause.getByRole("button", { name: "기록에 연결" }).click();
  await page.reload();
  await page.getByRole("button", { name: "작가 E 계약" }).click();
  await expect(page.locator("[data-clause]").first()).toContainText("CLAIM c_e2e_writer v1");

  await advance(page, "+30일");
  await page.goto("/confirmations");
  await as(page, "usr_ops");
  const row = page.getByRole("row").filter({ hasText: "c_e2e_writer" });
  await expect(row).toContainText("확인 대기");
  await expect(row.getByRole("button", { name: "플랫폼 확인" })).toHaveCount(0);
  const reqs = await ok<{ recordId: string; requestId: number; status: string }[]>(request, "usr_ops", "GET", "/confirmations?status=OPEN");
  const req = reqs.find((r) => r.recordId === "c_e2e_writer")!;
  expect((await request.post(`${BACKEND}/ops/confirmations/${req.requestId}/platform-verify`, { headers: { "x-actor": "usr_ops" }, data: { reason: "계약서 p.3 대조" } })).status()).toBe(404);
  expect((await request.post(`${BACKEND}/ops/confirmations/${req.requestId}/confirm`, { headers: { "x-actor": "usr_ops" }, data: {} })).status()).toBe(403);
});

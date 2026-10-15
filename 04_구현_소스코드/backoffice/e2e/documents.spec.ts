import { as, expect, ok, prepareSettled, test } from "./fixtures.ts";

/** 원천 문서(원천 문서 설계 S1): 원문 올리기 → 권리 주장의 근거로 연결 → 권리 요약에 근거 문서·봉인 상태가 보인다. */
test("원천 문서: 올리기, 근거 연결, 권리 요약", async ({ page, request }) => {
  const s = await prepareSettled(request);
  await page.goto("/documents");
  await as(page, "usr_editor");
  await page.getByLabel("문서 종류").selectOption("MASTER_CONTRACT");
  await page.getByLabel("문서 제목").fill("Nova Summer 녹음 계약");
  await page.getByLabel("당사자").fill("pty_label");
  await page.getByLabel("원문 파일").setInputFiles({ name: "master.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% e2e master contract\n%%EOF\n") });
  await page.getByRole("button", { name: "올리기" }).click();
  await expect(page.getByRole("heading", { name: /^문서 doc_/ })).toBeVisible();

  const docs = await ok<{ documentId: string; title: string }[]>(request, "usr_editor", "GET", "/documents");
  const doc = docs.find((d) => d.title === "Nova Summer 녹음 계약")!;
  await ok(request, "usr_editor", "POST", "/claims", {
    claimId: "c_master", factsScopeId: s.factsScopeId, sourceId: "rcd_nova_summer", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000,
    status: "VERIFIED", validFrom: "2026-01-01T00:00:00.000Z", evidenceDocuments: [{ documentId: doc.documentId, version: 1 }],
  });

  await page.goto(`/registry/summary?scope=${s.factsScopeId}`);
  const master = page.locator('[data-line="rcd_nova_summer"]');
  await expect(master).toContainText("pty_label 100%");
  await expect(master).toContainText("Nova Summer 녹음 계약");
  await expect(page.getByLabel("봉인 상태")).toContainText("봉인 이후 바뀐 기록 1건");
});

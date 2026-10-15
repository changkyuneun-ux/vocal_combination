import { expect, ok, resetAll, test } from "./fixtures.ts";
import { gen } from "../../audio-service/test/gen.ts";

/**
 * 스템 오디오(다음 작업 9): 화면에서 오디오를 올리면 개발 서버의 작업 큐가 오디오 처리 서비스로 검사하고 상태가 바뀐다.
 * 깨끗한 스템은 READY, 무음 스템은 QC_FAILED로 ⑤ 오디오 검수 큐에 나온다.
 */
test("스템 오디오: 올리기 → 검사 → READY / QC_FAILED, 검수 큐", async ({ page, request }) => {
  test.setTimeout(120_000);
  await resetAll(request);
  await ok(request, null, "POST", "/dev/seed/synthetic-song", {});
  const clean = await gen("sine=frequency=440:duration=31:sample_rate=48000", undefined, "volume=2");
  const silent = await gen("anullsrc=r=48000:cl=mono", ["-t", "31", "-ar", "48000", "-c:a", "pcm_s24le"]);

  await page.goto("/audio?scope=fsc_nova_summer");
  const table = page.getByRole("table", { name: "스템 오디오 상태" });
  await expect(table).toBeVisible();
  await page.getByLabel("스템[stm_a_slt_1] 오디오 파일").setInputFiles({ name: "a1.wav", mimeType: "audio/wav", buffer: clean });
  await page.getByLabel("스템[stm_b_slt_1] 오디오 파일").setInputFiles({ name: "b1.wav", mimeType: "audio/wav", buffer: silent });
  await expect(table.locator("tr", { hasText: "stm_a_slt_1" }).locator(".badge")).toHaveText("READY", { timeout: 60_000 });
  await expect(table.locator("tr", { hasText: "stm_b_slt_1" }).locator(".badge")).toHaveText("QC_FAILED", { timeout: 60_000 });
  const queue = page.getByRole("region", { name: "⑤ 오디오 검수 큐" });
  await expect(queue).toContainText("stm_b_slt_1");
  await expect(queue).toContainText("SILENT");
});

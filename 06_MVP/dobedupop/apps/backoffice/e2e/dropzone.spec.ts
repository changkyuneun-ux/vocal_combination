import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, ok, test } from "./fixtures.ts";

/**
 * 첨부 끌어 놓기(DropZone): 새 곡 마법사(녹음·작품 계약서) · 문서·계약 원본 계약서 올리기 · 스템 오디오(추가·새 버전).
 * DataTransfer로 drop → 파일 이름 표시 → 저장·올리기. 형식이 틀리면 상자 아래 한 줄 오류, 파일을 받지 않는다.
 * 개발 서버(로컬)에서 돈다 — 분배 규칙 활성화(IR v1)까지 돌린 개발 DB.
 */
async function dropFile(page: Page, zone: Locator, f: { name: string; type: string; text: string }) {
  const dt = await page.evaluateHandle((x) => { const d = new DataTransfer(); d.items.add(new File([x.text], x.name, { type: x.type })); return d; }, f);
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(zone).toHaveAttribute("data-over", "true"); // 끌고 들어오면 강조
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(zone).not.toHaveAttribute("data-over", "true");
}
const PDF = (name: string) => ({ name, type: "application/pdf", text: `%PDF-1.4\n% ${name} ${Date.now()}\n%%EOF\n` });
const PNG = { name: "scan.png", type: "image/png", text: "not a pdf" };
const WAV = (name: string) => ({ name, type: "audio/wav", text: `RIFF${Date.now()}WAVEfmt ` });

test("끌어 놓기: 새 곡 계약서 · 원본 계약서 올리기 · 스템 오디오", async ({ page, request }) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "policy"], { stdio: "inherit", timeout: 300_000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.clear());

  // 1. 문서·계약 › + 원본 계약서 올리기
  await page.goto("/portal/works/wrk_dynamite/contracts");
  const originals = page.getByRole("table", { name: "① 원본 계약서" });
  await expect(originals.locator("tbody tr")).toHaveCount(2); // 시드: 녹음·작품 원본 계약서
  const before = 2;
  await page.getByRole("button", { name: "+ 원본 계약서 올리기" }).click();
  const panel = page.getByRole("complementary", { name: "원본 계약서 올리기" });
  const zone = panel.getByRole("group", { name: "계약서 파일 끌어 놓기" });
  await dropFile(page, zone, PNG);
  await expect(panel.getByRole("alert")).toHaveText("PDF만 올릴 수 있습니다");
  await expect(panel.getByRole("button", { name: "올리기" })).toBeDisabled();
  await dropFile(page, zone, PDF("끌어놓은 녹음 계약서.pdf"));
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(zone).toContainText("끌어놓은 녹음 계약서.pdf");
  await expect(zone.getByText("바꾸기")).toBeVisible();
  await panel.getByRole("button", { name: "올리기" }).click();
  await expect(panel).toHaveCount(0);
  await expect(originals.locator("tbody tr")).toHaveCount(before + 1);

  // 2. 스템 오디오: 추가(오디오만) → 새 버전(오디오 바꾸기)
  await page.goto("/portal/works/wrk_dynamite/stems");
  await page.getByRole("button", { name: "+ 스템 추가" }).click();
  const add = page.getByRole("complementary", { name: "스템 추가" });
  const az = add.getByRole("group", { name: "오디오 파일 끌어 놓기" });
  await dropFile(page, az, PDF("잘못.pdf"));
  await expect(add.getByRole("alert")).toContainText("오디오 파일(WAV 등)만 올릴 수 있습니다");
  await dropFile(page, az, WAV("drop-stem.wav"));
  await expect(az).toContainText("drop-stem.wav");
  await add.getByRole("button", { name: "추가", exact: true }).click();
  await expect(add).toHaveCount(0);
  const audio = await ok<{ stemId: string }[]>(request, "usr_bh_rights", "GET", "/portal/scopes/fsc_dynamite/stem-audio");
  expect(audio.some((a) => /_v2$/.test(a.stemId)), JSON.stringify(audio.map((a) => a.stemId))).toBe(true);
  await page.getByRole("button", { name: /Intro Chorus · 파트 1 \(정국\) 지민 등록/ }).click();
  await page.getByRole("complementary", { name: "선택한 스템" }).getByRole("button", { name: "새 버전(오디오 바꾸기)" }).click();
  const edit = page.getByRole("complementary", { name: "스템 수정" });
  const ez = edit.getByRole("group", { name: "오디오 파일 끌어 놓기" });
  await dropFile(page, ez, PNG);
  await expect(edit.getByRole("alert")).toBeVisible();
  await expect(edit.getByRole("button", { name: "저장" })).toBeDisabled();
  await dropFile(page, ez, WAV("new-version.wav"));
  await expect(ez).toContainText("new-version.wav");
  await edit.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("complementary", { name: "선택한 스템" })).toBeVisible();

  // 3. 새 곡 마법사: 녹음 계약서(1단계) · 작품 계약서(2단계)
  await page.goto("/portal/works/new");
  await page.getByLabel("곡 제목").fill(`Drop Song ${Date.now() % 100000}`);
  await page.getByLabel("마스터 보유").selectOption("pty_bighit_label");
  const mz = page.getByRole("group", { name: "녹음 계약서 끌어 놓기" });
  await dropFile(page, mz, PNG);
  await expect(page.getByRole("alert")).toHaveText("PDF만 올릴 수 있습니다");
  await dropFile(page, mz, PDF("drop-master.pdf"));
  await expect(mz).toContainText("drop-master.pdf");
  await expect(page.getByRole("table", { name: "올린 녹음 계약서" })).toContainText("drop-master.pdf");
  await page.getByRole("button", { name: "저장하고 ② 원곡 권리로" }).click();
  await expect(page.getByText("이 곡의 원본 계약서로 연결")).toBeVisible();
  await page.getByLabel("작가", { exact: true }).first().selectOption("pty_david_stewart");
  const wz = page.getByRole("group", { name: "작품 계약서 끌어 놓기" });
  await dropFile(page, wz, PDF("drop-publishing.pdf"));
  await expect(page.getByRole("table", { name: "올린 작품 계약서" })).toContainText("drop-publishing.pdf");
  await page.getByRole("button", { name: "저장하고 ③ 멤버로" }).click();
  await expect(page.getByRole("button", { name: "저장하고 ④ 확인으로" })).toBeVisible();
  // 상자 밖에 떨어뜨려도 브라우저가 파일을 열지 않는다(화면 그대로)
  const url = page.url();
  const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["x"], "x.pdf", { type: "application/pdf" })); return d; });
  await page.locator("h1").dispatchEvent("drop", { dataTransfer: dt });
  expect(page.url()).toBe(url);
});

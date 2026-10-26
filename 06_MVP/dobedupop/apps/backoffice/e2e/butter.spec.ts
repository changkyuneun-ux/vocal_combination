import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKEND, expect, ok, poll, test } from "./fixtures.ts";

/**
 * Butter 새 곡 → 판매 중을 총괄 한 계정(usr_admin)이 포털 화면만으로(절차서 00_프로젝트_개요/Butter_새곡_판매중_절차_20261025.md).
 * 화면 밖은 절차서가 허용한 둘뿐이다: 멤버 확인·이용 동의·수령 위임 서명은 실연자 앱과 같은 API, 계정 없는 작가의 전자서명은 '공급자 서명(개발)'.
 * 시험 코드가 API로 읽는 것은 id 확인(조회)뿐이다. 개발 DB를 Dynamite 지급 단계까지 돌린 뒤 그 위에 Butter를 만든다.
 * BUTTER_OUT=<폴더>를 주면 단계별 표(steps.json)와 스크린샷을 남긴다(따라 해 보기 보고용).
 */
const ADMIN = "usr_admin";
const AUTHORS: [string, string][] = [["Jenna Andrews", "FOREIGN_INDIVIDUAL"], ["Rob Grimaldi", "FOREIGN_INDIVIDUAL"], ["Stephen Kirk", "FOREIGN_INDIVIDUAL"], ["RM(김남준)", "DOMESTIC_INDIVIDUAL"],
  ["Alex Bilowitz", "FOREIGN_INDIVIDUAL"], ["Sebastian Garcia", "FOREIGN_INDIVIDUAL"], ["Ron Perry", "FOREIGN_INDIVIDUAL"]];
const MEMBERS = ["jungkook", "jimin", "v", "jin", "rm", "jhope", "suga"];
const NAME: Record<string, string> = { jungkook: "정국", jimin: "지민", v: "뷔", jin: "진", rm: "RM", jhope: "제이홉", suga: "슈가" };
// 슬롯(초): [이름, 시작, 끝, [[멤버, 시작, 끝]...]] — 보컬 파트가 없으면 반주만. 2:44 = 164초.
const SLOTS: [string, number, number, [string, number, number][]][] = [["Intro", 0, 8, []], ["Verse 1", 8, 30, [["jungkook", 8, 19], ["jimin", 19, 30]]],
  ["Pre-Chorus", 30, 42, [["v", 30, 36], ["jin", 36, 42]]], ["Chorus", 42, 60, [["jungkook", 42, 51], ["jimin", 51, 60]]],
  ["Verse 2 (Rap)", 60, 80, [["rm", 60, 67], ["suga", 67, 74], ["jhope", 74, 80]]], ["Pre-Chorus 2", 80, 92, [["jin", 80, 86], ["v", 86, 92]]],
  ["Chorus 2", 92, 110, [["jungkook", 92, 101], ["jimin", 101, 110]]], ["Bridge", 110, 128, [["v", 110, 119], ["jin", 119, 128]]],
  ["Final Chorus", 128, 150, [["jungkook", 128, 139], ["jimin", 139, 150]]], ["Outro", 150, 164, []]];
const EXTRAS: [string, string][] = [["Verse 1", "jin"], ["Chorus", "v"], ["Verse 2 (Rap)", "jungkook"]];
const USAGE = ["미리듣기", "조합 생성", "개인 보관", "링크 공유", "대한민국", "팬앱", "팬 커뮤니티"];

const pdf = (n: string) => ({ name: n, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${n} (시험용)\n%%EOF\n`) });
/** 디코드되는 WAV: 48kHz 16비트 모노 사인파(440Hz). */
function sineWav(sec = 2, rate = 48000): Buffer {
  const n = sec * rate, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return b;
}

type Row = { step: string; screen: string; did: string; result: string; how: string; sec: number };
test("Butter 새 곡 → 판매 중: 총괄 한 계정, 포털 화면만으로", async ({ page, request }) => {
  test.setTimeout(1_500_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "payout"], { stdio: "inherit", timeout: 600_000 });
  const out = process.env.BUTTER_OUT;
  if (out) mkdirSync(out, { recursive: true });
  const rows: Row[] = [];
  const t0 = Date.now();
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  const shot = async (name: string) => { if (out) await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };
  const rec = async (step: string, screen: string, did: string, result: string, how = "화면") => {
    rows.push({ step, screen, did, result, how, sec: Math.round((Date.now() - t0) / 1000) });
    if (out) writeFileSync(`${out}/steps.json`, JSON.stringify(rows, null, 1));
  };
  const band = async () => { const b = page.getByRole("status", { name: "곡 진행" }); await expect(b).toContainText("분배·출시"); return (await b.innerText()).replace(/\n/g, " "); };
  const get = <T,>(path: string) => ok<T>(request, ADMIN, "GET", `/portal${path}`);
  const performer = <T,>(m: string, method: "GET" | "POST", path: string, body?: unknown) => ok<T>(request, `usr_member_${m}`, method, `/performer${path}`, body);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.clear()); // 포털 기본 사용자 = 총괄 usr_admin
  await page.goto("/portal/");
  await expect(page.getByLabel("로그인한 사용자")).toHaveText("총괄 · usr_admin");

  // 1. 작가 7명: 운영 관리 › 조직 › 내 조직 › + 당사자 등록(빅히트 관리 당사자)
  const authorIds: string[] = [];
  for (const [name, cls] of AUTHORS) {
    await page.getByRole("button", { name: "+ 당사자 등록" }).click();
    const p = page.getByRole("complementary", { name: "당사자 등록" });
    await p.getByLabel("유형").selectOption("AUTHOR");
    await p.getByLabel("표시 이름").fill(name);
    await p.getByLabel("국가 · 구분").selectOption(cls);
    await p.getByLabel("연락 이메일(전자서명 링크)").fill(`${name.replace(/[^A-Za-z]/g, "").toLowerCase() || "rm"}@example.com`);
    await p.getByRole("button", { name: "등록", exact: true }).click();
    const detail = page.getByRole("complementary", { name: "당사자 상세 · 지급 정보" });
    await expect(detail.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByRole("table", { name: "관리 당사자" }).getByRole("row", { name: new RegExp(name.replace(/[()]/g, "\\$&")) })).toContainText("지급 정보 없음");
  }
  const mine = await get<{ partyId: string; displayName: string }[]>("/my/parties");
  for (const [name] of AUTHORS) authorIds.push(mine.find((x) => x.displayName === name)!.partyId);
  await shot("01-parties");
  await rec("1 작가 7명 등록", "운영 관리 › 조직 › 내 조직 › + 당사자 등록", "유형 작가·표시 이름·국가·구분·연락 이메일 → 등록 ×7", `빅히트 관리 작가 7명(${authorIds.join(", ")}), 상태 '지급 정보 없음'`);

  // 2. 새 곡 마법사 ①~④
  await page.goto("/portal/works");
  await page.getByRole("link", { name: "+ 새 곡 워크스페이스" }).click();
  await page.getByLabel("곡 제목").fill("Butter");
  await page.getByLabel("녹음 버전").fill("Original");
  await page.getByLabel("마스터 보유").selectOption("pty_bighit_label");
  await page.getByLabel("녹음 계약서", { exact: true }).setInputFiles(pdf("Butter 녹음 계약서.pdf"));
  await page.getByRole("button", { name: "저장하고 ② 원곡 권리로" }).click();
  await page.getByRole("button", { name: "저장하고 ③ 멤버로" }).waitFor();
  const WID = new URL(page.url()).searchParams.get("work")!;
  for (let i = 1; i < AUTHORS.length; i++) await page.getByRole("button", { name: "+ 작가" }).click();
  const sels = page.getByLabel("작가", { exact: true });
  for (let i = 0; i < AUTHORS.length; i++) await sels.nth(i).selectOption(authorIds[i]!);
  await page.getByRole("button", { name: "균등 분배" }).click();
  await page.getByLabel("작품 계약서", { exact: true }).setInputFiles(pdf("Butter 작품 퍼블리싱 계약서.pdf"));
  await page.getByRole("button", { name: "저장하고 ③ 멤버로" }).click();
  await page.getByRole("button", { name: "저장하고 ④ 확인으로" }).waitFor();
  for (const m of MEMBERS) await page.getByRole("checkbox", { name: NAME[m], exact: true }).check();
  await page.getByRole("button", { name: "저장하고 ④ 확인으로" }).click();
  await page.getByRole("button", { name: "워크스페이스로 — 슬롯·파트 등록" }).click();
  await expect(page).toHaveURL(new RegExp(`/works/${WID}/rights`));
  const ov = await get<{ workId: string; scopeId: string; status: string }[]>("/works/overview");
  const SCOPE = ov.find((x) => x.workId === WID)!.scopeId;
  const REC = `rcd_${WID.slice(4)}`;
  const f0 = await get<{ voices: { voiceId: string }[] }>(`/scopes/${SCOPE}/facts`);
  // 막힌 곳 1·2: 보이스는 곡 단위 voc_<곡>_<멤버> — Dynamite의 voc_<멤버>와 겹치지 않는다.
  expect(f0.voices.map((v) => v.voiceId).sort()).toEqual(MEMBERS.map((m) => `voc_${SCOPE.replace(/^fsc_/, "")}_${m}`).sort());
  await shot("02-wizard-done");
  await rec("2 새 곡 마법사 ①~④", "작품 목록 › + 새 곡 워크스페이스", "① 곡·녹음·마스터 보유·녹음 계약서 → ② 작가 7명 균등·작품 계약서 → ③ 멤버 7명 → ④ 워크스페이스로",
    `작품 ${WID}, 보이스 ${f0.voices.length}개(곡 단위 voc_${SCOPE.slice(4)}_<멤버>). 곡 진행: ${await band()}`);

  // 3. 슬롯·파트(원곡 권리 탭)
  for (const [label, s, e, parts] of SLOTS) {
    await page.getByRole("button", { name: "+ 슬롯 추가" }).click();
    await page.getByLabel("구간 이름").fill(label);
    await page.getByLabel("시작(초)").fill(String(s));
    await page.getByLabel("끝(초)").fill(String(e));
    await page.getByRole("button", { name: "슬롯 저장" }).click();
    await expect(page.getByLabel("구간 이름")).toHaveCount(0);
    for (const [m, ps, pe] of parts) {
      const esc = label.replace(/[()]/g, "\\$&");
      const slotRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${esc}( · |$)`) }) });
      await slotRow.getByRole("button", { name: "파트 추가" }).click();
      await page.getByLabel("원곡 담당").selectOption(`pty_${m}`);
      await page.getByLabel("파트 시작(초)").fill(String(ps));
      await page.getByLabel("파트 끝(초)").fill(String(pe));
      await page.getByRole("button", { name: "저장", exact: true }).click();
      await page.getByLabel("원곡 담당").waitFor({ state: "detached" });
    }
  }
  type Facts = { slots: { slotId: string; sectionLabel: string; sortOrder: number; parts: { partNo: number; kind: string; originalPartyId: string | null }[] }[]; stems: { stemId: string; slotId: string; partNo: number; performerPartyId: string | null }[];
    claims: { edge: string; targetId: string; sourceId: string; supersededAt: string | null }[] };
  const f1 = await get<Facts>(`/scopes/${SCOPE}/facts`);
  const nParts = f1.slots.reduce((a, s) => a + s.parts.length, 0);
  await shot("03-slots");
  await rec("3 슬롯·파트", "곡 › 원곡 권리 › + 슬롯 추가 · 파트 추가", "슬롯 10(0~164초) · 보컬 파트 17(원곡 담당·시각)", `슬롯 ${f1.slots.length} · 파트 ${nParts}`);

  // 4. 스템: 스템 탭 › + 스템 추가(원곡 파트마다 하나 + 추가 녹음 3). 첫 스템은 사인파 WAV를 끌어 놓는다.
  await page.goto(`/portal/works/${WID}/stems`);
  const wav = sineWav(8); // Intro 슬롯 길이(8초)와 같게 — 짧으면 출처 검사가 REVIEW
  const parts = [...f1.slots].sort((a, b) => a.sortOrder - b.sortOrder).flatMap((s) => s.parts.map((p) => ({ s, p })));
  let first = true;
  const addStem = async (slotId: string, partNo: number, singer: string | null) => {
    await page.getByRole("button", { name: "+ 스템 추가" }).click();
    const p = page.getByRole("complementary", { name: "스템 추가" });
    await p.getByLabel("슬롯 · 파트").selectOption(`${slotId}#${partNo}`);
    if (singer) await p.getByLabel("부른 멤버").selectOption(singer);
    if (first) {
      // 끌어 놓기: 브라우저 DataTransfer로 파일을 놓는다(파일 고르기 창이 아니라 drop 이벤트).
      const dt = await page.evaluateHandle((b64) => {
        const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const d = new DataTransfer(); d.items.add(new File([u], "butter_intro.wav", { type: "audio/wav" })); return d;
      }, wav.toString("base64"));
      const zone = p.getByRole("group", { name: "오디오 파일 끌어 놓기" });
      await zone.dispatchEvent("dragenter", { dataTransfer: dt });
      await zone.dispatchEvent("dragover", { dataTransfer: dt });
      await zone.dispatchEvent("drop", { dataTransfer: dt });
      await expect(p).toContainText("butter_intro.wav");
      await shot("04-stem-drop");
      first = false;
    }
    await p.getByRole("button", { name: "추가", exact: true }).click();
    await expect(p).toHaveCount(0);
  };
  for (const { s, p } of parts) await addStem(s.slotId, p.partNo, p.kind === "VOCAL" ? p.originalPartyId : null);
  for (const [label, m] of EXTRAS) {
    const s = f1.slots.find((x) => x.sectionLabel === label)!;
    await addStem(s.slotId, s.parts.find((x) => x.kind === "VOCAL")!.partNo, `pty_${m}`);
  }
  const f2 = await get<Facts>(`/scopes/${SCOPE}/facts`);
  const perf = f2.claims.filter((c) => c.edge === "PERFORMED_BY" && c.supersededAt === null);
  expect(perf.every((c) => c.targetId.startsWith(`voc_${SCOPE.replace(/^fsc_/, "")}_`))).toBe(true);
  await shot("04-stems");
  await rec("4 스템", "곡 › 스템 › + 스템 추가", `원곡 파트마다 1(${parts.length}) + 추가 녹음 ${EXTRAS.length}(슬롯·파트·부른 멤버)`, `스템 ${f2.stems.length}개, 실연 주장 ${perf.length}건 — 모두 이 곡 보이스(voc_${SCOPE.slice(4)}_<멤버>)`);

  // 5. 오디오 검사: 끌어 놓은 사인파 WAV → READY
  const audio = await poll("stem audio READY", () => get<{ stemId: string; status: string }[]>(`/scopes/${SCOPE}/stem-audio`), (xs) => xs.some((x) => x.status === "READY" || x.status === "QC_FAILED"), 60_000);
  const a0 = audio.find((x) => x.status === "READY" || x.status === "QC_FAILED")!;
  expect(a0.status).toBe("READY");
  await rec("5 스템 오디오", "스템 추가 칸 › 오디오 파일 끌어 놓기", "48kHz 16비트 사인파 WAV(8초 = Intro 길이) 놓기", `${a0.stemId} 검사 ${a0.status}`);

  // 6. 멤버(실연자 앱과 같은 API): 확인 요청 확인 · 팬앱 이용 동의
  let confirmed = 0;
  for (const m of MEMBERS) {
    const open = (await performer<{ requestId: number; status: string; factsScopeId: string }[]>(m, "GET", "/confirmations")).filter((r) => r.status === "OPEN" && r.factsScopeId === SCOPE);
    for (const r of open) { await performer(m, "POST", `/confirmations/${r.requestId}/confirm`, {}); confirmed++; }
    const v = (await performer<{ voiceId: string; factsScopeId: string }[]>(m, "GET", "/voices")).find((x) => x.factsScopeId === SCOPE)!;
    await performer(m, "POST", "/consents", { consentId: `cst_${v.voiceId}`, factsScopeId: SCOPE, assetId: v.voiceId,
      scope: { actions: ["PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] } });
  }
  // 막힌 곳 8: ①~④가 끝나기 전에는 컴파일 버튼이 꺼지고 이유가 보인다.
  await page.goto(`/portal/works/${WID}/policy`);
  await expect(page.getByRole("button", { name: "컴파일(IR 생성) → 승인으로" })).toBeDisabled();
  await expect(page.getByRole("status", { name: "컴파일할 수 없는 이유" })).toHaveText("③ 권리 확정이 끝나지 않았다 — 곡 진행 ①~④가 끝나야 컴파일한다");
  await shot("06-compile-blocked");
  await page.goto(`/portal/works/${WID}/contracts`);
  await rec("6 멤버 확인·이용 동의", "실연자 앱(멤버 7명)", "확인 요청 모두 확인 · 팬앱 이용 동의", `확인 ${confirmed}건, 동의 7건. 곡 진행: ${await band()}`, "실연자 앱과 같은 API(허용 예외)");

  // 7. 문서·계약 › + 계약 만들기: 녹음 이용허락 · 작품 이용허락 ×7 · 수령 위임 ×7 · 작가용 권리 확인서
  const panel = page.getByRole("complementary", { name: "계약 만들기" });
  const newContract = async (tpl: string, fill: () => Promise<void>) => {
    await page.getByRole("button", { name: "+ 계약 만들기" }).click();
    await panel.getByLabel("계약 종류").selectOption(tpl);
    // 막힌 곳 7: 시작일 기본값은 오늘(시계)
    if (await panel.getByLabel("시작일").count()) await expect(panel.getByLabel("시작일")).toHaveValue((await get<{ now: string }>("/clock")).now.slice(0, 10));
    await fill();
    await panel.getByLabel("미리보기").waitFor();
    await panel.getByRole("button", { name: /서명 요청/ }).click();
    await expect(panel.getByRole("status")).toContainText(/서명 요청 .*보냈습니다/);
    await page.getByRole("button", { name: "+ 계약 만들기" }).click(); // 다시 누르면 닫힘
  };
  const usage = async () => { for (const l of USAGE) await panel.getByLabel(l, { exact: true }).check(); };
  await newContract("tpl_master_license", async () => {
    await panel.getByLabel("허락자(마스터 권리자)").selectOption("pty_bighit_label"); await panel.getByLabel("녹음").fill(REC); await usage();
    // 막힌 곳 7: 시작일이 오늘보다 늦으면 입력 칸 아래 안내
    const today = await panel.getByLabel("시작일").inputValue();
    await panel.getByLabel("시작일").fill(`${Number(today.slice(0, 4)) + 1}${today.slice(4)}`);
    await expect(panel.getByRole("alert")).toHaveText("시작일이 오늘보다 늦으면 지금은 유효한 동의가 아니다");
    await panel.getByLabel("시작일").fill(today);
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });
  for (const a of authorIds) await newContract("tpl_work_license", async () => { await panel.getByLabel("허락자(작품 권리자)").selectOption(a); await usage(); });
  await newContract("tpl_performer_mandate", async () => {
    await panel.getByLabel("위임하는 실연자").selectOption("pending"); await panel.getByLabel("수령하는 소속사").selectOption("pty_bighit_agency"); await panel.getByLabel("위임 비율").fill("100");
  });
  // 막힌 곳 4: 작가용 권리 확인서 — 불러오기 없이 원곡 권리의 작가 지분 표로
  await newContract("tpl_claim_confirm_author", async () => {
    await expect(panel.getByRole("table", { name: "작가와 지분" }).getByRole("row")).toHaveCount(AUTHORS.length + 1);
    await usage();
  });
  const sent = await get<{ contractId: string; templateId: string; status: string }[]>(`/contracts?scope=${SCOPE}`);
  expect(sent.filter((c) => c.templateId === "tpl_work_license").map((c) => c.contractId).sort()).toEqual(authorIds.map((a) => `ctr_work_license_${SCOPE.slice(4)}_${a.slice(4)}`).sort());
  await shot("07-contracts-sent");
  await rec("7 계약 보내기", "곡 › 문서·계약 › + 계약 만들기", "녹음 이용허락 1 · 작품 이용허락 7(작가마다) · 수령 위임 7(멤버 7명 — 한 사람씩) · 작가용 권리 확인서 1(작가 지분 표 자동)",
    `서명 요청 ${sent.length}건(작품 이용허락 id: ctr_work_license_${SCOPE.slice(4)}_<작가>)`);

  // 8. 서명: 작가 전자서명(공급자 서명(개발)) · 멤버 수령 위임 서명(실연자 앱 API) · 빅히트 서명·반영(문서·계약 표)
  await page.goto("/portal/contracts");
  await expect(page.getByText("ctr_master_license_butter")).toBeVisible();
  let esign = 0;
  // 계정 없는 작가 서명 칸만(빅히트 쪽 서명은 문서·계약 표에서 한다).
  for (const [name] of AUTHORS) {
    const btn = page.getByRole("listitem").filter({ hasText: `${name} — 대기` }).getByRole("button", { name: "공급자 서명(개발)" });
    for (let n = await btn.count(); n > 0; n--) {
      await btn.first().click(); esign++;
      await expect(btn).toHaveCount(n - 1);
    }
  }
  await rec("8-1 작가 전자서명", "권리 › 표준 계약 › 공급자 서명(개발)", "작가 서명 칸마다(작품 이용허락 7 + 권리 확인서 7)", `전자서명 ${esign}건`, "개발 도구(허용 예외)");
  let mem = 0;
  for (const c of (await get<{ contractId: string; templateId: string; status: string; signatures: { partyId: string; signedAt?: string }[] }[]>(`/contracts?scope=${SCOPE}`)).filter((x) => x.templateId === "tpl_performer_mandate")) {
    const who = c.signatures.find((s) => MEMBERS.includes(s.partyId.slice(4)) && !s.signedAt);
    if (who) { await performer(who.partyId.slice(4), "POST", `/contracts/${c.contractId}/sign`, {}); mem++; }
  }
  await rec("8-2 멤버 수령 위임 서명", "실연자 앱 › 계약", "수령 위임계약 서명", `서명 ${mem}건`, "실연자 앱과 같은 API(허용 예외)");
  await page.goto(`/portal/works/${WID}/contracts`);
  await expect(page.getByRole("button", { name: /^(소속사 서명|레이블 서명|서명|반영)$/ }).first()).toBeVisible();
  for (let k = 0, idle = 0; k < 80 && idle < 3; k++) {
    const b = page.getByRole("button", { name: /^(소속사 서명|레이블 서명|서명|반영)$/ }).first();
    if (await b.count()) { idle = 0; await b.click(); await page.waitForTimeout(800); continue; }
    const exp = page.getByRole("button", { name: "펼치기" }).first();
    if (await exp.count()) { idle = 0; await exp.click(); await page.waitForTimeout(300); continue; }
    idle++; await page.waitForTimeout(1000); // 표를 다시 읽는 중일 수 있다
  }
  const done = await get<{ status: string }[]>(`/contracts?scope=${SCOPE}`);
  expect(done.every((c) => c.status === "COMPLETED")).toBe(true);
  await expect(page.getByRole("status", { name: "곡 진행" })).toContainText("4 / 4종");
  await shot("08-contracts-done");
  await rec("8-3 빅히트 서명·반영", "곡 › 문서·계약 ③④ 표", "펼치기 → 소속사·레이블 서명 → 반영", `반영 ${done.length}/${done.length}. 곡 진행: ${await band()}`);

  // 9. 작가 지급 정보: 내 조직 › 당사자 › 행 → 지급 계좌·세금 → 저장
  await page.goto("/portal/");
  const partiesTable = page.getByRole("table", { name: "관리 당사자" });
  /** 표는 10행씩 쪽을 나눈다 — 그 작가가 있는 쪽으로 넘긴다. */
  const rowOf = async (name: string) => {
    const r = partiesTable.getByRole("row", { name: new RegExp(name.replace(/[()]/g, "\\$&")) });
    await expect(partiesTable.getByRole("row").nth(1)).toBeVisible();
    for (let k = 0; k < 3 && await r.count() === 0; k++) {
      const card = page.locator("section").filter({ has: partiesTable }); // 관리 당사자 표의 쪽 넘기기(실연자 표에도 있다)
      const next = card.getByRole("button", { name: "다음 쪽" });
      await (await next.isEnabled() ? next : card.getByRole("button", { name: "1", exact: true })).click();
    }
    return r;
  };
  for (const [i, [name, cls]] of AUTHORS.entries()) {
    await (await rowOf(name)).click();
    const d = page.getByRole("complementary", { name: "당사자 상세 · 지급 정보" });
    await expect(d).toContainText(/Butter · 작가 지분 14\.\d+%/);
    await d.getByLabel("지급 계좌").fill(`Chase 0000-1111-${2000 + i}`);
    await d.getByLabel("세금").selectOption(cls === "FOREIGN_INDIVIDUAL" ? "FOREIGN" : "DOMESTIC_INDIVIDUAL");
    await d.getByRole("button", { name: "저장" }).click();
    await expect(await rowOf(name)).toContainText("등록됨");
    await d.getByRole("button", { name: "닫기" }).click();
  }
  // 실연자 · 본인 관리(PT2·PT5): 멤버 7명이 두 곡 참여·확인·동의 완료·소속사 수령으로 조회만 된다(행을 눌러도 칸이 열리지 않음).
  const perfTable = page.getByRole("table", { name: "실연자 · 본인 관리" });
  await expect(perfTable.getByRole("row")).toHaveCount(MEMBERS.length + 1);
  await expect(perfTable.getByRole("row", { name: /정국/ })).toContainText("Dynamite · Butter");
  await expect(perfTable.getByRole("row", { name: /정국/ })).toContainText("확인·동의 완료");
  await expect(perfTable.getByRole("row", { name: /정국/ })).toContainText("빅히트 뮤직 매니지먼트");
  await perfTable.getByRole("row", { name: /정국/ }).click();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await shot("09-payout");
  await rec("9 작가 지급 정보", "운영 관리 › 조직 › 내 조직 › 당사자 › 행", "지급 계좌(끝 4자만 보관)·세금 → 저장 ×7", "작가 7명 '등록됨'");

  // 10. 분배 규칙·팩 → 컴파일 → 승인 → 활성화 → 출시(같은 사람 usr_admin, 직무 분리 꺼짐 RD6)
  await page.goto(`/portal/works/${WID}/policy`);
  await page.getByRole("button", { name: "팩 만들기" }).click();
  await expect(page.getByText("팩을 만들고 청구권자를 원곡 권리대로 선언했습니다")).toBeVisible();
  await page.getByRole("button", { name: "표준 템플릿으로" }).click();
  await expect(page.getByRole("button", { name: "컴파일(IR 생성) → 승인으로" })).toBeEnabled(); // 막힌 곳 8: ①~④가 끝나 켜진다
  await page.getByRole("button", { name: "컴파일(IR 생성) → 승인으로" }).click();
  await page.getByRole("alertdialog", { name: "컴파일 확인" }).getByRole("button", { name: "컴파일" }).click();
  await expect(page).toHaveURL(new RegExp(`/works/${WID}/release`));
  await rec("10-1 팩·컴파일", "곡 › 분배 규칙·팩", "팩 만들기 → 표준 템플릿으로 → 컴파일(IR 생성) → 확인", `IR v1. 곡 진행: ${await band()}`);
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await page.getByRole("button", { name: "활성화", exact: true }).click();
  await page.getByRole("button", { name: "출시(팩 활성화)" }).click();
  await expect(page.getByRole("button", { name: "출시됨" })).toBeVisible();
  const ov2 = await get<{ workId: string; status: string }[]>("/works/overview");
  expect(ov2.find((x) => x.workId === WID)!.status).toBe("판매 중");
  await shot("10-release");
  await rec("10-2 승인·활성화·출시", "곡 › 승인·출시", "승인 → 활성화 → 출시(팩 활성화) — 모두 usr_admin", `작품 상태 ${ov2.find((x) => x.workId === WID)!.status}. 곡 진행: ${await band()}`);

  // 11. 팬앱에서 원곡 배치 조합 발행(판매 확인)
  const f3 = await get<Facts>(`/scopes/${SCOPE}/facts`);
  const packs = await get<{ items: { packId: string; factsScopeId: string }[] }>("/packs?limit=200");
  const assignments = f3.slots.flatMap((s) => s.parts.map((p) => ({ slotId: s.slotId, partNo: p.partNo,
    stemId: f3.stems.find((x) => x.slotId === s.slotId && x.partNo === p.partNo && (p.kind !== "VOCAL" || x.performerPartyId === p.originalPartyId))!.stemId })));
  const r = await request.fetch(`${BACKEND}/fan/combinations`, { method: "POST", headers: { "x-actor": "usr_fan_f1", "content-type": "application/json", "x-dbp-csrf": "1" },
    data: { packId: packs.items.find((x) => x.factsScopeId === SCOPE)!.packId, vcId: `vc_${SCOPE.slice(4)}_orig`, assignments } });
  expect(r.status(), await r.text()).toBe(201);
  await rec("11 팬앱 조합 발행", "팬앱", "원곡 배치 조합 발행", `${r.status()} — 판매 중 확인`, "팬앱과 같은 API(확인용)");
  expect(failed.filter((x) => !x.includes("/clock"))).toEqual([]);
});

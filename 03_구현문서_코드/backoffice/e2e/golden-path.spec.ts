import type { Locator, Page } from "@playwright/test";
import { advance, api, as, expect, ok, poll, resetAll, test } from "./fixtures.ts";

/**
 * 정상 경로 11단계(통합 설계 12.2-8). 모든 조작은 화면으로 하고, api는 비동기 상태를 기다리거나 값을 단언할 때만 쓴다.
 * 화면 사이 이동은 page.goto(전체 새로 읽기)로 해서 TanStack Query 캐시의 이전 값(폼 기본 시각 등)에 기대지 않는다.
 *
 * 금액: 구매 10,000·20,000·30,000·70,000원(마지막은 FLAGGED), 배치 전 부분 환불 5,000원(두 번째 구매), 확정 뒤 전액 환불(첫 구매).
 * 브리프의 50,000원으로는 pty_label(실패 지정) 말고 최소 지급액 10,000원을 넘는 권리자가 없어 PAID가 생기지 않으므로 70,000원으로 올렸다
 * (순매출 115,000원 → pty_label 32,200원, 멤버 b·c 1만 원 이상 → PAID, 나머지 미만 → CARRIED).
 */

const POLICY = "pol_nova_summer";
const PACK = "pak_nova_summer";
const SLOTS = ["slt_1", "slt_2", "slt_3", "slt_4"] as const;
/** 조합 3개: 각 슬롯을 부르는 멤버(a·b·c가 섞이게). */
const PICKS = [["a", "b", "c", "a"], ["b", "b", "c", "c"], ["c", "a", "b", "a"]] as const;
const PURCHASES = [
  { id: "ev_gp_1", combo: 0, amount: "10000", flagged: false },
  { id: "ev_gp_2", combo: 1, amount: "20000", flagged: false },
  { id: "ev_gp_3", combo: 2, amount: "30000", flagged: false },
  { id: "ev_gp_4", combo: 0, amount: "70000", flagged: true },
] as const;
const MIN_PAYOUT = 10_000n;

type Paged<T> = { items: T[]; next: string | null };
type InstructionView = { instructionId: string; partyId: string; status: string; gross: bigint };

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const bodyRows = (scope: Locator) => scope.locator("tbody > tr");
const digits = (s: string) => BigInt(s.replace(/[^\d]/g, "") || "0");
/** formatKrw와 같은 표시(음수는 U+2212). */
const krw = (n: bigint) => `${n < 0n ? "−" : ""}${(n < 0n ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;

/** 헤더 "지정…"으로 가상 시계를 맞추고 헤더 표시가 바뀔 때까지 기다린다. */
async function setClock(page: Page, local: string): Promise<void> {
  await page.getByRole("button", { name: "지정…", exact: true }).click();
  await page.getByLabel("지정 시각(UTC)").fill(local.slice(0, 16)); // 초가 0이면 브라우저가 "HH:mm"으로 정규화한다
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(page.getByTestId("clock-now")).toContainText(local.slice(0, 10));
}

/** 지급 run 상세의 지시 표를 읽는다. */
async function readInstructions(page: Page): Promise<InstructionView[]> {
  const rows = bodyRows(region(page, "지시 표"));
  const out: InstructionView[] = [];
  for (let i = 0; i < await rows.count(); i++) {
    const cells = rows.nth(i).locator("td");
    out.push({
      instructionId: (await cells.nth(0).innerText()).trim(),
      partyId: (await cells.nth(1).innerText()).trim(),
      status: (await cells.nth(2).innerText()).trim(),
      gross: digits(await cells.nth(4).innerText()),
    });
  }
  return out;
}

test.afterEach(async ({ request }) => {
  await api(request, null, "POST", "/dev/jobs/resume", { name: "poll-payout" }).catch(() => undefined);
});

test("정상 경로 11단계 — 모든 조작을 화면으로", async ({ page, request }) => {
  test.setTimeout(420_000);
  await resetAll(request);
  // poll-payout(개발 서버 지연 60초)이 webhook보다 먼저 PAID로 만들지 않도록 멈춘다(SUBMITTED → PAID는 webhook으로만).
  await ok(request, null, "POST", "/dev/jobs/pause", { name: "poll-payout" });
  const observed: Record<string, unknown> = {};

  await test.step("1. 개발 데이터: 합성 곡 불러오기 → 당사자 8명", async () => {
    await page.goto("/dev/data");
    await page.getByRole("button", { name: "합성 곡 불러오기", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "불러왔습니다" })).toContainText(PACK);
    await page.goto("/registry/parties");
    await expect(bodyRows(region(page, "당사자 목록"))).toHaveCount(8);
  });

  await test.step("2. 정책: 불러오기 → 컴파일(COMPILED) → 승인(APPROVED) → 활성화(ACTIVE)", async () => {
    await page.goto(`/policy/${POLICY}`);
    await as(page, "usr_editor");
    await page.getByRole("button", { name: "합성 곡 정책 불러오기", exact: true }).click();
    await expect(page.getByLabel("팩 id", { exact: true })).toHaveValue(PACK);
    await expect(page.getByLabel("정책 원문(VCRL)")).toHaveValue(/allocation "pol_nova_summer"/);
    await page.getByRole("button", { name: "컴파일", exact: true }).click();
    const versions = region(page, "버전");
    // 컴파일 직후 상태는 COMPILED(policy/service.ts compilePolicy).
    await expect(versions.locator("li.ver").first().locator(".badge")).toHaveText("COMPILED");

    await as(page, "usr_approver");
    await page.getByRole("button", { name: `${POLICY} 버전 1 승인`, exact: true }).click();
    await expect(versions.locator("li.ver").first().locator(".badge")).toHaveText("APPROVED");

    await as(page, "usr_activator");
    await page.getByRole("button", { name: `${POLICY} 버전 1 활성화`, exact: true }).click();
    await expect(versions.locator("li.ver").first().locator(".badge")).toHaveText("ACTIVE");
  });

  await test.step("3. 팩 활성화(usr_activator) → ACTIVE", async () => {
    await page.goto(`/packs/${PACK}`);
    await as(page, "usr_activator");
    const head = region(page, `팩 ${PACK}`);
    await expect(head).toContainText(`${POLICY}@1`);
    await page.getByRole("button", { name: "팩 활성화", exact: true }).click();
    await expect(head.locator("dd .badge")).toHaveText("ACTIVE");
  });

  await test.step("4. 발행(usr_issuer): 멤버가 섞인 조합 3개 → 발행 목록 3행, 첫 발행 digest", async () => {
    await page.goto(`/packs/${PACK}`);
    await as(page, "usr_issuer");
    const issued = bodyRows(region(page, "발행 목록"));
    await expect(region(page, "발행 목록")).toContainText("발행이 없습니다.");
    for (const [n, pick] of PICKS.entries()) {
      for (const [k, slot] of SLOTS.entries()) await page.getByLabel(`${slot} 스템`).selectOption(`stm_${pick[k]}_${slot}`);
      await page.getByLabel("slt_mr 스템").selectOption("stm_mr");
      await expect(page.getByRole("status").filter({ hasText: "합계" })).toHaveText("합계 10000 / 10000");
      await page.getByRole("button", { name: "발행", exact: true }).click();
      await expect(issued).toHaveCount(n + 1);
    }
    observed.issues = await issued.count();
    // 첫 발행 상세: 봉인 묶음의 digest(12자리 16진) 표시.
    await issued.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/issues\//);
    const seals = region(page, "봉인 묶음");
    await expect(seals.locator("code")).toHaveCount(4);
    for (const code of await seals.locator("code").all()) await expect(code).toHaveText(/^[0-9a-f]{12}$/);
    await expect(region(page, "재도출 대조").getByRole("status")).toContainText("일치");
  });

  /** 발행 폼의 기본 vcId 규칙(스템 요약: stm_a_slt_1 → a1, stm_mr → mr)으로 조합의 vcId를 만든다. */
  const vcOf = (combo: number) => `vc_${PICKS[combo]!.map((m, k) => `${m}${k + 1}`).join("")}mr`;

  await test.step("5. 시계 2026-02-10 → 구매 4건(1건 FLAGGED) + 배치 전 부분 환불", async () => {
    await page.goto("/revenue");
    await setClock(page, "2026-02-10T00:00:00");
    await page.goto("/revenue"); // 폼 기본 시각을 새 시계로 다시 읽는다
    await page.getByRole("button", { name: "sys_ingest로 전환", exact: true }).click();
    await expect(page.getByLabel("발생 시각(UTC)")).toHaveValue(/^2026-02-10T/);
    for (const p of PURCHASES) {
      await page.getByLabel("eventId", { exact: true }).fill(p.id);
      await page.getByLabel("조합(vcId)").selectOption(vcOf(p.combo));
      await page.getByLabel("구매 금액(원)").fill(p.amount);
      await page.getByLabel("무결성").selectOption(p.flagged ? "FLAGGED" : "CLEAR");
      await page.getByRole("button", { name: "구매 기록", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: p.id })).toContainText("기록했습니다");
    }
    await page.getByRole("tab", { name: "환불", exact: true }).click();
    await page.getByLabel("환불 eventId").fill("ev_gp_rf1");
    await page.getByLabel("원 이벤트").selectOption(PURCHASES[1].id);
    await page.getByLabel("환불 금액(원)").fill("5000");
    await page.getByRole("button", { name: "환불 기록", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "ev_gp_rf1" })).toContainText("기록했습니다");
    const list = region(page, "매출 이벤트 목록");
    await expect(bodyRows(list)).toHaveCount(5);
    await expect(list.getByText("FLAGGED", { exact: true })).toHaveCount(1);
  });

  const batchId = "bat_gp_1";
  await test.step("6. 시계 2026-03-02 → 배치(usr_ops) → run 모두 VERIFIED → 확정(usr_settle) → 분개 수 = run 수", async () => {
    await page.goto("/settlement/batches");
    await setClock(page, "2026-03-02T00:00:00");
    await as(page, "usr_ops");
    await page.getByLabel("배치 id").fill(batchId);
    await page.getByLabel("기간 시작(UTC)").fill("2026-02-01T00:00");
    await page.getByLabel("기간 끝(UTC)").fill("2026-03-01T00:00");
    await page.getByRole("button", { name: "배치 만들기", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "배치를 만들었습니다" })).toContainText(batchId);
    await region(page, "배치 목록").getByRole("link", { name: batchId, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/settlement/batches/${batchId}$`));

    // 화면 자동 갱신(3초)으로 run이 모두 VERIFIED가 될 때까지.
    const runs = bodyRows(region(page, "run 목록"));
    await expect.poll(async () => {
      const n = await runs.count();
      const verified = await runs.filter({ has: page.locator(".badge", { hasText: /^VERIFIED$/ }) }).count();
      return n > 0 && n === verified ? n : -1;
    }, { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(0);
    const runCount = await runs.count();
    observed.runs = runCount;

    await as(page, "usr_settle");
    await page.getByRole("button", { name: "확정", exact: true }).click();
    const confirm = region(page, "배치 확정");
    await expect(confirm.getByRole("status").filter({ hasText: "원장 반영" })).toHaveText(`원장 반영: ${runCount} / ${runCount} run (완료)`, { timeout: 60_000 });
    await expect(region(page, `배치 ${batchId}`).locator("dd .badge").first()).toHaveText("CONFIRMED");

    await page.goto("/ledger");
    await page.getByLabel("종류 필터").selectOption("SETTLEMENT");
    await expect(bodyRows(region(page, "분개 목록"))).toHaveCount(runCount);
    observed.settlementEntries = runCount;
  });

  await test.step("7. 확정 뒤 전액 환불 → 원장 REVERSAL 1건, 매출 행 펼침에 역분개", async () => {
    await page.goto("/revenue");
    await page.getByRole("button", { name: "sys_ingest로 전환", exact: true }).click();
    await page.getByRole("tab", { name: "환불", exact: true }).click();
    await page.getByLabel("환불 eventId").fill("ev_gp_rf2");
    await page.getByLabel("원 이벤트").selectOption(PURCHASES[0].id);
    await expect(page.getByLabel("환불 금액(원)")).toHaveValue(PURCHASES[0].amount); // 기본값 = 남은 순액(전액)
    await page.getByRole("button", { name: "환불 기록", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "ev_gp_rf2" })).toContainText("기록했습니다");

    await poll("REVERSAL 분개", async () => (await ok<Paged<unknown>>(request, "usr_settle", "GET", "/ledger/entries?kind=REVERSAL&limit=200")).items.length, (n) => n >= 1, 60_000);
    await page.goto("/ledger");
    await as(page, "usr_settle");
    await page.getByLabel("종류 필터").selectOption("REVERSAL");
    await expect(bodyRows(region(page, "분개 목록"))).toHaveCount(1);

    await page.goto("/revenue");
    await as(page, "usr_ops"); // 정산 상태 조회는 정산 운영/담당 사용자
    await page.getByRole("button", { name: `${PURCHASES[0].id} 정산 펼치기`, exact: true }).click();
    const list = region(page, "매출 이벤트 목록");
    // 펼친 행 안의 역분개 표(중첩 표)에 정확히 1행.
    const reversals = list.locator("table table").filter({ has: page.getByRole("columnheader", { name: "역분개", exact: true }) });
    await expect(reversals).toHaveCount(1);
    await expect(bodyRows(reversals)).toHaveCount(1);
    await expect(list.getByText("역분개가 없습니다.")).toHaveCount(0);
  });

  await test.step("8. FRAUD_REVIEW 보류: 제안대로 해제 → 해제됨, 시산표 합 0", async () => {
    await page.goto("/settlement/holds");
    await as(page, "usr_settle");
    const holds = region(page, "보류 목록");
    const row = bodyRows(holds).filter({ hasText: "FRAUD_REVIEW" });
    await expect(row).toHaveCount(1);
    const open = row.getByRole("button", { name: /^보류\[\d+\] 제안 보기$/ });
    const id = /^보류\[(\d+)\]/.exec((await open.getAttribute("aria-label")) ?? "")![1]!;
    await open.click();
    await expect(holds.getByRole("status").filter({ hasText: "배분 합계" })).toContainText("— 일치");
    await page.getByRole("button", { name: `보류[${id}] 배분 해제`, exact: true }).click();
    await expect(row).toContainText("해제됨");
    await expect(row.locator(".badge")).toHaveText("RELEASED");

    await page.goto("/ledger");
    await expect(region(page, "시산표").getByRole("status")).toContainText("합계 0 확인됨");
  });

  const parties: string[] = [];
  await test.step("9. 지급 프로필(usr_settle2): 미지급금 권리자 전원 등록 → 냉각 표시 → +30일 → 냉각 끝남", async () => {
    await page.goto("/payout/profiles");
    await as(page, "usr_settle2");
    const table = region(page, "권리자별 프로필");
    const edits = table.getByRole("button", { name: /^권리자\[.+\] 프로필 편집$/ });
    await expect(edits.first()).toBeVisible();
    for (const b of await edits.all()) parties.push(/^권리자\[(.+)\] 프로필 편집$/.exec((await b.getAttribute("aria-label")) ?? "")![1]!);
    expect(parties.length).toBeGreaterThan(1);
    observed.payableParties = parties.length;
    const rowOf = (p: string) => table.getByRole("row").filter({ has: page.getByRole("cell", { name: p, exact: true }) });

    for (const p of parties) {
      await page.getByRole("button", { name: `권리자[${p}] 프로필 편집`, exact: true }).click();
      await page.getByLabel(`권리자[${p}] 세금 유형`).selectOption("DOMESTIC_INDIVIDUAL");
      await page.getByLabel(`권리자[${p}] 계좌 토큰 입력`).fill(`acct_${p}`);
      await page.getByLabel(`권리자[${p}] KYC 확인`).check();
      await page.getByRole("button", { name: `권리자[${p}] 프로필 저장`, exact: true }).click();
      await expect(page.getByRole("button", { name: `권리자[${p}] 프로필 저장`, exact: true })).toHaveCount(0);
      await expect(rowOf(p)).toContainText(`acct_${p}`);
      await expect(rowOf(p)).toContainText("냉각 중");
    }

    await advance(page, "+30일");
    for (const p of parties) {
      await expect(rowOf(p)).toContainText("냉각 끝남");
      await expect(rowOf(p)).not.toContainText("냉각 중");
    }
  });

  let instructions: InstructionView[] = [];
  await test.step("10. PSP: pty_label FAILED 지정 → 지급 실행 → FAILED·SUBMITTED·CARRIED → webhook → PAID, 실패분 잔액 복원", async () => {
    await page.goto("/dev/psp");
    await as(page, "usr_settle");
    await page.getByLabel("권리자[pty_label] PSP 결과").selectOption("FAILED");
    await expect(page.getByLabel("권리자[pty_label] PSP 결과")).toHaveValue("FAILED");
    await poll("pty_label FAILED 지정", async () => (await ok<{ byParty: Record<string, string> }>(request, null, "GET", "/dev/psp/outcomes")).byParty.pty_label, (v) => v === "FAILED");

    await page.goto("/payout/runs");
    await as(page, "usr_settle");
    await page.getByRole("button", { name: "지급 run 만들기", exact: true }).click();
    const made = page.getByRole("status").filter({ hasText: "지급 run을 만들었습니다" });
    await made.getByRole("link").click();
    await expect(page).toHaveURL(/\/payout\/runs\/pr-/);

    // 지시 표 자동 갱신(열린 지시가 있으면 3초): PENDING이 모두 전송될 때까지.
    await expect.poll(async () => {
      const xs = await readInstructions(page);
      return xs.length === parties.length && xs.every((x) => x.status !== "PENDING") ? "ready" : JSON.stringify(xs.map((x) => x.status));
    }, { timeout: 60_000, intervals: [1000] }).toBe("ready");
    instructions = await readInstructions(page);
    for (const x of instructions) {
      if (x.partyId === "pty_label") expect(x.status, "pty_label").toBe("FAILED");
      else if (x.gross >= MIN_PAYOUT) expect(x.status, `${x.partyId} ${x.gross}`).toBe("SUBMITTED");
      else expect(x.status, `${x.partyId} ${x.gross}`).toBe("CARRIED");
    }
    const submitted = instructions.filter((x) => x.status === "SUBMITTED");
    expect(submitted.length, "최소 지급액 이상 권리자(pty_label 제외)").toBeGreaterThanOrEqual(1);
    expect(instructions.filter((x) => x.status === "CARRIED").length).toBeGreaterThanOrEqual(1);
    const runUrl = page.url();

    // SUBMITTED 지시마다 /dev/psp에서 webhook 1회(지시 상세의 "이 지시의 PSP 결과 지정" 링크로 간다).
    for (const x of submitted) {
      await page.getByRole("link", { name: `지시[${x.instructionId}] 상세`, exact: true }).click();
      await page.getByRole("link", { name: `지시[${x.instructionId}] PSP 결과`, exact: true }).click();
      await expect(page).toHaveURL(/\/dev\/psp\?instruction=/);
      const focused = region(page, "지정한 지시");
      await expect(focused.getByLabel(`지시[${x.instructionId}] webhook 반복`)).toHaveValue("1");
      await focused.getByRole("button", { name: `지시[${x.instructionId}] webhook 보내기`, exact: true }).click();
      const res = focused.getByRole("table", { name: `지시[${x.instructionId}] webhook 응답` });
      await expect(bodyRows(res)).toHaveCount(1);
      // 처음 받은 webhook은 201(created), 같은 이벤트를 다시 받으면 200(payout/routes.ts).
      await expect(bodyRows(res).first().locator("td").nth(1)).toHaveText("201");
      await page.goto(runUrl);
    }

    await expect.poll(async () => {
      const xs = await readInstructions(page);
      return submitted.every((s) => xs.find((x) => x.instructionId === s.instructionId)?.status === "PAID") ? "paid" : JSON.stringify(xs.map((x) => `${x.partyId}:${x.status}`));
    }, { timeout: 60_000, intervals: [1000] }).toBe("paid");
    instructions = await readInstructions(page);
    const count = (s: string) => instructions.filter((x) => x.status === s).length;
    expect(count("PAID")).toBeGreaterThanOrEqual(1);
    expect(count("FAILED")).toBe(1);
    expect(count("CARRIED")).toBeGreaterThanOrEqual(1);
    observed.instructions = instructions.map((x) => ({ ...x, gross: x.gross.toString() }));

    // 실패한 지시의 금액이 pty_label 미지급금으로 복원(원장 화면: PARTY_PAYABLE 잔액 = −총액).
    const failed = instructions.find((x) => x.status === "FAILED")!;
    await page.goto("/ledger");
    const acct = region(page, "계정 표").getByRole("row").filter({ has: page.getByRole("cell", { name: "PARTY_PAYABLE:pty_label", exact: true }) });
    await expect(acct).toContainText(krw(-failed.gross));
    await page.getByLabel("종류 필터").selectOption("PAYOUT_FAILED");
    await expect(bodyRows(region(page, "분개 목록"))).toHaveCount(1);
  });

  await test.step("11. 명세서 대조(PAID·CARRIED 권리자) 초록, 점검 정상, 체크리스트 11단계 완료", async () => {
    const paid = instructions.find((x) => x.status === "PAID")!;
    const carried = instructions.find((x) => x.status === "CARRIED")!;
    await page.goto("/statements");
    await as(page, "usr_settle");
    const sec = region(page, "권리자 명세");
    const recon: Record<string, string[]> = {};
    for (const p of [paid.partyId, carried.partyId]) {
      await sec.getByLabel("권리자").selectOption(p);
      await expect(sec.locator("caption")).toContainText(`권리자 ${p}`);
      const verdicts = sec.getByRole("status").filter({ hasText: "대조" });
      await expect(verdicts).toHaveCount(2);
      await expect(verdicts.locator(".badge.ok")).toHaveCount(2);
      await expect(verdicts.locator(".badge")).toHaveText(["일치", "일치"]);
      recon[p] = await verdicts.allInnerTexts();
    }
    observed.statements = recon;

    await expect(page.getByTestId("invariants-badge")).toHaveText("점검 정상");

    await page.goto("/");
    const steps = page.getByRole("list", { name: "체크리스트 단계" }).locator("li > .badge");
    await expect(steps).toHaveCount(11);
    await expect(steps).toHaveText(Array.from({ length: 11 }, () => "완료"), { timeout: 30_000 });
    const entries = await api<Paged<{ kind: string }>>(request, "usr_settle", "GET", "/ledger/entries?limit=200");
    observed.entries = entries.body.items.length;
    observed.entryKinds = entries.body.items.map((e) => e.kind);
  });

  test.info().annotations.push({ type: "observed", description: JSON.stringify(observed) });
});

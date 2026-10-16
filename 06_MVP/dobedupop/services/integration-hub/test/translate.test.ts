import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCsvLine, translate } from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("CSV cells: quotes, embedded commas and escaped quotes", () => {
  assert.deepEqual(splitCsvLine('a,"b,c","d ""e""",'), ["a", "b,c", 'd "e"', ""]);
  assert.equal(splitCsvLine('"open'), undefined);
});

test("distributor CSV: sales, refunds and stream revenue normalize; bad rows go to the reject list with a reason", () => {
  const csv = [
    "﻿transaction_id,type,asset_id,amount_krw,occurred_at,original_transaction_id,currency,units",
    "tx1,SALE,DBP0001,1200,2026-03-02,,KRW,",
    "tx2,REFUND,,1200,2026-03-05T10:00:00.000Z,tx1,,",
    'tx3,STREAM_REVENUE,DBP0002,"4,000",2026-03-31,,KRW,812',
    "tx4,STREAM_REVENUE,DBP0002,4000.00,2026-03-31,,KRW,812",
    "tx5,SALE,DBP0001,1200,2026-03-02,,USD,",
    "tx6,GIFT,DBP0001,1200,2026-03-02,,,",
    "tx1,SALE,DBP0001,1200,2026-03-02,,KRW,",
    "tx7,SALE,DBP0001,1200,31/03/2026,,KRW,",
    "",
  ].join("\r\n");
  const t = translate("DISTRIBUTOR_CSV", enc(csv));
  assert.deepEqual(t.fileErrors, []);
  const ok = t.lines.flatMap((l) => ("record" in l ? [l.record] : []));
  assert.deepEqual(ok, [
    { kind: "SALE", externalId: "tx1", assetId: "DBP0001", amountKrw: "1200", occurredAt: "2026-03-02T00:00:00.000Z" },
    { kind: "REFUND", externalId: "tx2", originalExternalId: "tx1", amountKrw: "1200", occurredAt: "2026-03-05T10:00:00.000Z" },
    { kind: "STREAM_REVENUE", externalId: "tx4", assetId: "DBP0002", amountKrw: "4000", occurredAt: "2026-03-31T00:00:00.000Z", units: 812 },
  ]);
  const rejects = t.lines.flatMap((l) => ("reject" in l ? [[l.line, l.reject.code]] : []));
  assert.deepEqual(rejects, [[4, "INVALID_AMOUNT"], [6, "UNSUPPORTED_CURRENCY"], [7, "UNSUPPORTED_TYPE"], [8, "DUPLICATE_IN_FILE"], [9, "INVALID_DATE"]]);
});

test("distributor CSV without the required columns is rejected as a whole", () => {
  const t = translate("DISTRIBUTOR_CSV", enc("id,amount\n1,2\n"));
  assert.equal(t.fileErrors[0]!.code, "MISSING_COLUMNS");
  assert.deepEqual(t.lines, []);
});

const dsr = (foot: number) => [
  "HEAD\tflat-dsr/1.0\tDPID_PARTNER\t2026-03-01\t2026-03-31",
  "SY02\tsummary rows are skipped",
  "SU01\tS-1\tKRDBP2600001\tPermanentDownload\t1\t1200\tKRW\t2026-03-03",
  "SU01\tS-2\tKRDBP2600002\tOnDemandStream\t812\t4000\tKRW\t2026-03-31",
  "SU01\tS-3\tKRDBP2600002\tRingbackTone\t1\t500\tKRW\t2026-03-31",
  `FOOT\t${foot}`,
].join("\n");

test("DDEX DSR subset: SU01 sales and streams normalize, unknown use types are rejected, other records are skipped", () => {
  const t = translate("DDEX_DSR", enc(dsr(3)));
  assert.deepEqual(t.fileErrors, []);
  assert.deepEqual(t.lines.map((l) => ("record" in l ? l.record.kind : l.reject.code)), ["SALE", "STREAM_REVENUE", "UNSUPPORTED_USE_TYPE"]);
  assert.deepEqual(t.lines[1], { line: 4, raw: dsr(3).split("\n")[3], record: { kind: "STREAM_REVENUE", externalId: "S-2", assetId: "KRDBP2600002", amountKrw: "4000", occurredAt: "2026-03-31T00:00:00.000Z", units: 812 } });
});

test("DDEX DSR whose FOOT count disagrees (truncated) or that lacks HEAD is rejected as a whole", () => {
  assert.deepEqual(translate("DDEX_DSR", enc(dsr(4))).fileErrors.map((e) => e.code), ["COUNT_MISMATCH"]);
  assert.deepEqual(translate("DDEX_DSR", enc(dsr(4))).lines, []);
  assert.deepEqual(translate("DDEX_DSR", enc("SU01\tS-1\tX\tPermanentDownload\t1\t1\tKRW\t2026-03-03")).fileErrors.map((e) => e.code), ["MISSING_HEAD", "MISSING_FOOT"]);
});

test("non-UTF-8 bytes are rejected before parsing", () => {
  assert.equal(translate("DISTRIBUTOR_CSV", new Uint8Array([0xff, 0xfe, 0x00])).fileErrors[0]!.code, "NOT_UTF8");
});

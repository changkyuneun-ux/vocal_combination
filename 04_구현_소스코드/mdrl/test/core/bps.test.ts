import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBps, parseBps, percentToBps } from "../../src/core/bps.ts";
import { MdrlError } from "../../src/core/errors.ts";

test("parseBps accepts integer strings 0..10000", () => {
  assert.equal(parseBps("0"), 0);
  assert.equal(parseBps("4500"), 4500);
  assert.equal(parseBps("10000"), 10000);
  for (const bad of ["10001", "-1", "01", "4.5", "", 4500]) assert.throws(() => parseBps(bad), MdrlError, String(bad));
});

test("formatBps rejects out of range", () => {
  assert.equal(formatBps(1250), "1250");
  assert.throws(() => formatBps(10001), MdrlError);
  assert.throws(() => formatBps(1.5), MdrlError);
});

test("percentToBps converts with at most two decimals", () => {
  assert.equal(percentToBps("12.5"), 1250);
  assert.equal(percentToBps("40"), 4000);
  assert.equal(percentToBps("0.01"), 1);
  assert.equal(percentToBps("100"), 10000);
  for (const bad of ["12.345", "100.01", "abc", "-5"]) assert.throws(() => percentToBps(bad), MdrlError, bad);
});

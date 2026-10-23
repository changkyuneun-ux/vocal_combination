import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorKey, encodeCursor, pageNoResult, pageOf, parsePage, parsePageNo } from "../../src/platform/paging.ts";
import { DomainError } from "../../src/platform/errors.ts";

const fails = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e) => e instanceof DomainError && e.status === 400 && e.code === code);

// 쪽 번호 방식(3부-A PG1): ?page=&size= — page가 없으면 null(커서 방식), size 기본 10·최대 100.
test("parsePageNo: absent page → null; defaults; bounds", () => {
  assert.equal(parsePageNo({}), null);
  assert.deepEqual(parsePageNo({ page: "1" }), { page: 1, size: 10, offset: 0 });
  assert.deepEqual(parsePageNo({ page: "3", size: "20" }), { page: 3, size: 20, offset: 40 });
  assert.deepEqual(parsePageNo({ page: "2", size: "100" }), { page: 2, size: 100, offset: 100 });
  for (const q of [{ page: "0" }, { page: "-1" }, { page: "x" }, { page: "1", size: "0" }, { page: "1", size: "101" }, { page: "1.5" }, { page: "" }, { page: ["1"] }]) {
    fails(() => parsePageNo(q as Record<string, unknown>), "BAD_REQUEST");
  }
});

test("pageNoResult: items, page, size, total", () => {
  assert.deepEqual(pageNoResult(["a", "b"], 12, { page: 2, size: 10, offset: 10 }), { items: ["a", "b"], page: 2, size: 10, total: 12 });
});

test("parsePage: default 50, 1..200 accepted, others 400 BAD_REQUEST", () => {
  assert.deepEqual(parsePage({}), { limit: 50, after: undefined });
  assert.equal(parsePage({ limit: "1" }).limit, 1);
  assert.equal(parsePage({ limit: "200" }).limit, 200);
  for (const bad of ["0", "201", "abc", "-1", "1.5", ""]) fails(() => parsePage({ limit: bad }), "BAD_REQUEST");
  fails(() => parsePage({ limit: ["1", "2"] }), "BAD_REQUEST");
});

test("parsePage: after must be base64url(JSON array) else 400 BAD_CURSOR", () => {
  assert.deepEqual(parsePage({ after: encodeCursor(["a", 1]) }).after, ["a", 1]);
  for (const bad of ["!!!", "bm90LWpzb24", encodeCursor([]), Buffer.from('{"a":1}').toString("base64url"), Buffer.from("5").toString("base64url"), ""]) {
    fails(() => parsePage({ after: bad }), "BAD_CURSOR");
  }
});

test("cursorKey: shape mismatch is BAD_CURSOR", () => {
  const p = parsePage({ after: encodeCursor(["2026-01-01T00:00:00.000Z", "x"]) });
  assert.deepEqual(cursorKey(p, ["t", "s"]), ["2026-01-01T00:00:00.000Z", "x"]);
  fails(() => cursorKey(p, ["s"]), "BAD_CURSOR");
  fails(() => cursorKey(p, ["n", "s"]), "BAD_CURSOR");
  fails(() => cursorKey(parsePage({ after: encodeCursor(["nope", "x"]) }), ["t", "s"]), "BAD_CURSOR");
  assert.equal(cursorKey(parsePage({}), ["s"]), undefined);
});

test("pageOf: 7 rows with limit 3 pages 3·3·1, last next is null, no gaps or duplicates", () => {
  const all = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `r${n}` }));
  const read = (page: ReturnType<typeof parsePage>) => {
    const start = page.after === undefined ? 0 : all.findIndex((r) => r.id === page.after![0]) + 1;
    return all.slice(start, start + page.limit + 1);
  };
  const seen: string[] = [];
  const sizes: number[] = [];
  let after: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = parsePage({ limit: "3", ...(after !== undefined && { after }) });
    const out = pageOf(read(page), page, (r) => [r.id]);
    sizes.push(out.items.length);
    seen.push(...out.items.map((r) => r.id));
    if (out.next === null) break;
    after = out.next;
  }
  assert.deepEqual(sizes, [3, 3, 1]);
  assert.deepEqual(seen, all.map((r) => r.id));
});

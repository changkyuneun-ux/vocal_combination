import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "../src/core/errors.ts";

/** 정상 입력으로 도달할 수 없는 방어용 코드와 그 이유. */
const UNREACHABLE: Readonly<Record<string, string>> = {
  ALLOC_ROUNDING_INVARIANT: "splitLrm의 층별 합 불변식 방어 — 가중치 합 1이 검증된 뒤에는 수학적으로 발생하지 않는다",
};

const root = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

test("every error code is asserted by at least one test or conformance case", () => {
  const text = [...files(join(root, "test")), ...files(join(root, "conformance"))]
    .filter((p) => p !== self)
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const missing = Object.keys(ERROR_CODES).filter((c) => !Object.hasOwn(UNREACHABLE, c) && !text.includes(`"${c}"`));
  assert.deepEqual(missing, []);
});

test("the unreachable list names only registered codes", () => {
  for (const c of Object.keys(UNREACHABLE)) assert.ok(Object.hasOwn(ERROR_CODES, c), c);
});

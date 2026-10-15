import { translateCsv } from "./csv.ts";
import { translateDsr } from "./ddex.ts";
import type { Format, Translation } from "./types.ts";

export * from "./types.ts";
export { translateCsv, splitCsvLine } from "./csv.ts";
export { translateDsr } from "./ddex.ts";

/** 외부 파일(UTF-8)을 형식에 맞게 정규화 레코드로 번역한다. 데이터베이스·코어 모델을 모른다(순수 함수). */
export function translate(format: Format, bytes: Uint8Array): Translation {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { format, lines: [], fileErrors: [{ code: "NOT_UTF8", message: "file must be UTF-8 text" }] };
  }
  return format === "DDEX_DSR" ? translateDsr(text) : translateCsv(text);
}

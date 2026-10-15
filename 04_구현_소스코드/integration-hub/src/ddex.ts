import type { Normalized, Rejection, TranslatedLine, Translation } from "./types.ts";
import { currency, instant, isRejection, krw, required } from "./values.ts";

/** 판매(소장)로 보는 DDEX 이용 유형. */
const SALE_USES = new Set(["PermanentDownload"]);
/** 감상(스트리밍)으로 보는 DDEX 이용 유형. */
const STREAM_USES = new Set(["OnDemandStream", "NonInteractiveStream", "Stream"]);

/**
 * DDEX DSR 평면 파일의 부분 집합(탭 구분). 이 플랫폼이 받는 판매·이용 행만 읽는다. 인증된 DSR 구현이 아니다.
 * - HEAD\t<메시지 버전>\t<보낸 파티 id>\t<기간 시작>\t<기간 끝>
 * - SU01\t<판매 거래 id>\t<리소스 id(조합에 부여한 ISRC 등)>\t<이용 유형>\t<수량>\t<순매출>\t<통화>\t<날짜>
 * - FOOT\t<SU01 행 수>
 * 다른 레코드 유형(SY·AS 등)은 건너뛴다. HEAD가 없거나 FOOT 건수가 다르면 파일 전체를 거부한다(잘린 파일).
 */
export function translateDsr(text: string): Translation {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/);
  const fileErrors: Rejection[] = [];
  const lines: TranslatedLine[] = [];
  let head = false;
  let footCount: number | undefined;
  let su = 0;
  const seen = new Set<string>();
  rows.forEach((raw, k) => {
    if (raw.trim() === "") return;
    const line = k + 1;
    const f = raw.split("\t");
    const type = f[0]!.trim();
    if (type === "HEAD") { head = true; return; }
    if (type === "FOOT") { footCount = Number(f[1]); return; }
    if (type !== "SU01") return;
    su++;
    const r = suRecord(f);
    if (isRejection(r)) { lines.push({ line, raw, reject: r }); return; }
    if (seen.has(r.externalId)) { lines.push({ line, raw, reject: { code: "DUPLICATE_IN_FILE", message: `transaction ${r.externalId} appears twice in this file` } }); return; }
    seen.add(r.externalId);
    lines.push({ line, raw, record: r });
  });
  if (!head) fileErrors.push({ code: "MISSING_HEAD", message: "DSR file must start with a HEAD record" });
  if (footCount === undefined) fileErrors.push({ code: "MISSING_FOOT", message: "DSR file must end with a FOOT record (truncated file?)" });
  else if (footCount !== su) fileErrors.push({ code: "COUNT_MISMATCH", message: `FOOT declares ${footCount} SU01 records, file has ${su}` });
  return { format: "DDEX_DSR", lines: fileErrors.length > 0 ? [] : lines, fileErrors };
}

function suRecord(f: string[]): Normalized | Rejection {
  if (f.length < 8) return { code: "MALFORMED_ROW", message: `SU01 needs 8 fields, got ${f.length}` };
  const externalId = required("SalesTransactionId", f[1]);
  if (isRejection(externalId)) return externalId;
  const assetId = required("ResourceId", f[2]);
  if (isRejection(assetId)) return assetId;
  const cur = currency(f[6]);
  if (cur !== undefined) return cur;
  const amountKrw = krw(f[5]);
  if (isRejection(amountKrw)) return amountKrw;
  const occurredAt = instant(f[7]);
  if (isRejection(occurredAt)) return occurredAt;
  const use = (f[3] ?? "").trim();
  if (SALE_USES.has(use)) return { kind: "SALE", externalId, assetId, amountKrw, occurredAt };
  if (STREAM_USES.has(use)) {
    const units = Number((f[4] ?? "").trim());
    return { kind: "STREAM_REVENUE", externalId, assetId, amountKrw, occurredAt, ...(Number.isSafeInteger(units) && units >= 0 && { units }) };
  }
  return { code: "UNSUPPORTED_USE_TYPE", message: `use type ${JSON.stringify(use)} is neither a sale nor a stream` };
}

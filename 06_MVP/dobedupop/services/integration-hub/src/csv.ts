import type { Normalized, Rejection, TranslatedLine, Translation } from "./types.ts";
import { currency, instant, isRejection, krw, required } from "./values.ts";

/** RFC 4180 한 줄 나누기: 큰따옴표로 감싼 칸, 칸 안의 쉼표와 "" 이스케이프. 줄바꿈이 든 칸은 받지 않는다. */
export function splitCsvLine(line: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    let cell = "";
    if (line[i] === '"') {
      i++;
      for (;;) {
        if (i >= line.length) return undefined;
        if (line[i] === '"') {
          if (line[i + 1] === '"') { cell += '"'; i += 2; continue; }
          i++;
          break;
        }
        cell += line[i++];
      }
      if (i < line.length && line[i] !== ",") return undefined;
    } else {
      while (i < line.length && line[i] !== ",") cell += line[i++];
    }
    out.push(cell);
    if (i >= line.length) return out;
    i++;
  }
}

const COLUMNS = ["transaction_id", "type", "asset_id", "amount_krw", "occurred_at"] as const;

/**
 * 유통사 판매·정산 리포트 CSV. 첫 줄은 머리글이고 열 순서는 자유다.
 * 필수 열: transaction_id, type(SALE | REFUND | STREAM_REVENUE), asset_id(SALE·STREAM_REVENUE), amount_krw, occurred_at.
 * 선택 열: original_transaction_id(REFUND 필수), currency(KRW만), units(STREAM_REVENUE의 재생 수, 참고용).
 */
export function translateCsv(text: string): Translation {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsvLine(rows[0] ?? "")?.map((h) => h.trim().toLowerCase());
  const missing = header === undefined ? [...COLUMNS] : COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) return { format: "DISTRIBUTOR_CSV", lines: [], fileErrors: [{ code: "MISSING_COLUMNS", message: `header lacks ${missing.join(", ")}` }] };
  const col = (cells: string[], name: string) => { const k = header!.indexOf(name); return k < 0 ? undefined : cells[k]; };
  const lines: TranslatedLine[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((raw, k) => {
    if (raw.trim() === "") return;
    const line = k + 2;
    const cells = splitCsvLine(raw);
    const reject = (r: Rejection) => lines.push({ line, raw, reject: r });
    if (cells === undefined || cells.length !== header!.length) return reject({ code: "MALFORMED_ROW", message: `expected ${header!.length} cells` });
    const r = csvRecord((name) => col(cells, name));
    if (isRejection(r)) return reject(r);
    if (seen.has(r.externalId)) return reject({ code: "DUPLICATE_IN_FILE", message: `transaction ${r.externalId} appears twice in this file` });
    seen.add(r.externalId);
    lines.push({ line, raw, record: r });
  });
  return { format: "DISTRIBUTOR_CSV", lines, fileErrors: [] };
}

function csvRecord(get: (name: string) => string | undefined): Normalized | Rejection {
  const externalId = required("transaction_id", get("transaction_id"));
  if (isRejection(externalId)) return externalId;
  const cur = currency(get("currency"));
  if (cur !== undefined) return cur;
  const amountKrw = krw(get("amount_krw"));
  if (isRejection(amountKrw)) return amountKrw;
  const occurredAt = instant(get("occurred_at"));
  if (isRejection(occurredAt)) return occurredAt;
  const type = (get("type") ?? "").trim().toUpperCase();
  if (type === "REFUND") {
    const originalExternalId = required("original_transaction_id", get("original_transaction_id"));
    if (isRejection(originalExternalId)) return originalExternalId;
    return { kind: "REFUND", externalId, originalExternalId, amountKrw, occurredAt };
  }
  if (type !== "SALE" && type !== "STREAM_REVENUE") return { code: "UNSUPPORTED_TYPE", message: `type must be SALE, REFUND or STREAM_REVENUE, got ${JSON.stringify(type)}` };
  const assetId = required("asset_id", get("asset_id"));
  if (isRejection(assetId)) return assetId;
  if (type === "SALE") return { kind: "SALE", externalId, assetId, amountKrw, occurredAt };
  const unitsRaw = (get("units") ?? "").trim();
  const units = unitsRaw === "" ? undefined : Number(unitsRaw);
  if (units !== undefined && !(Number.isSafeInteger(units) && units >= 0)) return { code: "INVALID_UNITS", message: "units must be a non-negative integer" };
  return { kind: "STREAM_REVENUE", externalId, assetId, amountKrw, occurredAt, ...(units !== undefined && { units }) };
}

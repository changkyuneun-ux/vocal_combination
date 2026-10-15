/**
 * 연동 허브의 정규화 레코드(다음 작업 14). 외부 형식(유통사 CSV, DDEX DSR)은 이 세 가지로만 번역된다.
 * 코어는 외부 형식을 모르고 이 레코드만 받는다. 금액은 원 단위 정수 문자열, 시각은 밀리초 UTC ISO다.
 */
export type Normalized =
  | { kind: "SALE"; externalId: string; assetId: string; amountKrw: string; occurredAt: string }
  | { kind: "REFUND"; externalId: string; originalExternalId: string; amountKrw: string; occurredAt: string }
  | { kind: "STREAM_REVENUE"; externalId: string; assetId: string; amountKrw: string; occurredAt: string; units?: number };

export type Rejection = { code: string; message: string };

/** 원본 한 줄의 번역 결과: 정규화 레코드 또는 거부 사유. line은 1부터 센 원본 줄 번호다. */
export type TranslatedLine = { line: number; raw: string } & ({ record: Normalized } | { reject: Rejection });

/** 파일 단위 오류(머리글 없음, 건수 불일치 등)가 있으면 레코드는 하나도 적용하지 않는다. */
export type Translation = { format: Format; lines: TranslatedLine[]; fileErrors: Rejection[] };

export type Format = "DISTRIBUTOR_CSV" | "DDEX_DSR";
export const FORMATS: readonly Format[] = ["DISTRIBUTOR_CSV", "DDEX_DSR"];

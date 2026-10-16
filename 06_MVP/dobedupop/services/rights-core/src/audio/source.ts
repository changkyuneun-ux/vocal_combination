import { compareFingerprints, decodeFingerprint, MATCH_THRESHOLD, type Analysis } from "audio-service";
import type { Tx } from "../platform/db.ts";

export type SourceResult = "PASS" | "SELF_MATCH" | "REVIEW" | "BLOCK";
export type SourceFinding = { check: string; result: SourceResult; detail: string };

/**
 * 소스 출처 검사(아키텍처 문서 "오디오 처리 서비스"). 오디오 처리 서비스가 만든 지문·길이·해시로 코어가 판정한다.
 * - 상용 음원 대조: 참조 음원과 지문이 맞으면, 같은 녹음·같은 마스터 권리자면 SELF_MATCH, 다른 권리자면 BLOCK.
 * - 같은 파일 재사용: 다른 녹음의 스템과 파일 해시가 같으면 REVIEW.
 * - 메타데이터 정합: 파일이 슬롯보다 짧으면 REVIEW.
 * - AI 생성 판별·등록 가창자 음성 대조는 아직 없다(NOT_CHECKED로 남기고 판정에 쓰지 않는다).
 * 가장 나쁜 결과가 판정이다(BLOCK > REVIEW > SELF_MATCH > PASS).
 */
export async function sourceCheck(tx: Tx, stemId: string, a: Analysis): Promise<{ result: SourceResult; findings: SourceFinding[]; notChecked: string[] }> {
  const stem = (await tx.query(
    `SELECT st.recording_id, r.master_owner_party_id, sl.duration_ms FROM stem st JOIN recording_version r ON r.recording_id = st.recording_id
       JOIN part_slot sl ON sl.slot_id = st.slot_id WHERE st.stem_id = $1`, [stemId])).rows[0];
  const findings: SourceFinding[] = [];
  if (a.fingerprint !== null) {
    const fp = decodeFingerprint(a.fingerprint);
    for (const ref of (await tx.query("SELECT reference_id, title, owner_party_id, recording_id, fingerprint FROM reference_audio ORDER BY reference_id")).rows) {
      const m = compareFingerprints(fp, decodeFingerprint(ref.fingerprint as string));
      if (m.similarity < MATCH_THRESHOLD) continue;
      const own = ref.recording_id === stem.recording_id || (ref.owner_party_id !== null && ref.owner_party_id === stem.master_owner_party_id);
      findings.push({ check: "commercial_match", result: own ? "SELF_MATCH" : "BLOCK",
        detail: `${ref.reference_id} "${ref.title}" similarity ${m.similarity.toFixed(3)}${own ? " (같은 권리자의 음원)" : " (다른 권리자의 상용 음원)"}` });
    }
  }
  const dup = (await tx.query(
    `SELECT a.stem_id FROM stem_audio a JOIN stem s ON s.stem_id = a.stem_id WHERE a.file_sha256 = $1 AND a.stem_id <> $2 AND s.recording_id <> $3 LIMIT 1`,
    [a.fileSha256, stemId, stem.recording_id])).rows[0];
  if (dup !== undefined) findings.push({ check: "duplicate_file", result: "REVIEW", detail: `same file as stem ${dup.stem_id} of another recording` });
  const durationMs = a.probe?.durationMs ?? 0;
  if (durationMs > 0 && durationMs + 500 < (stem.duration_ms as number)) {
    findings.push({ check: "duration", result: "REVIEW", detail: `file ${durationMs} ms is shorter than slot ${stem.duration_ms} ms` });
  }
  const rank: SourceResult[] = ["PASS", "SELF_MATCH", "REVIEW", "BLOCK"];
  const result = findings.reduce<SourceResult>((worst, f) => (rank.indexOf(f.result) > rank.indexOf(worst) ? f.result : worst), "PASS");
  return { result, findings, notChecked: ["ai_generated", "registered_voice_match"] };
}

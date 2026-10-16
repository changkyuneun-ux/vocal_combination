import { useMemo, useState } from "react";
import { useGet } from "../../api/hooks.ts";
import type { PolicyVersion, PolicyVersionDetail } from "../../api/types.ts";
import { Digest } from "../../components/Digest.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { Instant } from "../../components/Instant.tsx";

type DiffLine = {
  type: "added" | "removed" | "unchanged";
  baseLineNum?: number;
  targetLineNum?: number;
  text: string;
};

/** 간단한 LCS 기반 라인 Diff 알고리즘 */
function computeDiff(baseLines: string[], targetLines: string[]): DiffLine[] {
  const m = baseLines.length;
  const n = targetLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (baseLines[i] === targetLines[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && baseLines[i - 1] === targetLines[j - 1]) {
      result.unshift({
        type: "unchanged",
        baseLineNum: i,
        targetLineNum: j,
        text: baseLines[i - 1]!,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({
        type: "added",
        targetLineNum: j,
        text: targetLines[j - 1]!,
      });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      result.unshift({
        type: "removed",
        baseLineNum: i,
        text: baseLines[i - 1]!,
      });
      i--;
    }
  }

  return result;
}

export function PolicyDiffViewer({
  policyId,
  versions,
  onClose,
}: {
  policyId: string;
  versions: PolicyVersion[];
  onClose?: () => void;
}) {
  const sorted = useMemo(
    () => [...versions].sort((a, b) => a.version - b.version),
    [versions],
  );

  const defaultBase = sorted.length >= 2 ? sorted[sorted.length - 2]!.version : sorted[0]?.version ?? 0;
  const defaultTarget = sorted[sorted.length - 1]?.version ?? 0;

  const [baseVer, setBaseVer] = useState<number>(defaultBase);
  const [targetVer, setTargetVer] = useState<number>(defaultTarget);

  const baseDetail = useGet<PolicyVersionDetail>(
    ["version", policyId, baseVer],
    `/policies/${encodeURIComponent(policyId)}/versions/${baseVer}`,
    { enabled: baseVer > 0 },
  );

  const targetDetail = useGet<PolicyVersionDetail>(
    ["version", policyId, targetVer],
    `/policies/${encodeURIComponent(policyId)}/versions/${targetVer}`,
    { enabled: targetVer > 0 },
  );

  const baseText = baseDetail.data?.sourceText ?? "";
  const targetText = targetDetail.data?.sourceText ?? "";

  const diffLines = useMemo(() => {
    if (!baseText && !targetText) return [];
    return computeDiff(baseText.split("\n"), targetText.split("\n"));
  }, [baseText, targetText]);

  const baseInfo = versions.find((v) => v.version === baseVer);
  const targetInfo = versions.find((v) => v.version === targetVer);

  return (
    <div className="diff-modal stack" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "12px", padding: "16px", marginTop: "16px" }}>
      <div className="row-actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>정책 버전 Diff 비교 ({policyId})</h3>
        {onClose && (
          <button type="button" className="btn" onClick={onClose}>
            닫기
          </button>
        )}
      </div>

      <div className="row-actions" style={{ gap: "24px", margin: "12px 0", flexWrap: "wrap" }}>
        <label className="field" style={{ flex: 1 }}>
          <span>기준 버전 (Base)</span>
          <select value={baseVer} onChange={(e) => setBaseVer(Number(e.target.value))}>
            {sorted.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} ({v.status})
              </option>
            ))}
          </select>
        </label>

        <label className="field" style={{ flex: 1 }}>
          <span>비교 버전 (Target)</span>
          <select value={targetVer} onChange={(e) => setTargetVer(Number(e.target.value))}>
            {sorted.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} ({v.status})
              </option>
            ))}
          </select>
        </label>
      </div>

      {baseInfo && targetInfo && (
        <div className="grid-diff-meta" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", fontSize: "0.85em", background: "var(--surface-2)", padding: "12px", borderRadius: "8px" }}>
          <div>
            <strong>v{baseInfo.version}</strong> <StatusBadge status={baseInfo.status} />
            <dl className="kv" style={{ marginTop: "8px" }}>
              <dt>Policy Digest</dt>
              <dd><Digest value={baseInfo.policyDigest} label={`v${baseInfo.version} policy`} /></dd>
              <dt>Facts Digest</dt>
              <dd><Digest value={baseInfo.factsDigest} label={`v${baseInfo.version} facts`} /></dd>
              <dt>작성일</dt>
              <dd><Instant iso={baseInfo.createdAt} /></dd>
            </dl>
          </div>
          <div>
            <strong>v{targetInfo.version}</strong> <StatusBadge status={targetInfo.status} />
            <dl className="kv" style={{ marginTop: "8px" }}>
              <dt>Policy Digest</dt>
              <dd><Digest value={targetInfo.policyDigest} label={`v${targetInfo.version} policy`} /></dd>
              <dt>Facts Digest</dt>
              <dd><Digest value={targetInfo.factsDigest} label={`v${targetInfo.version} facts`} /></dd>
              <dt>작성일</dt>
              <dd><Instant iso={targetInfo.createdAt} /></dd>
            </dl>
          </div>
        </div>
      )}

      <div className="diff-view" style={{ fontFamily: "var(--font-mono)", fontSize: "13px", background: "var(--code-bg)", color: "var(--code-fg)", borderRadius: "8px", overflowX: "auto", maxHeight: "450px", overflowY: "auto", padding: "8px" }}>
        {baseDetail.isLoading || targetDetail.isLoading ? (
          <p className="muted" style={{ padding: "16px" }}>버전 내용을 불러오는 중...</p>
        ) : diffLines.length === 0 ? (
          <p className="muted" style={{ padding: "16px" }}>두 버전의 내용이 완전히 동일합니다.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {diffLines.map((line, idx) => {
                const bg = line.type === "added" ? "var(--ok-soft)" : line.type === "removed" ? "var(--bad-soft)" : "transparent";
                const color = line.type === "added" ? "var(--ok)" : line.type === "removed" ? "var(--bad)" : "var(--code-fg)";
                const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
                return (
                  <tr key={idx} style={{ backgroundColor: bg }}>
                    <td style={{ width: "35px", textAlign: "right", color: "var(--muted)", userSelect: "none", paddingRight: "8px" }}>
                      {line.baseLineNum ?? ""}
                    </td>
                    <td style={{ width: "35px", textAlign: "right", color: "var(--muted)", userSelect: "none", paddingRight: "8px" }}>
                      {line.targetLineNum ?? ""}
                    </td>
                    <td style={{ width: "20px", textAlign: "center", color, userSelect: "none" }}>{sign}</td>
                    <td style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, type DragEvent, type ReactNode } from "react";

/** 받는 형식: 계약서는 PDF, 스템은 오디오(코어가 받는 audio/* — WAV 등). */
export type Accept = "pdf" | "audio";
const AUDIO_EXT = [".wav", ".wave", ".flac", ".aif", ".aiff", ".mp3", ".m4a", ".ogg"];
export const ACCEPT_ERROR: Record<Accept, string> = { pdf: "PDF만 올릴 수 있습니다", audio: "오디오 파일(WAV 등)만 올릴 수 있습니다" };
export const ACCEPT_ATTR: Record<Accept, string> = { pdf: "application/pdf,.pdf", audio: "audio/*,.wav,.flac,.aif,.aiff" };

/** 형식 검사: 파일 형식(MIME) 또는 확장자로 본다(끌어 놓은 파일은 형식이 비어 있을 수 있다). */
export function acceptsFile(f: { name: string; type: string }, accept: Accept): boolean {
  const name = f.name.toLowerCase();
  if (accept === "pdf") return f.type === "application/pdf" || (f.type === "" && name.endsWith(".pdf")) || (f.type === "application/octet-stream" && name.endsWith(".pdf"));
  return f.type.startsWith("audio/") || ((f.type === "" || f.type === "application/octet-stream") && AUDIO_EXT.some((x) => name.endsWith(x)));
}

/** 상자 밖에 떨어뜨린 파일을 브라우저가 열지 않게 한다(이 부품이 있는 화면 동안). */
function useWindowDropGuard() {
  useEffect(() => {
    const stop = (e: Event) => { e.preventDefault(); };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);
}

/**
 * 끌어 놓기 상자(시안의 점선 상자): 파일을 끌어 놓거나 "파일 고르기" 라벨로 숨은 input을 연다(키보드·스크린리더).
 * 끌고 들어오면 남색 테두리·옅은 남색 바탕으로 강조하고, 놓으면 첫 파일을 받는다. 형식이 맞지 않으면 아래에 한 줄 오류를 보이고 받지 않는다.
 * variant: large(새 곡 — 굵은 첫 줄 + 설명 줄) · compact(올리기 칸 — 한 줄) · input(스템 칸 — 입력 상자 모양).
 */
export function DropZone({ id, label, accept, file, onFile, variant = "compact", what, hint, current }: {
  id: string; label: string; accept: Accept; file: File | null; onFile: (f: File | null) => void;
  variant?: "large" | "compact" | "input"; what?: string; hint?: ReactNode; current?: string;
}) {
  useWindowDropGuard();
  const [over, setOver] = useState(false);
  const [err, setErr] = useState("");
  const take = (f: File | undefined | null) => {
    if (!f) return;
    if (!acceptsFile(f, accept)) { setErr(ACCEPT_ERROR[accept]); return; }
    setErr(""); onFile(f);
  };
  const enter = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setOver(true); };
  const leave = (e: DragEvent) => { e.preventDefault(); if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setOver(false); };
  const drop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setOver(false); take(e.dataTransfer?.files?.[0]); };
  const pick = (text: string) => <label htmlFor={id} style={{ color: "var(--p-link)", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>{text}</label>;
  const shown = file?.name ?? current;
  const box = variant === "input"
    ? { display: "flex", justifyContent: "space-between", gap: 8, color: shown ? "var(--p-fg)" : "var(--p-muted)" }
    : variant === "large" ? { borderRadius: 10, padding: 18, display: "flex", gap: 12, alignItems: "center" } : { borderRadius: 10, padding: 14, fontSize: 13.5 };
  const tone = over ? { border: "1.5px dashed var(--p-accent)", background: "var(--p-accent-soft)" }
    : variant === "input" ? {} : { border: "1.5px dashed var(--p-line-strong)", background: "var(--p-soft)" };
  return (
    <div>
      <div role="group" aria-label={`${label} 끌어 놓기`} data-dropzone={id} data-over={over || undefined} className={variant === "input" ? "p-input" : undefined}
        style={{ ...box, ...tone }} onDragEnter={enter} onDragOver={enter} onDragLeave={leave} onDrop={drop}>
        {variant === "large" ? (
          <div style={{ flex: "1 1 auto" }}>
            {file ? <div style={{ fontWeight: 700 }}>{file.name} · {pick("바꾸기")}</div> : <div style={{ fontWeight: 700 }}>{what}를 끌어 놓거나 {pick("파일 고르기")}</div>}
            {hint && <div style={{ fontSize: 12.5, color: "var(--p-muted)" }}>{hint}</div>}
          </div>
        ) : variant === "input" ? (
          <><span>{shown ?? <>파일 끌어 놓기 또는 {pick("고르기")}{hint ? <> · {hint}</> : null}</>}</span>{shown && pick("바꾸기")}</>
        ) : (
          <>{file ? <>{file.name} · {pick("바꾸기")}</> : <>끌어 놓거나 {pick("파일 고르기")}{hint ? <> · {hint}</> : null}</>}</>
        )}
        <input id={id} type="file" accept={ACCEPT_ATTR[accept]} aria-label={label} style={{ position: "absolute", left: -9999 }}
          onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {err && <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: "var(--p-bad)", fontWeight: 600 }}>{err}</div>}
    </div>
  );
}

import { describe, expect, it } from "vitest";
import { ACCEPT_ERROR, acceptsFile } from "./DropZone.tsx";

describe("끌어 놓기 형식 검사(DropZone)", () => {
  it("계약서는 PDF만: 형식(MIME)이나, 형식이 비었으면 확장자로", () => {
    expect(acceptsFile({ name: "계약서.pdf", type: "application/pdf" }, "pdf")).toBe(true);
    expect(acceptsFile({ name: "계약서.PDF", type: "" }, "pdf")).toBe(true);
    expect(acceptsFile({ name: "계약서.pdf", type: "application/octet-stream" }, "pdf")).toBe(true);
    expect(acceptsFile({ name: "scan.png", type: "image/png" }, "pdf")).toBe(false);
    expect(acceptsFile({ name: "계약서.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, "pdf")).toBe(false);
    expect(acceptsFile({ name: "fake.pdf", type: "image/png" }, "pdf")).toBe(false);
  });

  it("스템은 오디오만: audio/* 또는 형식이 비었을 때 WAV 등 확장자", () => {
    expect(acceptsFile({ name: "stem.wav", type: "audio/wav" }, "audio")).toBe(true);
    expect(acceptsFile({ name: "stem.flac", type: "audio/flac" }, "audio")).toBe(true);
    expect(acceptsFile({ name: "stem.WAV", type: "" }, "audio")).toBe(true);
    expect(acceptsFile({ name: "stem.aiff", type: "application/octet-stream" }, "audio")).toBe(true);
    expect(acceptsFile({ name: "계약서.pdf", type: "application/pdf" }, "audio")).toBe(false);
    expect(acceptsFile({ name: "notes.txt", type: "" }, "audio")).toBe(false);
  });

  it("오류 문구", () => {
    expect(ACCEPT_ERROR.pdf).toBe("PDF만 올릴 수 있습니다");
    expect(ACCEPT_ERROR.audio).toContain("오디오");
  });
});

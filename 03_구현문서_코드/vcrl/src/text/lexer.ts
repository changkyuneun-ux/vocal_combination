import { fail } from "../core/errors.ts";

export type TokenKind = "ident" | "string" | "number" | "punct" | "eof";
export type Token = { kind: TokenKind; text: string; line: number; col: number };

const PUNCT2 = ["|>", "->", "=="];
const PUNCT1 = "{}()[];:,=@";
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*/y;
const NUMBER_RE = /\d+(?:\.\d+)?(?:%|bps)?/y;
const INSTANT_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/y;
const IDENT_CHAR = /[A-Za-z0-9_]/;


/** 진단 경로 표기: `@줄:열`(1부터). */
export function at(pos: { line: number; col: number }): string {
  return `@${pos.line}:${pos.col}`;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  /** 맨 앞 BOM(U+FEFF)은 건너뛴다. 위치는 그 뒤에서 1:1부터 센다. */
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let col = 1;
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance(1);
      continue;
    }
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") advance(1);
      continue;
    }
    const pos = { line, col };
    if (c === '"') {
      let j = i + 1;
      let text = "";
      for (;;) {
        const ch = src[j];
        if (ch === undefined || ch === "\n") fail("PARSE_SYNTAX", at(pos), "unterminated string");
        if (ch === '"') break;
        if (ch === "\\") {
          const nx = src[j + 1];
          if (nx !== '"' && nx !== "\\") fail("PARSE_SYNTAX", at(pos), "only \\\" and \\\\ escapes are supported");
          text += nx;
          j += 2;
          continue;
        }
        text += ch;
        j++;
      }
      out.push({ kind: "string", text, ...pos });
      advance(j + 1 - i);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      out.push({ kind: "punct", text: two, ...pos });
      advance(2);
      continue;
    }
    if (PUNCT1.includes(c)) {
      out.push({ kind: "punct", text: c, ...pos });
      advance(1);
      continue;
    }
    if (c >= "0" && c <= "9") {
      INSTANT_RE.lastIndex = i;
      const inst = INSTANT_RE.exec(src);
      if (inst) {
        out.push({ kind: "ident", text: inst[0], ...pos });
        advance(inst[0].length);
        continue;
      }
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src)!;
      const after = src[i + m[0].length];
      if (after !== undefined && IDENT_CHAR.test(after)) fail("PARSE_SYNTAX", at(pos), "invalid number (quote ids that start with a digit)");
      out.push({ kind: "number", text: m[0], ...pos });
      advance(m[0].length);
      continue;
    }

    IDENT_RE.lastIndex = i;
    const id = IDENT_RE.exec(src);
    if (id) {
      out.push({ kind: "ident", text: id[0], ...pos });
      advance(id[0].length);
      continue;
    }
    fail("PARSE_SYNTAX", at(pos), `unexpected character ${JSON.stringify(c)}`);
  }
  out.push({ kind: "eof", text: "", line, col });
  return out;
}

import { isEnumValue, type EnumValue } from "./enums.ts";
import { fail } from "./errors.ts";

export type Ref = { kind: EnumValue<"module">; id: string; version: number };
const REF_RE = /^vc:([a-z]+)\/([A-Za-z0-9._-]+)@([1-9]\d*)$/;

export function parseRef(s: string, path = "$"): Ref {
  const m = REF_RE.exec(s);
  if (!m) fail("CORE_TYPE_ERROR", path, `not a ref: ${s}`);
  const kind = m[1];
  if (!isEnumValue("module", kind)) fail("CORE_ENUM_UNKNOWN", path, `module ${kind}`);
  return { kind, id: m[2]!, version: Number(m[3]) };
}

export function formatRef(r: Ref): string {
  return `vc:${r.kind}/${r.id}@${r.version}`;
}

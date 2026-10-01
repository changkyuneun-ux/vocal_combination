import { Form, type Field } from "./Form.tsx";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { useAction } from "../api/hooks.ts";
import { post } from "../api/registry.ts";

/** 등록 폼: 현재 사용자로 POST하고, 실패는 폼 아래 ErrorPanel, 성공은 관련 목록을 다시 읽는다. */
export function RegisterForm({ fields, path, toBody, invalidate, submitLabel = "등록" }: {
  fields: Field[];
  path: string | ((v: Record<string, string>) => string);
  toBody: (v: Record<string, string>) => unknown;
  invalidate: string[];
  submitLabel?: string;
}) {
  const m = useAction<Record<string, string>, unknown>((v) => post(typeof path === "function" ? path(v) : path, toBody(v)), invalidate);
  return (
    <div className="stack">
      <Form fields={fields} submitLabel={submitLabel} busy={m.isPending} onSubmit={(v) => m.mutate(v)} />
      {m.isSuccess && <p className="muted" role="status">완료</p>}
      <ErrorPanel error={m.error} />
    </div>
  );
}

import { useState, type FormEvent } from "react";

export type Field = {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "datetime";
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  initial?: string;
};

export function Form({ fields, onSubmit, submitLabel, busy }: {
  fields: Field[];
  onSubmit: (values: Record<string, string>) => void;
  submitLabel: string;
  busy?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ""])));
  const set = (n: string, v: string) => setValues((s) => ({ ...s, [n]: v }));
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(values); };
  return (
    <form className="form" onSubmit={submit}>
      {fields.map((f) => (
        <label key={f.name} className="field">
          <span>{f.label}{f.required && <b className="req" title="필수" aria-hidden="true"> *</b>}</span>
          {f.type === "select" ? (
            <select value={values[f.name]} required={f.required} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">선택…</option>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === "textarea" ? (
            <textarea value={values[f.name]} required={f.required} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
          ) : (
            <input
              type={f.type === "datetime" ? "datetime-local" : f.type}
              step={f.type === "datetime" ? 1 : undefined}
              value={values[f.name]} required={f.required} placeholder={f.placeholder}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
        </label>
      ))}
      <button type="submit" className="btn primary" disabled={busy}>{submitLabel}</button>
    </form>
  );
}

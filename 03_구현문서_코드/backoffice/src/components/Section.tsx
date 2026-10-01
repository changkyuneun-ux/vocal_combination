import { useId, type ReactNode } from "react";

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head"><h2 id={id}>{title}</h2><div className="actions">{actions}</div></div>
      {children}
    </section>
  );
}

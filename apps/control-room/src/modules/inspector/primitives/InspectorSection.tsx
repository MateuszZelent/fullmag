import type { ReactNode } from "react";

interface InspectorSectionProps {
  children: ReactNode;
  title: string;
}

export function InspectorSection({ children, title }: InspectorSectionProps) {
  return (
    <section className="fm-inspector-section">
      <header className="fm-inspector-section__header">
        <h3>{title}</h3>
      </header>
      <div className="fm-inspector-section__body">{children}</div>
    </section>
  );
}

import type { ReactNode } from "react";

export function SectionHeader({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h2
      className="px-fm-1 pb-fm-2 font-fm-ui text-fm-2xs font-semibold uppercase text-fm-start-meta"
      id={id}
      style={{ letterSpacing: "var(--fm-start-section-tracking)" }}
    >
      {children}
    </h2>
  );
}

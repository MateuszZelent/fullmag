import type { ReactNode } from "react";

export interface SectionHeaderProps {
  readonly id: string;
  readonly title: string;
  readonly tools?: ReactNode;
}

export function SectionHeader({ id, title, tools }: SectionHeaderProps) {
  return (
    <div className="fm-start-section__head">
      <h2 className="fm-start-section__title" id={id}>
        {title}
      </h2>
      {tools ? <div className="fm-start-section__tools">{tools}</div> : null}
    </div>
  );
}

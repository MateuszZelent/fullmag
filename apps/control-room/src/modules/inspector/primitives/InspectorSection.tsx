import { useState, type ReactNode } from "react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/shared/ui/Accordion";

interface InspectorSectionProps {
  children: ReactNode;
  title: string;
  /** Badge shown in the section header (e.g. item count, status label). */
  badge?: string;
  /** If true, renders a collapse toggle. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** If provided, renders as a Radix AccordionItem (requires parent Accordion). */
  value?: string;
}

/**
 * Inspector panel section with optional collapse.
 *
 * Rendering modes:
 * 1. `value` prop → renders as AccordionItem (requires parent <Accordion>)
 * 2. `collapsible` without `value` → wraps itself in a standalone Accordion
 * 3. Neither → static section header (no collapse)
 */
export function InspectorSection({
  badge,
  children,
  collapsible = false,
  defaultCollapsed = false,
  title,
  value,
}: InspectorSectionProps) {
  const headerContent = (
    <>
      <div className="fm-inspector-section__title-row">
        <h3 className="fm-inspector-section__title">{title}</h3>
      </div>
      {badge && <span className="fm-inspector-section__badge">{badge}</span>}
    </>
  );

  // Mode 1: Grouped Accordion (parent manages state)
  if (value) {
    return (
      <AccordionItem value={value} className="fm-inspector-section__item">
        <AccordionTrigger className="fm-inspector-section__header">
          {headerContent}
        </AccordionTrigger>
        <AccordionContent>
          <div className="fm-inspector-section__body">{children}</div>
        </AccordionContent>
      </AccordionItem>
    );
  }

  // Mode 2: Standalone collapsible (auto-wrapped Accordion)
  if (collapsible) {
    const sectionValue = "section";
    const defaultValue = defaultCollapsed ? undefined : sectionValue;
    return (
      <Accordion
        type="single"
        collapsible
        defaultValue={defaultValue}
        className="fm-inspector-section fm-inspector-section--standalone"
      >
        <AccordionItem value={sectionValue} className="fm-inspector-section__item">
          <AccordionTrigger className="fm-inspector-section__header">
            {headerContent}
          </AccordionTrigger>
          <AccordionContent>
            <div className="fm-inspector-section__body">{children}</div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  // Mode 3: Static section (no collapse)
  return (
    <section className="fm-inspector-section">
      <header className="fm-inspector-section__header">{headerContent}</header>
      <div className="fm-inspector-section__body">{children}</div>
    </section>
  );
}

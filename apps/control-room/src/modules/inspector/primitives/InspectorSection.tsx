import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
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
 * Compatibility card surface for Inspector families that have not yet migrated.
 * Migrated panels must use InspectorGroup and must never nest InspectorSection.
 *
 * Rendering modes:
 * 1. `value` prop → renders as AccordionItem (requires parent <Accordion>)
 * 2. `collapsible` without `value` → renders a standalone disclosure section
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
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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
    return (
      <section
        className="fm-inspector-section fm-inspector-section--standalone"
        data-collapsed={collapsed}
      >
        <button
          aria-expanded={!collapsed}
          className="fm-inspector-section__header"
          data-collapsible="true"
          type="button"
          onClick={() => setCollapsed((current) => !current)}
        >
          {headerContent}
          <ChevronRight className="fm-inspector-section__chevron" aria-hidden="true" />
        </button>
        <div className="fm-inspector-section__body" hidden={collapsed}>
          {children}
        </div>
      </section>
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

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AccordionItem, AccordionTrigger, AccordionContent } from "@/shared/ui/Accordion";

interface InspectorSectionProps {
  children: ReactNode;
  title: string;
  /** Badge shown in the section header (e.g. item count, status label). */
  badge?: string;
  /** If true, renders a collapse toggle. Starts expanded unless defaultCollapsed=true. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** If provided, renders as a Radix AccordionItem (requires parent Accordion). */
  value?: string;
}

export function InspectorSection({
  badge,
  children,
  collapsible = false,
  defaultCollapsed = false,
  title,
  value,
}: InspectorSectionProps) {
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const collapsed = collapsible ? (collapsedOverride ?? defaultCollapsed) : false;
  const bodyId = useId();

  if (value) {
    // Radix Accordion Mode (Modern, animated, grouped)
    return (
      <AccordionItem value={value} className="fm-inspector-section__item">
        <AccordionTrigger className="fm-inspector-section__header">
          <div className="fm-inspector-section__title-row">
            <h3 className="fm-inspector-section__title">{title}</h3>
          </div>
          {badge && <span className="fm-inspector-section__badge">{badge}</span>}
        </AccordionTrigger>
        <AccordionContent>
          <div className="fm-inspector-section__body">{children}</div>
        </AccordionContent>
      </AccordionItem>
    );
  }

  // Legacy Fallback Mode
  const headerContent = (
    <>
      <div className="fm-inspector-section__title-row">
        {collapsible && (
          <ChevronRight
            className="fm-inspector-section__chevron"
            size={12}
            aria-hidden="true"
          />
        )}
        <h3>{title}</h3>
      </div>
      {badge && <span className="fm-inspector-section__badge">{badge}</span>}
    </>
  );

  return (
    <section
      className="fm-inspector-section"
      data-collapsed={collapsed ? "true" : undefined}
    >
      {collapsible ? (
        <button
          type="button"
          className="fm-inspector-section__header"
          data-collapsible="true"
          aria-controls={bodyId}
          aria-expanded={!collapsed}
          onClick={() =>
            setCollapsedOverride((current) => !(current ?? defaultCollapsed))
          }
        >
          {headerContent}
        </button>
      ) : (
        <header className="fm-inspector-section__header">{headerContent}</header>
      )}
      <div id={bodyId} className="fm-inspector-section__body">{children}</div>
    </section>
  );
}

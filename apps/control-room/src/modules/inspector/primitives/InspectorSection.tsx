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
      <AccordionItem value={value} className="bg-[var(--fm-bg-panel-raised)] border-x border-t border-[var(--fm-border-subtle)] first:rounded-t-md last:rounded-b-md last:border-b">
        <AccordionTrigger className="fm-inspector-section__header flex w-full items-center justify-between px-2 py-1">
          <div className="fm-inspector-section__title-row flex items-center gap-1">
            <h3 className="m-0 text-sm font-semibold text-[var(--fm-text-primary)]">{title}</h3>
          </div>
          {badge && <span className="fm-inspector-section__badge ml-auto">{badge}</span>}
        </AccordionTrigger>
        <AccordionContent>
          <div className="fm-inspector-section__body grid gap-[1px] p-1">{children}</div>
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

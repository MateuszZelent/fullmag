import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Badge } from "@/shared/ui/Badge";
import { cn } from "@/shared/utils/className";

export interface InspectorGroupProps {
  badge?: string;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  description?: string;
  /** Optional icon rendered before the title. Should be a Lucide icon element. */
  icon?: ReactNode;
  /** Value summary shown on the right side of the header row. */
  summary?: string;
  /**
   * "nav" keeps a toggle row even when the group is not collapsible. Both
   * variants share the one section look (specs/frontend-v2/13 §1a, slot 6).
   */
  variant?: "default" | "nav";
  title: string;
}

/**
 * The one Inspector section: a glass card with a disclosure chevron next to
 * the title, a domain-hue icon when open, an optional value summary and the
 * content grid. Nested sections render flat inside their parent card.
 */
export function InspectorGroup({
  badge,
  children,
  className,
  collapsible = false,
  defaultOpen = true,
  description,
  icon,
  summary,
  variant = "default",
  title,
}: InspectorGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const toggleRow = collapsible || variant === "nav";

  const heading = (
    <div className="min-w-0 flex-1" data-slot="inspector-group-heading">
      <h3 className="m-0 text-fm-sm font-semibold leading-tight text-fm-primary">
        {title}
      </h3>
      {description ? (
        <p className="mt-0.5 mb-0 text-fm-help leading-snug text-fm-muted">
          {description}
        </p>
      ) : null}
    </div>
  );
  const trailing = (
    <>
      {summary ? (
        <span className="fm-inspector-group__summary max-w-[50%] shrink truncate text-fm-xs text-fm-muted">
          {summary}
        </span>
      ) : null}
      {badge ? <Badge variant="secondary">{badge}</Badge> : null}
    </>
  );
  const iconSlot = icon ? (
    <span className="fm-inspector-group__icon" aria-hidden="true">
      {icon}
    </span>
  ) : null;

  return (
    <section
      className={cn("fm-inspector-group min-w-0", className)}
      data-collapsible={collapsible || undefined}
      data-open={collapsible ? open : undefined}
      data-slot="inspector-group"
      data-variant={variant === "nav" ? "nav" : undefined}
    >
      {toggleRow ? (
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="fm-inspector-group__row fm-inspector-group__row--toggle"
          data-slot="inspector-group-trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight
            aria-hidden="true"
            className="fm-inspector-group__chevron"
            size={14}
          />
          {iconSlot}
          {heading}
          {trailing}
        </button>
      ) : (
        <header
          className="fm-inspector-group__row"
          data-slot="inspector-group-header"
        >
          {iconSlot}
          {heading}
          {trailing}
        </header>
      )}
      <div
        className="fm-inspector-group__content grid min-w-0 gap-fm-inspector-control"
        data-slot="inspector-group-content"
        hidden={collapsible && !open}
        id={contentId}
      >
        {children}
      </div>
    </section>
  );
}

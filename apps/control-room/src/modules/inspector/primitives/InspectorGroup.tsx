import { ChevronDown, ChevronRight } from "lucide-react";
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
  /** Summary text shown on the right side of the header (used in nav-row style collapsibles) */
  summary?: string;
  /** Use "nav" style: full-width clickable row with icon, title, summary, and chevron-right */
  variant?: "default" | "nav";
  title: string;
}

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

  const heading = (
    <div className="min-w-0 flex-1" data-slot="inspector-group-heading">
      <h3 className="m-0 text-[11px] font-semibold leading-tight text-fm-primary">
        {title}
      </h3>
      {description ? (
        <p className="mt-0.5 mb-0 text-fm-help leading-snug text-fm-muted">
          {description}
        </p>
      ) : null}
    </div>
  );

  if (variant === "nav") {
    return (
      <section
        className={cn(
          "min-w-0 border-b border-fm-subtle last:border-b-0",
          className,
        )}
        data-collapsible={collapsible || undefined}
        data-open={collapsible ? open : undefined}
        data-slot="inspector-group"
        data-variant="nav"
      >
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="fm-inspector-group-nav-trigger flex w-full min-w-0 items-center gap-3 px-[var(--fm-inspector-padding-inline)] py-2.5 text-left outline-none transition-colors hover:bg-fm-hover focus-visible:ring-2 focus-visible:ring-fm-accent"
          data-slot="inspector-group-trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {icon ? (
            <span className="fm-inspector-group-nav-icon">
              {icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 text-[13px] font-semibold leading-tight text-fm-primary">
            {title}
          </span>
          {summary ? (
            <span className="shrink-0 text-[11px] text-fm-muted">{summary}</span>
          ) : null}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
          <ChevronRight
            aria-hidden="true"
            className="shrink-0 text-fm-muted transition-transform duration-150"
            size={14}
          />
        </button>
        <div
          className="grid min-w-0 gap-[var(--fm-inspector-control-gap)] px-[var(--fm-inspector-padding-inline)] pb-3"
          data-slot="inspector-group-content"
          hidden={collapsible && !open}
          id={contentId}
        >
          {children}
        </div>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "min-w-0 border-b border-fm-subtle pb-[var(--fm-inspector-group-gap)] last:border-b-0 last:pb-0",
        className,
      )}
      data-collapsible={collapsible || undefined}
      data-open={collapsible ? open : undefined}
      data-slot="inspector-group"
    >
      {collapsible ? (
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="flex h-fm-control-sm w-full min-w-0 items-center gap-1.5 rounded-[var(--fm-radius-disclosure)] px-1.5 text-left outline-none transition-colors hover:bg-fm-disabled focus-visible:ring-2 focus-visible:ring-fm-accent"
          data-slot="inspector-group-trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {icon ? (
            <span className="fm-inspector-group-icon-box">
              {icon}
            </span>
          ) : null}
          {heading}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
          {open ? (
            <ChevronDown
              aria-hidden="true"
              className="shrink-0 text-fm-muted transition-transform duration-150"
              size={14}
            />
          ) : (
            <ChevronRight
              aria-hidden="true"
              className="shrink-0 text-fm-muted transition-transform duration-150"
              size={14}
            />
          )}
        </button>
      ) : (
        <header
          className="flex h-fm-control-sm min-w-0 items-center gap-1.5 px-1.5"
          data-slot="inspector-group-header"
        >
          {icon ? (
            <span className="fm-inspector-group-icon-box">
              {icon}
            </span>
          ) : null}
          {heading}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </header>
      )}
      <div
        className="mt-1 grid min-w-0 gap-[var(--fm-inspector-control-gap)] px-1.5"
        data-slot="inspector-group-content"
        hidden={collapsible && !open}
        id={contentId}
      >
        {children}
      </div>
    </section>
  );
}

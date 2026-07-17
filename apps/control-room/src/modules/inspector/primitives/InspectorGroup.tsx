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
  title: string;
}

export function InspectorGroup({
  badge,
  children,
  className,
  collapsible = false,
  defaultOpen = true,
  description,
  title,
}: InspectorGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const heading = (
    <div className="min-w-0 flex-1" data-slot="inspector-group-heading">
      <h3 className="m-0 text-fm-label font-semibold leading-tight text-fm-primary">
        {title}
      </h3>
      {description ? (
        <p className="mt-1 mb-0 text-fm-help leading-snug text-fm-muted">
          {description}
        </p>
      ) : null}
    </div>
  );

  return (
    <section
      className={cn(
        "min-w-0 border-b border-fm-subtle pb-4 last:border-b-0 last:pb-0",
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
          className="flex min-h-fm-control-sm w-full min-w-0 items-center gap-2 rounded-fm-control px-1 text-left outline-none transition-colors hover:bg-fm-disabled focus-visible:ring-2 focus-visible:ring-fm-accent"
          data-slot="inspector-group-trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {heading}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "shrink-0 text-fm-muted transition-transform duration-150",
              open && "rotate-90",
            )}
            size={14}
          />
        </button>
      ) : (
        <header
          className="flex min-h-fm-control-sm min-w-0 items-center gap-2 px-1"
          data-slot="inspector-group-header"
        >
          {heading}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </header>
      )}
      <div
        className="mt-2 grid min-w-0 gap-3 px-1"
        data-slot="inspector-group-content"
        hidden={collapsible && !open}
        id={contentId}
      >
        {children}
      </div>
    </section>
  );
}

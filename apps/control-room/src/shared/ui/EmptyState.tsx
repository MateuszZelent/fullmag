import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/shared/utils/className";

export interface EmptyStateProps extends ComponentPropsWithRef<"section"> {
  /** Small decorative icon or glyph rendered above the heading. */
  icon?: ReactNode;
  heading: ReactNode;
  description?: ReactNode;
  /** Typically a <Button/>. */
  action?: ReactNode;
  /** "compact" trims padding/typography for narrow hosts (e.g. Inspector panels). */
  size?: "default" | "compact";
}

/**
 * Shared empty-state layout (frontend audit 2026-09-03, P2 item — modules
 * previously hand-rolled this markup ad hoc; only ~2 call sites reused any
 * common structure). Prefer this over a bespoke <section> for "nothing here
 * yet" / "no results" / "no session" states.
 */
export function EmptyState({
  icon,
  heading,
  description,
  action,
  className,
  size = "default",
  ...props
}: EmptyStateProps) {
  return (
    <section
      className={cn("fm-empty-state", className)}
      data-size={size}
      data-slot="empty-state"
      {...props}
    >
      {icon ? <div className="fm-empty-state__icon">{icon}</div> : null}
      <p className="fm-empty-state__title">{heading}</p>
      {description ? (
        <p className="fm-empty-state__description">{description}</p>
      ) : null}
      {action ? <div className="fm-empty-state__action">{action}</div> : null}
    </section>
  );
}

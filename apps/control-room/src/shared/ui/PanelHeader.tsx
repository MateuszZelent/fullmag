import type { ReactNode } from "react";

import { cn } from "@/shared/utils/className";

interface PanelHeaderProps {
  /** Panel title text */
  title: string;
  /** Optional subtitle / metadata text */
  subtitle?: string;
  /** Right-aligned slot for badge, button, or status */
  trailing?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

/**
 * Shared panel header used by Explorer, Inspector, and Footer panels.
 * Provides a consistent `--fm-panel-header-height` header with title, optional subtitle, and trailing slot.
 */
export function PanelHeader({ title, subtitle, trailing, className }: PanelHeaderProps) {
  return (
    <div className={cn("fm-panel-header", className)}>
      <div className="fm-panel-header__left">
        <h2 className="fm-panel-header__title">{title}</h2>
        {subtitle && <span className="fm-panel-header__subtitle">{subtitle}</span>}
      </div>
      {trailing && <div className="fm-panel-header__trailing">{trailing}</div>}
    </div>
  );
}

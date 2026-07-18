import { useId, type ReactNode } from "react";

import { cn } from "@/shared/utils/className";

export interface InspectorPropertyGridProps {
  children: ReactNode;
  className?: string;
}

export function InspectorPropertyGrid({
  children,
  className,
}: InspectorPropertyGridProps) {
  return (
    <div
      className={cn("grid min-w-0 gap-fm-inspector-row", className)}
      data-slot="inspector-property-grid"
    >
      {children}
    </div>
  );
}

export interface InspectorPropertyRowProps {
  children: ReactNode;
  className?: string;
  description?: string;
  label: ReactNode;
  layout?: "inline" | "stacked";
  unit?: ReactNode;
}

export function InspectorPropertyRow({
  children,
  className,
  description,
  label,
  layout = "inline",
  unit,
}: InspectorPropertyRowProps) {
  const labelId = useId();

  return (
    <div
      className={cn(
        "grid min-h-fm-field-row min-w-0 gap-x-fm-inspector-control gap-y-1",
        layout === "inline"
          ? "grid-cols-[minmax(96px,0.8fr)_minmax(0,1.2fr)] items-center"
          : "grid-cols-1",
        className,
      )}
      data-layout={layout}
      data-slot="inspector-property-row"
    >
      <div className="min-w-0" data-slot="inspector-property-label">
        <div
          className="text-fm-label font-medium leading-tight text-fm-secondary"
          id={labelId}
        >
          {label}
        </div>
        {description ? (
          <p className="mt-0.5 text-fm-help leading-snug text-fm-muted">
            {description}
          </p>
        ) : null}
      </div>
      <div
        aria-labelledby={labelId}
        className="flex min-w-0 items-center justify-end gap-fm-inspector-control [font-variant-numeric:tabular-nums]"
        data-slot="inspector-property-control"
        role="group"
      >
        {children}
        {unit ? (
          <span className="shrink-0 text-fm-help text-fm-muted">{unit}</span>
        ) : null}
      </div>
    </div>
  );
}

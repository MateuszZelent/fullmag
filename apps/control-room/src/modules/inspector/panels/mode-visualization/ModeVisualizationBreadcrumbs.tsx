"use client";

import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { buildModeVisualizationBreadcrumbs } from "./ModeVisualizationBreadcrumbs.model";

export function ModeVisualizationBreadcrumbs({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const breadcrumbs = buildModeVisualizationBreadcrumbs(selection);
  if (breadcrumbs.length === 0) return null;
  return (
    <nav
      aria-label="Mode visualization path"
      className="fm-inspector__breadcrumbs"
    >
      {breadcrumbs.map((breadcrumb, index) => (
        <span className="fm-inspector__breadcrumb-item" key={breadcrumb.id}>
          {index > 0 ? (
            <span aria-hidden="true" className="fm-inspector__breadcrumb-separator">
              /
            </span>
          ) : null}
          {breadcrumb.current ? (
            <span className="fm-inspector__breadcrumb">{breadcrumb.label}</span>
          ) : (
            <Button
              className="fm-inspector__breadcrumb"
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => kernel.selection.set(breadcrumb.selection, "inspector")}
            >
              {breadcrumb.label}
            </Button>
          )}
        </span>
      ))}
    </nav>
  );
}

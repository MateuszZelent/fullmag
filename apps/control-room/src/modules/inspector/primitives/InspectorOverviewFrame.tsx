import type { ReactNode } from "react";
import { Box } from "lucide-react";

import type { InspectorMetric, InspectorMetricStripProps } from "./InspectorMetricStrip";
import { InspectorGroup } from "./InspectorGroup";
import { InspectorMetricStrip } from "./InspectorMetricStrip";

/**
 * A semantic navigation section used by overview inspectors. The frame owns
 * the responsive shell; the section content remains family-specific.
 */
export interface InspectorOverviewSection {
  content: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
  id: string;
  summary?: string;
  title: string;
}

export interface InspectorOverviewFrameProps {
  actions?: ReactNode;
  className?: string;
  /** Existing family-specific navigation groups that already own their shell. */
  leadingSections?: ReactNode;
  metrics: InspectorMetricStripProps["metrics"];
  primary: ReactNode;
  primaryClassName?: string;
  primaryIcon?: ReactNode;
  primaryTitle?: string;
  sections: readonly InspectorOverviewSection[];
  sectionsClassName?: string;
}

/**
 * Shared compact overview composition for Visualization and Physics.
 *
 * This component deliberately does not know about a solver or a viewport.
 * It only provides the four-metric strip, one bordered primary card, and
 * keyboard-accessible navigation groups shared by Inspector surfaces.
 */
export function InspectorOverviewFrame({
  actions,
  className,
  leadingSections,
  metrics,
  primary,
  primaryClassName,
  primaryIcon = <Box size={18} strokeWidth={1.5} />,
  primaryTitle = "Overview",
  sections,
  sectionsClassName,
}: InspectorOverviewFrameProps) {
  return (
    <div
      className={`fm-inspector-overview-frame grid min-w-0 gap-3 [container-type:inline-size]${className ? ` ${className}` : ""}`}
      data-slot="inspector-overview-frame"
    >
      <InspectorMetricStrip metrics={metrics} />

      <div
        className={`fm-inspector-overview-frame__primary${primaryClassName ? ` ${primaryClassName}` : ""}`}
        data-slot="inspector-overview-primary"
        data-variant="primary"
      >
        <InspectorGroup
          collapsible
          defaultOpen
          icon={primaryIcon}
          title={primaryTitle}
        >
          {primary}
        </InspectorGroup>
      </div>

      <div
        className={`fm-inspector-overview-frame__sections${sectionsClassName ? ` ${sectionsClassName}` : ""}`}
        data-slot="inspector-overview-sections"
      >
        {leadingSections}
        {sections.map((section) => (
          <InspectorGroup
            collapsible
            defaultOpen={section.defaultOpen ?? false}
            icon={section.icon}
            key={section.id}
            summary={section.summary}
            title={section.title}
            variant="nav"
          >
            {section.content}
          </InspectorGroup>
        ))}
      </div>

      {actions ? (
        <div
          aria-label="Inspector overview actions"
          className="fm-inspector-overview-frame__actions"
          data-slot="inspector-overview-actions"
          role="group"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export type InspectorOverviewMetric = InspectorMetric;

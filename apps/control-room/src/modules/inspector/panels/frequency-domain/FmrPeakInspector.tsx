"use client";

import type { ReactNode } from "react";

import { Badge } from "@/shared/ui/Badge";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

export interface FmrPeakDetailSummary {
  absorbedPowerDensity: string;
  actionBadge: string;
  amplitude: string;
  artifactFamily: string;
  badge: string;
  fieldId: string | null;
  fieldPayload: string;
  frequency: string;
  linewidth: string;
  missingSpectralValues: string;
  phase: string;
  provenanceBadge: string;
  source: string;
  sourceBadge: string;
  sourceInspectorLabel: string;
  spectralBadge: string;
  target: string;
  validation: string;
  visualizationReadiness: string;
}

interface FmrPeakInspectorProps {
  actions: ReactNode;
  summary: FmrPeakDetailSummary;
}

export function FmrPeakInspector({
  actions,
  summary,
}: FmrPeakInspectorProps) {
  return (
    <div
      data-inspector-owner="frequency-domain.fmr-peak"
      data-inspector-surface="fmr-peak"
    >
      <InspectorGroup title="Identity" badge={summary.badge}>
        <div className="fm-frequency-domain-active-peak">
          <div className="fm-frequency-domain-active-peak__header">
            <h4>{summary.frequency}</h4>
            <Badge variant="secondary">
              {summary.sourceBadge}
            </Badge>
          </div>
          <FieldRow label="Frequency" value={summary.frequency} />
          <FieldRow label="Physical source" value={summary.source} />
          <FieldRow label="Canonical target" value={summary.target} />
        </div>
      </InspectorGroup>
      <InspectorGroup
        title="Physical Quantities"
        badge={summary.spectralBadge}
      >
        <FieldRow label="Amplitude" value={summary.amplitude} />
        <FieldRow
          label="Absorbed power density"
          value={summary.absorbedPowerDensity}
        />
        <FieldRow label="Phase" value={summary.phase} />
        <FieldRow label="Linewidth" value={summary.linewidth} />
      </InspectorGroup>
      <InspectorGroup title="Provenance" badge={summary.provenanceBadge}>
        <FieldRow label="Source surface" value={summary.sourceInspectorLabel} />
        <FieldRow label="Source artifact" value={summary.artifactFamily} />
        <FieldRow label="Source target" value={summary.target} />
      </InspectorGroup>
      <InspectorGroup title="Visualization" badge={summary.actionBadge}>
        <FieldRow label="Field ID" value={summary.fieldId ?? "not available"} />
        <FieldRow label="Field payload" value={summary.fieldPayload} />
        <FieldRow label="Default field view" value="phase-rotated real" />
        <FieldRow
          label="Display controls"
          value="shared mode-field controls: component, real/imag/magnitude, colormap, vectors, shader, phase"
        />
        <FieldRow
          label="Volume controls"
          value="clip, opacity, and shader controls belong to the shared field-display profile"
        />
        {actions}
      </InspectorGroup>
      <InspectorGroup title="Diagnostics" badge={summary.validation}>
        <FieldRow label="Validation" value={summary.validation} />
        <FieldRow label="Missing values" value={summary.missingSpectralValues} />
        <FieldRow
          label="Plot readiness"
          value={summary.visualizationReadiness}
        />
      </InspectorGroup>
    </div>
  );
}

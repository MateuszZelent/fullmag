"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";
import { resolveRegionDiagnosticsForLane } from "./regionDiagnosticPresentation";

export interface ObjectRegionDiagnosticsLaneView {
  realizationPolicy: string;
  realizationStatus: string;
}

export function resolveObjectRegionDiagnosticsLaneView(
  model: Pick<RegionSubPanelProps["model"], "realizationPolicy" | "realizationStatus">,
  meshLane: RegionSubPanelProps["meshLane"] = "unknown",
): ObjectRegionDiagnosticsLaneView {
  if (meshLane === "fdm") {
    return {
      realizationPolicy: "Not applicable for FDM structured-grid regions",
      realizationStatus: "Runtime-derived structured-grid membership",
    };
  }
  if (meshLane !== "fem") {
    return {
      realizationPolicy: "Withheld until the session discretization is explicit",
      realizationStatus: "Withheld until the session discretization is explicit",
    };
  }
  return {
    realizationPolicy: model.realizationPolicy ?? "inherit",
    realizationStatus: model.realizationStatus ?? "authored",
  };
}

export function ObjectRegionDiagnosticsPanel({ model, meshLane = "unknown" }: RegionSubPanelProps) {
  const laneView = resolveObjectRegionDiagnosticsLaneView(model, meshLane);
  const diagnostics = resolveRegionDiagnosticsForLane(model.diagnostics, meshLane);
  const withheldDiagnosticCount = model.diagnostics.length - diagnostics.length;
  const warningCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity.toLowerCase() === "warning",
  ).length;
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity.toLowerCase() === "error",
  ).length;
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} meshLane={meshLane} />

      <InspectorGroup title="Diagnostics">
        <FieldRow label="Mode" value={model.mode} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow
          label="Realization policy"
          value={laneView.realizationPolicy}
        />
        <FieldRow label="Realization status" value={laneView.realizationStatus} />
        <FieldRow label="Scene revision" value={model.revision ?? "unknown"} />
        <FieldRow label="Region diagnostics" value={String(diagnostics.length)} />
        <FieldRow label="Warnings" value={String(warningCount)} />
        <FieldRow label="Errors" value={String(errorCount)} />
        {withheldDiagnosticCount > 0 && meshLane === "fdm" ? (
          <FieldRow
            label="FEM capability diagnostics"
            value="Not applicable for FDM structured-grid regions"
          />
        ) : null}
        {withheldDiagnosticCount > 0 && meshLane === "unknown" ? (
          <FieldRow
            label="FEM capability diagnostics"
            value="Withheld until the session discretization is explicit"
          />
        ) : null}

        {diagnostics.length === 0 ? (
          <div className="fm-mt-3">
            <FieldRow label="Messages" value="none" />
          </div>
        ) : (
          <div className="fm-mt-4">
            {diagnostics.map((diagnostic) => (
              <div
                key={diagnostic.diagnosticId}
                className="fm-region-diagnostic-item fm-section-separator fm-mb-3"
              >
                <FieldRow label="Severity" value={diagnostic.severity} />
                <FieldRow label="Message" value={`${diagnostic.code}: ${diagnostic.message}`} />
                {diagnostic.capabilityGate && (
                  <div className="fm-mt-2">
                    <FeedbackBanner
                      kind="warning"
                      message={`Gated by capability: '${diagnostic.capabilityGate}'. This regional parameter may be blocked or ignored by the active solver backend.`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </InspectorGroup>
    </div>
  );
}

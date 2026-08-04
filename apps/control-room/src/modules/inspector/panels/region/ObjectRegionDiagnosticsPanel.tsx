"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionDiagnosticsPanel({ model, meshLane = "unknown" }: RegionSubPanelProps) {
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} meshLane={meshLane} />

      <InspectorGroup title="Diagnostics">
        <FieldRow label="Mode" value={model.mode} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow
          label="Realization policy"
          value={
            meshLane === "fdm"
              ? "Not applicable for FDM structured-grid regions"
              : model.realizationPolicy ?? "inherit"
          }
        />
        <FieldRow
          label="Realization status"
          value={model.realizationStatus ?? "authored"}
        />
        <FieldRow label="Scene revision" value={model.revision ?? "unknown"} />
        <FieldRow label="Region diagnostics" value={String(model.diagnosticCount)} />
        <FieldRow label="Warnings" value={String(model.warningCount)} />
        <FieldRow label="Errors" value={String(model.errorCount)} />
        
        {model.diagnostics.length === 0 ? (
          <div className="fm-mt-3">
            <FieldRow label="Messages" value="none" />
          </div>
        ) : (
          <div className="fm-mt-4">
            {model.diagnostics.map((diagnostic) => (
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

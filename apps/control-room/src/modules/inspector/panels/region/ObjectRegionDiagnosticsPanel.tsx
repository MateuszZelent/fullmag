"use client";

import { Accordion } from "@/shared/ui/Accordion";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionDiagnosticsPanel({ model }: RegionSubPanelProps) {
  const sections = ["regions", "diagnostics"];

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      <ObjectRegionMetadataSection model={model} />

      <InspectorSection value="diagnostics" title="Diagnostics">
        <FieldRow label="Mode" value={model.mode} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow
          label="Realization policy"
          value={model.realizationPolicy ?? "inherit"}
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
          <div style={{ marginTop: "12px" }}>
            <FieldRow label="Messages" value="none" />
          </div>
        ) : (
          <div style={{ marginTop: "16px" }}>
            {model.diagnostics.map((diagnostic) => (
              <div
                key={diagnostic.diagnosticId}
                className="fm-region-diagnostic-item"
                style={{
                  marginBottom: "16px",
                  paddingBottom: "12px",
                  borderBottom: "1px solid var(--fm-border, #eee)",
                }}
              >
                <FieldRow label="Severity" value={diagnostic.severity} />
                <FieldRow label="Message" value={`${diagnostic.code}: ${diagnostic.message}`} />
                {diagnostic.capabilityGate && (
                  <div style={{ marginTop: "8px" }}>
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
      </InspectorSection>
    </Accordion>
  );
}

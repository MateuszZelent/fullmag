"use client";

import { useMemo } from "react";

import { useFdmMultilayerLayoutResource } from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  resolveFdmMultilayerAirboxTargetInspectorModel,
  type FdmMultilayerAirboxTargetInspectorModel,
} from "./fdmMultilayerAirboxTargetInspectorModel";

function InspectorRows({
  rows,
}: {
  rows: Exclude<FdmMultilayerAirboxTargetInspectorModel, { status: "unavailable" }>["targetGridRows"];
}) {
  return rows.map((row) => (
    <FieldRow key={row.label} label={row.label} mono={row.mono} unit={row.unit} value={row.value} />
  ));
}

export function FdmMultilayerAirboxTargetPanelView({
  model,
}: {
  model: FdmMultilayerAirboxTargetInspectorModel;
}) {
  if (model.status === "unavailable") {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" data-fdm-multilayer-airbox-status="unavailable">
        <FeedbackBanner kind="warning" message={model.notice} />
        <InspectorGroup title="Multilayer H_demag target" badge="not published">
          <FieldRow label="State" value="unavailable" />
        </InspectorGroup>
      </div>
    );
  }
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" data-fdm-multilayer-airbox-status="ready">
      <InspectorGroup
        title="Target grid"
        badge="H_demag"
        description="Certified target-only observation grid; not the common FFT scratch layout."
      >
        <InspectorRows rows={model.targetGridRows} />
      </InspectorGroup>
      <InspectorGroup title="Field capability" badge="published">
        <InspectorRows rows={model.fieldCapabilityRows} />
      </InspectorGroup>
      <InspectorGroup title="Carrier provenance" badge="revisioned">
        <InspectorRows rows={model.provenanceRows} />
      </InspectorGroup>
    </div>
  );
}

export function FdmMultilayerAirboxTargetPanel({ selection }: InspectorPanelProps) {
  const layout = useFdmMultilayerLayoutResource({
    enabled: selection.kind === "airbox.multilayer.target",
  });
  const model = useMemo(
    () => resolveFdmMultilayerAirboxTargetInspectorModel(layout.data),
    [layout.data],
  );
  return <FdmMultilayerAirboxTargetPanelView model={model} />;
}

"use client";

import { Accordion } from "@/shared/ui/Accordion";
import { useMeshUniverseQualityResource } from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorSection } from "../../primitives/InspectorSection";
import { buildAirboxMeshInspectorModel } from "./airboxMeshInspectorModel";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";

export function AirboxMeshQualityGatesPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const quality = useMeshUniverseQualityResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const model = buildAirboxMeshInspectorModel({
    manifest: null,
    policy: { config: null, effective_config: null, revision: quality.data?.revision ?? 0 },
    quality: quality.data ?? null,
    report: null,
    summary: null,
  });

  return (
    <Accordion className="fm-inspector-panel" type="multiple" defaultValue={["quality-gates"]}>
      <InspectorSection value="quality-gates" title="Airbox Quality Gates" badge={model.qualityGates.status}>
        <FieldRow label="Airbox-scoped result" value={model.qualityGates.status} />
        <FieldRow label="Reason" value={model.qualityGates.reason} />
        <FieldRow label="Evidence" value={model.qualityGates.evidence} />
        <FieldRow
          label="Global shared-domain quality"
          value={quality.data?.quality ? "available as cross-reference only" : "not available"}
        />
      </InspectorSection>
      <InspectorSection value="structural" title="Structural Checks" badge="ui-derived">
        <FieldRow label="Evidence" value="ui-derived" />
        <FieldRow label="Scope" value="Structural availability only; not an Airbox quality pass/fail." />
      </InspectorSection>
    </Accordion>
  );
}

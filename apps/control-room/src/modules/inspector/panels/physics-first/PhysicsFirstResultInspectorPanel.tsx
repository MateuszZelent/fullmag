import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { physicsFirstResultInspectorModel } from "./physicsFirstResultInspectorModel";

export function PhysicsFirstResultInspectorPanel({ selection }: InspectorPanelProps) {
  const model = physicsFirstResultInspectorModel(selection.kind ?? "");
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  if (!model) {
    return (
      <InspectorGroup title="Unsupported result">
        <FieldRow label="Kind" value={selection.kind} mono />
        <FieldRow label="Reason" value="No physics-first panel model owns this selection." />
      </InspectorGroup>
    );
  }

  return (
    <>
      <InspectorGroup title={model.title} description={model.description}>
        <FieldRow label="Product" value={ref?.studyProduct ?? "Not applicable"} />
        <FieldRow label="k context" value={ref?.kContextKind ?? "Not applicable"} />
      </InspectorGroup>
      <InspectorGroup title="Result owner">
        <FieldRow label="Run" value={ref?.analysisRunId ?? "Unavailable"} mono />
        <FieldRow label="Stage" value={ref?.analysisStageId ?? "Unavailable"} mono />
        <FieldRow label="Equilibrium" value={ref?.equilibriumId ?? "Unavailable"} mono />
        <FieldRow label="Artifact revision" value={ref?.artifactRevision ?? "Unavailable"} mono />
      </InspectorGroup>
      <InspectorGroup title="Availability">
        <FieldRow
          label="Contract"
          value={ref ? "Typed result reference" : "Result owner unavailable"}
          status={ref ? "ready" : "unavailable"}
        />
      </InspectorGroup>
    </>
  );
}

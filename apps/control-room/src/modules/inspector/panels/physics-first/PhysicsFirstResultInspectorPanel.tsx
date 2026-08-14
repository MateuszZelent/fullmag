import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
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
    <ScientificInspectorTemplate
      breadcrumbs={["Results", model.physicalLabel]}
      diagnostics={ref ? [] : ["Typed result owner is unavailable; visualization and comparison are disabled."]}
      methodLabel={model.methodLabel}
      physicalLabel={model.physicalLabel}
      properties={[
        { label: "Product", value: ref?.studyProduct ?? "Not applicable" },
        { label: "k context", value: ref?.kContextKind ?? "Not applicable" },
        ...(ref?.resourceRef
          ? [{ label: "Dataset / resource", mono: true, value: ref.resourceRef }]
          : []),
        { label: "Meaning", value: model.description },
      ]}
      provenance={[
        { label: "Run", mono: true, value: ref?.analysisRunId ?? "Unavailable" },
        { label: "Stage", mono: true, value: ref?.analysisStageId ?? "Unavailable" },
        { label: "Equilibrium", mono: true, value: ref?.equilibriumId ?? "Unavailable" },
        ...(ref?.normalization ? [{ label: "Normalization", mono: true, value: ref.normalization }] : []),
        { label: "Artifact revision", mono: true, value: ref?.artifactRevision ?? "Unavailable" },
      ]}
      status={{
        availability: ref ? "available" : "unavailable",
        execution: ref ? "completed" : "unknown",
        resource: ref ? "ready" : "unavailable",
      }}
      title={selection.label || model.title}
    />
  );
}

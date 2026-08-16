import type { ReactNode } from "react";

import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { physicsFirstResultInspectorModel } from "./physicsFirstResultInspectorModel";

interface PhysicsFirstResultInspectorFrameProps {
  children?: ReactNode;
  selection: InspectorPanelProps["selection"];
}

export function PhysicsFirstResultInspectorFrame({
  children,
  selection,
}: PhysicsFirstResultInspectorFrameProps) {
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

  const diagnostics = ref
    ? [
        ...(ref.contractGap ? [ref.contractGap] : []),
        ...(ref.availability === "unsupported"
          ? ["This result product is not supported by the published runtime contract."]
          : []),
        ...(ref.availability === "unavailable"
          ? ["The typed result resource is currently unavailable."]
          : []),
      ]
    : ["Typed result owner is unavailable; visualization and comparison are disabled."];

  return (
    <ScientificInspectorTemplate
      breadcrumbs={["Results", model.physicalLabel]}
      diagnostics={diagnostics}
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
        availability: ref?.availability ?? "unavailable",
        execution: ref?.executionState ?? "unknown",
        resource: ref?.resourceState ?? "unavailable",
      }}
      title={selection.label || model.title}
    >
      {children}
    </ScientificInspectorTemplate>
  );
}

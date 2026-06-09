"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function EigenmodesStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="eigenmodes"
        kindLabel="Eigenmodes"
      />
      <InspectorSection
        value="eigenmodes-problem"
        title="Eigenproblem"
        badge={draft?.target ?? "target"}
      >
        <FieldRow label="Mode count" value={draft?.count ?? "not set"} />
        <FieldRow
          label="Target"
          value={draft?.target ?? "not set"}
        />
        <FieldRow
          label="Target frequency"
          value={draft?.targetFrequency || "not set"}
        />
        <FieldRow label="Normalization" value={draft?.normalization ?? "not set"} />
      </InspectorSection>
      <InspectorSection value="eigenmodes-linearization" title="Linearization State">
        <FieldRow
          label="Equilibrium source"
          value={draft?.equilibriumSource ?? "not set"}
        />
        <FieldRow
          label="Equilibrium artifact"
          value={draft?.equilibriumArtifact || "not set"}
        />
        <FieldRow label="Damping policy" value={draft?.dampingPolicy ?? "not set"} />
        <FieldRow label="Include demag" value={draft?.includeDemag ? "yes" : "no"} />
      </InspectorSection>
      <InspectorSection value="eigenmodes-wavevector" title="Spin-Wave Sampling">
        <FieldRow label="Boundary condition" value={draft?.bc || "free"} />
        <FieldRow label="k vector" value={draft?.kVector || "not set"} />
        <FieldRow label="k sampling" value={draft?.kSampling || "not set"} />
      </InspectorSection>
      <InspectorSection value="eigenmodes-results" title="Eigenmode Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Computed modes"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow
          label="Artifacts"
          value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
        />
      </InspectorSection>
    </>
  );
}

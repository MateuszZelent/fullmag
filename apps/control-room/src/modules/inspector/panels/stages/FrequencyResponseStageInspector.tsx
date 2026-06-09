"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function FrequencyResponseStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="frequency_response"
        kindLabel="Frequency Response"
      />
      <InspectorSection
        value="frequency-response-sweep"
        title="Frequency Sweep"
        badge={draft?.observable ?? "observable"}
      >
        <FieldRow
          label="Frequencies"
          value={draft?.frequenciesHz ?? "not set"}
        />
        <FieldRow
          label="Excitation"
          value={draft?.excitationField ?? "not set"}
        />
        <FieldRow
          label="Observable"
          value={draft?.observable ?? "not set"}
        />
      </InspectorSection>
      <InspectorSection
        value="frequency-response-linearization"
        title="Linearization State"
      >
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
      <InspectorSection value="frequency-response-wavevector" title="Spin-Wave Sampling">
        <FieldRow label="Boundary condition" value={draft?.bc || "free"} />
        <FieldRow label="k vector" value={draft?.kVector || "not set"} />
        <FieldRow label="k sampling" value={draft?.kSampling || "not set"} />
      </InspectorSection>
      <InspectorSection value="frequency-response-results" title="Frequency Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Computed response"
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

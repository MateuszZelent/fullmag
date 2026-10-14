"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";
import { antennaFieldSolvePortReferences } from "../StudyStageAuthoringModel";
import { antennaFieldSolveDefinitionPortError } from "@/shared/domain/study/antennaFieldSolveCapability";

export function AntennaFieldSolveStageInspector(props: StageInspectorFrameProps) {
  const raw = props.draft?.kind === "antenna_field_solve" ? props.draft.rawStage : null;
  const definitionId = typeof raw?.stage_id === "string" ? raw.stage_id : null;
  const matches = (props.scene?.antenna_field_solve_stages ?? [])
    .filter((definition) => definition.id === definitionId);
  const definition = matches.length === 1 ? matches[0] : null;
  const capabilityError = definition ? antennaFieldSolveDefinitionPortError(definition.port_mode_ids) : null;
  const authoredPorts = antennaFieldSolvePortReferences(raw ?? undefined);
  const selectedPorts = (props.scene?.antenna_port_modes ?? [])
    .filter((port) => port.id === authoredPorts[0]);
  const portsMatch = definition && authoredPorts.length === 1
    && definition.port_mode_ids.filter((id) => id === authoredPorts[0]).length === 1
    && selectedPorts.length === 1 && selectedPorts[0].source_object_id === definition.source_object_id
    && selectedPorts[0].current_transport_id === definition.current_transport_id;

  return (
    <>
      <StageInspectorFrame {...props} />
      <InspectorGroup title="Antenna Definition Reference" badge="one-way source solve">
        <FieldRow label="Definition ID" value={definitionId ?? "missing explicit reference"} mono />
        <FieldRow label="Source object ID" value={definition?.source_object_id ?? "unresolved"} mono />
        <FieldRow label="Current transport ID" value={definition?.current_transport_id ?? "unresolved"} mono />
        <FieldRow label="Selected port IDs" value={authoredPorts.join(", ") || "none"} mono />
        {!definition || !portsMatch ? (
          <FeedbackBanner kind="error" message="The field-solve definition is missing, ambiguous, or its selected ports no longer match. Repair the antenna references before execution." />
        ) : null}
        {capabilityError ? <FeedbackBanner kind="error" message={capabilityError} /> : null}
        <FieldRow label="Model" value={definition?.model ?? "unresolved"} mono />
        <FieldRow label="Oersted realization" value={definition?.oersted_realization ?? "unresolved"} mono />
        <FieldRow label="Solver policy" value={definition?.solver_policy ?? "unresolved"} />
        <FieldRow label="Declared outputs" value={definition?.outputs.map((output) => `${output.id}: ${output.quantity}`).join(", ") || "none"} />
        <FieldRow label="Parameter owner" value="Antenna → field-solve definition / current transport / ports" />
        <FeedbackBanner kind="warning" message="A declared stage or output is not a solved field or a physical qualification. Preparation, source ownership and result integrity must pass before using V/J/H; reusable per-ampere fields and LLG/FFT coupling require separate qualification." />
      </InspectorGroup>
    </>
  );
}

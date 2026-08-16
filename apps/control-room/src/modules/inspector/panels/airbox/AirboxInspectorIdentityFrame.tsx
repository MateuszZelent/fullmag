import type { ReactNode } from "react";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { AirboxInspectorLane } from "./airboxInspectorRuntimeStatus";

const TITLES: Readonly<Record<string, string>> = {
  "airbox.root": "Airbox",
  "airbox.mesh": "Airbox Mesh",
  "airbox.mesh.build": "Airbox Mesh Build",
  "airbox.mesh.parameters": "Airbox Mesh Parameters",
  "airbox.mesh.quality-gates": "Airbox Mesh Quality Gates",
  "airbox.mesh.statistics": "Airbox Mesh Statistics",
  "airbox.mesh.topology": "Airbox Mesh Topology",
  "airbox.multilayer.target": "Multilayer Airbox Target",
};

function laneLabel(lane: AirboxInspectorLane): string {
  if (lane === "fdm") return "FDM structured grid";
  if (lane === "fem") return "FEM shared-domain mesh";
  return "runtime lane conflict";
}

function statusForSelection(selection: Selection, lane: AirboxInspectorLane) {
  const ref = selection.ref?.type === "airbox" ? selection.ref : null;
  return {
    availability: ref?.availability ?? (lane === "conflict" ? "unsupported" : "unknown"),
    execution: ref?.executionState ?? "unknown",
    resource: ref?.resourceState ?? "unknown",
  };
}

function diagnosticsForSelection(selection: Selection, lane: AirboxInspectorLane): string[] {
  const ref = selection.ref?.type === "airbox" ? selection.ref : null;
  return [
    ...(ref?.contractGap ? [ref.contractGap] : []),
    ...(lane === "conflict"
      ? ["The selected Airbox target does not match the current runtime lane."]
      : []),
  ];
}

export function AirboxInspectorIdentityFrame({
  children,
  lane,
  owner = "airbox-inspector",
  selection,
}: InspectorPanelProps & {
  children: ReactNode;
  lane: AirboxInspectorLane;
  owner?: string;
}) {
  const ref = selection.ref?.type === "airbox" ? selection.ref : null;
  const status = statusForSelection(selection, lane);
  const title = TITLES[selection.kind ?? ""] ?? "Airbox Inspector";
  const target = ref?.visualizationTargetId ?? "airbox";

  return (
    <div className="fm-airbox-inspector-frame" data-inspector-owner={owner}>
      <ScientificInspectorTemplate
        breadcrumbs={["Model", "Airbox", title]}
        diagnostics={diagnosticsForSelection(selection, lane)}
        methodLabel={laneLabel(lane)}
        physicalLabel="Airbox"
        properties={[
          { label: "Target", mono: true, value: target },
          { label: "Inspector kind", mono: true, value: selection.kind },
          { label: "Runtime lane", value: lane },
        ]}
        provenance={[
          { label: "Explorer node", mono: true, value: selection.nodeId },
          { label: "Selection source", value: selection.moduleSource },
        ]}
        status={status}
        title={selection.label || title}
      >
        {children}
      </ScientificInspectorTemplate>
    </div>
  );
}

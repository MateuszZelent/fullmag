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
  if (lane === "conflict") return "runtime lane conflict";
  return "runtime lane unresolved";
}

function statusForSelection(
  selection: Selection,
  lane: AirboxInspectorLane,
  artifactLane: "fem" | "fdm" | null,
) {
  const ref = selection.ref?.type === "airbox" ? selection.ref : null;
  return {
    availability:
      ref?.availability ??
      (lane === "conflict"
        ? "unsupported"
        : artifactLane
          ? "partial"
          : lane === "unresolved"
            ? "unavailable"
            : "unknown"),
    execution: ref?.executionState ?? (lane === "unresolved" ? "not_started" : "unknown"),
    resource: ref?.resourceState ?? (artifactLane ? "loading" : lane === "unresolved" ? "idle" : "unknown"),
  };
}

function diagnosticsForSelection(
  selection: Selection,
  lane: AirboxInspectorLane,
  runtimeReason: string | null,
  artifactLane: "fem" | "fdm" | null,
): string[] {
  const ref = selection.ref?.type === "airbox" ? selection.ref : null;
  return [
    ...(ref?.contractGap ? [ref.contractGap] : []),
    ...(lane === "conflict"
      ? ["The selected Airbox target does not match the current runtime lane."]
      : []),
    ...(lane === "unresolved"
      ? [runtimeReason ?? (artifactLane
          ? "Runtime lane remains unresolved. FEM topology inspection is read-only and does not enable build or solve."
          : "Runtime lane is unresolved; mesh execution facts and build actions are pending backend resolution.")]
      : []),
  ];
}

export function AirboxInspectorIdentityFrame({
  children,
  artifactLane = null,
  lane,
  runtimeReason = null,
  owner = "airbox-inspector",
  selection,
}: InspectorPanelProps & {
  children: ReactNode;
  artifactLane?: "fem" | "fdm" | null;
  lane: AirboxInspectorLane;
  runtimeReason?: string | null;
  owner?: string;
}) {
  const ref = selection.ref?.type === "airbox" ? selection.ref : null;
  const status = statusForSelection(selection, lane, artifactLane);
  const title = TITLES[selection.kind ?? ""] ?? "Airbox Inspector";
  const target = ref?.visualizationTargetId ?? "airbox";

  return (
    <div className="fm-airbox-inspector-frame" data-inspector-owner={owner}>
      <ScientificInspectorTemplate
        showIdentity={false}
        breadcrumbs={["Model", "Airbox", title]}
        diagnostics={diagnosticsForSelection(selection, lane, runtimeReason, artifactLane)}
        methodLabel={laneLabel(lane)}
        physicalLabel="Airbox"
        properties={[
          { label: "Method", value: laneLabel(lane) },
          { label: "Target", mono: true, value: target },
          { label: "Inspector kind", mono: true, value: selection.kind },
          { label: "Runtime lane", value: lane },
          ...(artifactLane
            ? [{ label: "Artifact inspection", value: `${artifactLane.toUpperCase()} topology (read-only)` }]
            : []),
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

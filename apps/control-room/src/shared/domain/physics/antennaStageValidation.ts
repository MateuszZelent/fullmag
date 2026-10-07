import type { SceneResource } from "@/kernel/api/apiTypes";

type AntennaSolveStage = NonNullable<SceneResource["antenna_field_solve_stages"]>[number];

function hasCurrentViewContract(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return Array.isArray(view.stable_vertex_ids)
    && view.stable_vertex_ids.length > 0
    && Array.isArray(view.boundary_faces)
    && view.boundary_faces.length > 0
    && Boolean(view.identity && typeof view.identity === "object")
    && Boolean(view.pins && typeof view.pins === "object")
    && Boolean(view.closure && typeof view.closure === "object");
}

export function antennaStageValidationMessages(
  stage: AntennaSolveStage,
  scene: SceneResource | null,
): string[] {
  const messages: string[] = [];
  if (!stage.target_refs?.length) {
    messages.push("field solve requires at least one explicitly authored target");
  }
  if (scene) {
    const transport = (scene.current_transports ?? []).find(
      (candidate) => candidate.name === stage.current_transport_id,
    );
    if (!transport) {
      messages.push(`missing current transport '${stage.current_transport_id}'`);
    } else if (!hasCurrentViewContract(transport.conservative_current_view)) {
      messages.push(`current transport '${stage.current_transport_id}' requires a mesh-exact ConservativeCurrentView before field solve`);
    }
  }
  if (scene) {
    const portModesById = new Map(
      (scene.antenna_port_modes ?? []).map((candidate) => [candidate.id, candidate]),
    );
    for (const portId of stage.port_mode_ids) {
      const port = portModesById.get(portId);
      if (!port) {
        messages.push(`missing port mode '${portId}'`);
        continue;
      }
      if (
        port.source_object_id !== stage.source_object_id ||
        port.current_transport_id !== stage.current_transport_id
      ) {
        messages.push(`port mode '${portId}' is bound to a different source or transport`);
      }
    }
  }
  if (stage.port_mode_ids.length !== 1) {
    messages.push("field solve requires exactly one independently normalized port mode");
  }
  if (stage.outputs.filter((output) => output.quantity === "H_ant_basis").length !== 1) {
    messages.push("stage must publish exactly one H_ant_basis output");
  }
  return messages;
}

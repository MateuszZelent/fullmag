import type { FieldComponent, LiveStatus } from "../../../api/types";
import type { Viewport3DClipState, Viewport3DModel, Viewport3DSelection } from "../contracts";

export interface Viewport3DResourceSnapshot {
  status: Pick<LiveStatus, "resources"> | null;
  quantity_id: string | null;
  component: FieldComponent | null;
  selection?: Partial<Viewport3DSelection> | null;
  clip?: Partial<Viewport3DClipState> | null;
}

export function resourcesToViewportModel(
  snapshot: Viewport3DResourceSnapshot,
): Viewport3DModel {
  return {
    quantity_id: snapshot.quantity_id,
    component: snapshot.component,
    topology_revision: snapshot.status?.resources.topology_revision ?? null,
    field_revision: snapshot.status?.resources.field_revision ?? null,
    selection: {
      object_id: snapshot.selection?.object_id ?? null,
      part_id: snapshot.selection?.part_id ?? null,
    },
    clip: {
      enabled: Boolean(snapshot.clip?.enabled),
      axis: snapshot.clip?.axis ?? "z",
      position: Number.isFinite(snapshot.clip?.position)
        ? Number(snapshot.clip?.position)
        : 0.5,
      invert: Boolean(snapshot.clip?.invert),
    },
  };
}

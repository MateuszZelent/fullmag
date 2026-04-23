import type { FieldComponent } from "../../api/types";

export interface Viewport3DCapabilities {
  can_render_3d: boolean;
  can_show_topology: boolean;
  can_show_structured_grid: boolean;
  can_show_vectors: boolean;
  can_show_scalar_history: boolean;
  algorithms_available: string[];
}

export interface Viewport3DSelection {
  object_id: string | null;
  part_id: string | null;
}

export interface Viewport3DClipState {
  enabled: boolean;
  axis: "x" | "y" | "z";
  position: number;
  invert: boolean;
}

export interface Viewport3DModel {
  quantity_id: string | null;
  component: FieldComponent | null;
  topology_revision: number | null;
  field_revision: number | null;
  selection: Viewport3DSelection;
  clip: Viewport3DClipState;
}

export interface Viewport3DToolbarState {
  quantity_enabled: boolean;
  component_enabled: boolean;
  clip_enabled: boolean;
  render_mode_enabled: boolean;
  reasons: {
    quantity: string | null;
    component: string | null;
    clip: string | null;
    render_mode: string | null;
  };
}

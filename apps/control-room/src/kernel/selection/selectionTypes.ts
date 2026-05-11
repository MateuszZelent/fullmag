import type { ModuleId } from "../types";

export type ObjectSelectionKind =
  | "object.root"
  | "object.geometry"
  | "object.material"
  | "object.physics"
  | "object.mesh"
  | "object.visualization";

export type SelectionRef =
  | {
      kind: ObjectSelectionKind;
      nodeId: string;
      objectId: string;
      type: "scene-object";
      visualizationTargetId: `object:${string}`;
    }
  | {
      kind: "airbox.visualization";
      nodeId: string;
      type: "airbox";
      visualizationTargetId: "airbox";
    };

export interface Selection {
  /** Selected scene object ID (geometry body, mesh region, etc.) */
  objectId: string | null;
  /** Selected explorer tree node ID */
  nodeId: string | null;
  /** Typed semantic kind for inspector and command gating. */
  kind: string | null;
  /** Human-readable selected label for panels and diagnostics. */
  label: string | null;
  /** Discriminated semantic selection ref shared by explorer, inspector, and viewport. */
  ref: SelectionRef | null;
  /** Module that last set the selection */
  moduleSource: ModuleId | null;
}

export const EMPTY_SELECTION: Selection = {
  kind: null,
  label: null,
  objectId: null,
  nodeId: null,
  ref: null,
  moduleSource: null,
};

import type { ModuleId } from "../types";

export interface Selection {
  /** Selected scene object ID (geometry body, mesh region, etc.) */
  objectId: string | null;
  /** Selected explorer tree node ID */
  nodeId: string | null;
  /** Typed semantic kind for inspector and command gating. */
  kind: string | null;
  /** Human-readable selected label for panels and diagnostics. */
  label: string | null;
  /** Module that last set the selection */
  moduleSource: ModuleId | null;
}

export const EMPTY_SELECTION: Selection = {
  kind: null,
  label: null,
  objectId: null,
  nodeId: null,
  moduleSource: null,
};

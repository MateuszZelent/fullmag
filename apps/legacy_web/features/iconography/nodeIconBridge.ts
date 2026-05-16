/**
 * @module iconography/nodeIconBridge
 *
 * A thin helper for tree-builder code that wants to look up the
 * canonical IconToken for a given raw nodeId.
 *
 * Usage:
 *   import { iconForNodeId } from "@/features/iconography/nodeIconBridge";
 *   { id: "phys-llg", label: "LLG Dynamics", icon: iconForNodeId("phys-llg") }
 */

import { resolveNodeHandle } from "../model-builder/registry/nodeHandleResolver";
import { iconForNodeKind } from "./iconRegistry";

/**
 * Resolve a raw `nodeId` to a Lucide icon name (IconToken string).
 *
 * Returns a kebab-case Lucide icon name such as `"activity"` or `"grid-3x3"`.
 * Falls back to `"help-circle"` for unrecognised ids.
 */
export function iconForNodeId(nodeId: string): string {
  const handle = resolveNodeHandle(nodeId);
  return iconForNodeKind(handle.nodeKind).token;
}

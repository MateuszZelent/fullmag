/**
 * @module model-builder
 *
 * Canonical document model, node-handle resolution, inspector routing.
 */

// Types
export type {
  NodeKind,
  NodeDomain,
  NodeScope,
  NodeHandle,
  SourceOfTruth,
  FullmagWorkspaceDocument,
  StudyGraphRef,
  WorkspaceGraphRef,
} from "./types";

// Node-handle resolver
export { resolveNodeHandle, isNodeKindInDomain, nodeKindTopDomain } from "./registry/nodeHandleResolver";

// Inspector registry
export {
  inspectorForNodeKind,
  hasComposite,
  PanelKey,
  type InspectorDescriptor,
  type InspectorPanelProps,
  type InspectorContext,
} from "./registry/inspectorRegistry";

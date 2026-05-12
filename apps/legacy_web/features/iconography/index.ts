/**
 * @module iconography
 *
 * Typed icon system — replaces emoji literals with Lucide icon tokens.
 */

// Icon registry
export {
  iconForNodeKind,
  allIconEntries,
  type IconToken,
  type IconVariant,
  type IconRegistryEntry,
} from "./iconRegistry";

// Bridge: raw nodeId → icon token
export { iconForNodeId } from "./nodeIconBridge";

// React component: renders emoji OR lucide icon
export { default as TreeNodeIcon } from "./TreeNodeIcon";

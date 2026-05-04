/**
 * features/selection — Selection and focus state management
 *
 * Public API for the selection domain store.
 */
export {
  useSelectionStore,
  type SelectionStoreState,
  type SelectionSyncPatch,
  // Selectors
  selectSelectedSidebarNodeId,
  selectSelectedObjectId,
  selectSelectedEntityId,
  selectFocusedEntityId,
  selectViewportScope,
  selectFocusObjectRequest,
} from "./store/useSelectionStore";

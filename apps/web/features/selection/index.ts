/**
 * features/selection — Selection and focus state management
 *
 * Public API for the selection domain store.
 */
export {
  useSelectionStore,
  type SelectionStoreState,
  // Selectors
  selectSelectedSidebarNodeId,
  selectSelectedObjectId,
  selectSelectedEntityId,
  selectFocusedEntityId,
  selectViewportScope,
  selectFocusObjectRequest,
} from "./store/useSelectionStore";
export {
  useSelectedSidebarNodeId,
  useSelectedObjectId,
  useSelectedEntityId,
  useFocusedEntityId,
  useViewportScopeSelection,
  useFocusObjectRequest,
  useSelectionState,
  useSelectionActions,
} from "./hooks/useSelectionSlice";

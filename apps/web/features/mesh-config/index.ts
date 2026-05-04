/**
 * features/mesh-config — Mesh configuration state management
 *
 * Public API for the mesh config domain store.
 */
export {
  useMeshConfigStore,
  type MeshConfigStoreState,
  type MeshConfigSyncPatch,
  // Selectors
  selectMeshOptionsState,
  selectMeshGenerating,
  selectLastBuiltMeshConfigSignature,
  selectMeshSelection,
} from "./store/useMeshConfigStore";

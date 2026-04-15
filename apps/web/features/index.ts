/**
 * features/ barrel export
 *
 * Single import point for all new architectural modules.
 * Components migrating away from useControlRoom() import from here.
 */

/* Layer A: App Shell */
export {
  useWorkspaceShellStore,
  useStageLayout,
} from "./app-shell/state/useWorkspaceShellStore";

/* Layer B: Session Runtime */
export {
  useSessionRuntimeStore,
  selectConnection,
  selectWorkspaceStatus,
  selectIsFemBackend,
  selectLiveState,
  selectFemMesh,
  type SessionRuntimeSnapshot,
  type ConnectionStatus,
} from "./session-runtime";
export { classifyApiError, isRetryableError } from "./session-runtime";

/* Layer C: Study Authoring */
export {
  useAuthoringStore,
  type AuthoringState,
  type DraftSyncStatus,
} from "./study-authoring";
export { DraftSyncController } from "./study-authoring";
export * as authoringCommands from "./study-authoring/commands";
export { AddStudyDialog, AddStageDialog } from "./study-authoring";
export type {
  StagePythonProjection,
  PythonArgValue,
  StudyPythonProjection,
  WorkspacePythonProjection,
  UniverseSetupProjection,
} from "./study-authoring";

/* Layer D: Viewport Core */
export {
  useViewportStore,
  selectInteraction,
  selectCamera,
  selectViewMode,
  selectFemRenderSettings,
  selectViewportScope,
  routeInput,
  type InteractionMode,
  type CameraProfile,
  type InputEvent,
} from "./viewport-core";
export { ViewportHost, ViewportRouter } from "./viewport-core";
export type { ViewportHostProps, ComponentKeyRenderer } from "./viewport-core";

/* Layer D: FEM Viewport Engine */
export {
  buildPartRenderDataCache,
  buildVisibleLayers,
  buildMagneticArrowNodeMask,
  type PartRenderData,
  type RenderLayer,
  type BuildVisibleLayersInput,
} from "./viewport-fem";

/* Layer E: Diagnostics */
export {
  DIAGNOSTIC_PROFILES,
  applyDiagnosticProfile,
  type DiagnosticProfileId,
} from "./diagnostics";
export {
  requestCounters,
  renderCounters,
  incrementCounter,
  readCounter,
  dumpCounters,
} from "./diagnostics/events/counters";

/* Layer F: Analyze Query Layer */
export {
  useAnalyzeStore,
  useAnalyzeSelection,
  useAnalyzeQuery,
  useAnalyzeQueryKey,
  fetchAnalyzeArtifact,
  abortAllAnalyzeRequests,
  type AnalyzeTab,
  type AnalyzeDomain,
  type AnalyzeQueryKey,
  type AnalyzeQueryState,
} from "./analyze";
export { ResultsAuthoringShell } from "./analyze";
export type { ResultsAuthoringShellProps, ResultTemplateEntry, ResultTemplateCategory } from "./analyze";
export {
  registerResultTemplate,
  getResultTemplate,
  getAllResultTemplates,
  getResultTemplatesByCategory,
  resultLabel,
  resultIconToken,
} from "./analyze";

/* Viewport-FDM */
export {
  type FdmGridModel,
  type FdmRenderState,
  DEFAULT_FDM_RENDER_STATE,
} from "./viewport-fdm";

/* Notifications */
export {
  useNotificationStore,
  type Notification,
  type NotificationLevel,
} from "./notifications";

/* Layer H: Workspace Graph */
export {
  useWorkspaceGraphStore,
  createWorkspaceGraphSnapshot,
  useWorkspaceGraphBridge,
  EMPTY_WORKSPACE_GRAPH,
  selectWorkspaceGraph,
  selectGraphResultsWorkspace,
  selectGraphViewportDocuments,
  selectGraphActiveViewportDocument,
} from "./workspace-graph";
export type {
  WorkspaceGraphState,
  WorkspaceGraphPatch,
  ViewportDocumentState,
  DatasetNodeRef,
  SolutionNode as WorkspaceGraphSolutionNode,
  DerivedValueNodeRef,
  QuantityFrameViewModel,
} from "./workspace-graph";

/* Transport Metrics */
export {
  getTransportMetrics,
  resetTransportMetrics,
} from "./session-runtime/transport/transportMetrics";

/* Layer G: Model Builder (Canonical Document Model + Inspector Registry) */
export type {
  NodeKind,
  NodeDomain as BuilderNodeDomain,
  NodeScope,
  NodeHandle,
  SourceOfTruth,
  FullmagWorkspaceDocument,
} from "./model-builder";
export {
  resolveNodeHandle,
  isNodeKindInDomain,
  nodeKindTopDomain,
  inspectorForNodeKind,
  hasComposite,
  PanelKey,
} from "./model-builder";

/* Layer G: Iconography (Registry-based icon system) */
export {
  iconForNodeKind,
  iconForNodeId,
  TreeNodeIcon,
  type IconToken,
  type IconRegistryEntry,
} from "./iconography";

/* Layer G: Shell (Ribbon Registry) */
export {
  registerRibbonContribution,
  resolveRibbonGroups,
  resolveContextualGroups,
  suggestedTabForDomain,
  type RibbonContribution,
  type RibbonBuildContext,
} from "./shell";

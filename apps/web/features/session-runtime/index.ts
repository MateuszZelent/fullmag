export type { SessionRuntimeSnapshot, SessionEvent, ConnectionStatus } from "./model/sessionRuntime.types";
export { deriveSessionReadModel } from "./model/deriveSessionReadModel";
export type { NormalizedSessionState } from "./model/deriveSessionReadModel";
export { useSessionRuntimeBridge } from "./hooks/useSessionRuntimeBridge";
export { useNewApiBridge } from "./hooks/useNewApiBridge";
export { useDataPlaneBridge } from "./hooks/useDataPlaneBridge";
export {
  useSessionRuntimeStore,
  selectConnection,
  selectWorkspaceStatus,
  selectIsFemBackend,
  selectSession,
  selectRun,
  selectLiveState,
  selectFemMesh,
  selectPreview,
  selectCommandStatus,
  selectRuntimeStatus,
  selectScalarRows,
  selectEngineLog,
  selectQuantities,
  selectArtifacts,
  selectScriptBuilder,
  selectMeshWorkspace,
} from "./store/useSessionRuntimeStore";
export { classifyApiError, isRetryableError } from "./api/apiErrorMapper";
export type { ClassifiedError, ErrorClassification } from "./api/apiErrorMapper";
export {
  BootstrapCache,
  computeBackoffDelay,
  DEFAULT_RECONNECT_POLICY,
} from "./transport/SessionConnectionOrchestrator";
export type { ReconnectPolicy } from "./transport/SessionConnectionOrchestrator";

// Transport contract v2 (Layer 10)
export {
  createCommandEnvelope,
  createCommandLifecycle,
  advanceLifecycle,
} from "./transport/transportContract";
export type {
  WorkspaceBootstrapResponse,
  RuntimeSnapshot,
  SolverStatus,
  MeshBuildPhase,
  RuntimeWsMessage,
  RuntimeWsMessageType,
  RuntimeCommandEnvelope,
  RuntimeCommandKind,
  CommandLifecyclePhase,
  CommandLifecycle,
  JsonPatchOp,
  WorkspacePatchPayload,
  CommandStatusPayload,
  CommandProgressPayload,
  CommandFailedPayload,
  MeshBuildPhasePayload,
  MeshBuildSummaryPayload,
  DatasetReadyPayload,
  PythonSyncDiffPayload,
  DiagnosticsIssuePayload,
} from "./transport/transportContract";

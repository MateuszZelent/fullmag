"use client";

/* ── useSessionStream ──
 * Re-exports session/runtime types for backward compatibility.
 *
 * The legacy whole-state hook has been retired; active Control Room data now
 * flows through the resource-first runtime store and typed resource hooks.
 */

/* ── Re-export all types ── */
export type {
  SessionManifest,
  RunManifest,
  LiveState,
  FemLiveMesh,
  FemMeshPart,
  BackendCapabilities,
  ScalarRow,
  EngineLogEntry,
  QuantityDescriptor,
  ArtifactEntry,
  LatestFields,
  SpatialPreviewState,
  GlobalScalarPreviewState,
  PreviewState,
  PreviewConfig,
  DisplayKind,
  DisplaySelection,
  CurrentDisplaySelection,
  MeshCommandTarget,
  RuntimeStatusKind,
  RuntimeStatusState,
  CommandStatus,
  SceneDocument,
  ScriptBuilderSolverState,
  ScriptBuilderMeshState,
  ScriptBuilderUniverseState,
  ScriptBuilderStageState,
  ScriptBuilderInitialState,
  ScriptBuilderState,
  MeshSummaryState,
  MeshQualitySummaryState,
  MeshPipelinePhaseState,
  MeshCapabilitiesState,
  MeshAdaptivityState,
  MeshHistoryEntryState,
  MeshWorkspaceState,
  SessionState,
  ConnectionStatus,
  UseSessionStreamResult,
} from "./session/types";

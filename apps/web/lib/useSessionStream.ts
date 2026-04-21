"use client";

/* ── useSessionStream ──
 * Re-exports all types from session/ submodules for backward compatibility,
 * and provides the useCurrentLiveStream React hook.
 *
 * The hook is now a thin compatibility wrapper around the resource-first
 * snapshot transport so the old bootstrap/poll implementation is no longer
 * part of the active code path.
 */

import { useCurrentLiveSnapshot } from "@/features/session-runtime/hooks/useCurrentLiveSnapshot";

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

import type {
  SessionState,
  ConnectionStatus,
  UseSessionStreamResult,
} from "./session/types";

/* ── Import submodules ── */
/* ── Hook ── */

export function useCurrentLiveStream(): UseSessionStreamResult {
  return useCurrentLiveSnapshot();
}

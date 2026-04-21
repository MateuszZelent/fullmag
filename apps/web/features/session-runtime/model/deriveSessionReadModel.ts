/**
 * Layer B: Session Runtime – Normalization
 *
 * Single place where raw backend payloads become typed frontend models.
 * No component sees raw fetch results.
 */

import type {
  SessionManifest,
  RunManifest,
  CurrentDisplaySelection,
  FemLiveMesh,
  LatestFieldFrame,
  PreviewConfig,
  ScalarRow,
  EngineLogEntry,
  StepUpdateV2,
} from "@/lib/session/types";
import type {
  LiveState,
  PreviewState,
  QuantityDescriptor,
  ArtifactEntry,
  RuntimeStatusState,
  CommandStatus,
  MeshWorkspaceState,
  ScriptBuilderState,
} from "@/lib/useSessionStream";
import type { SessionState } from "@/lib/session/types";
import type { FieldFrameEnvelope } from "@/lib/fieldFrame/types";
import { buildEnvelopeFromLegacyState } from "@/lib/fieldFrame/envelopeAdapter";
import type { CapabilityMap, ResourceRevisionMap } from "@/src/api/types";
import { synthesizeCapabilitiesFromDiscretization } from "@/src/domain/capabilities";

// Empty stable arrays to avoid unnecessary re-renders
const EMPTY_SCALAR_ROWS: ScalarRow[] = [];
const EMPTY_ENGINE_LOG: EngineLogEntry[] = [];
const EMPTY_QUANTITIES: QuantityDescriptor[] = [];
const EMPTY_ARTIFACTS: ArtifactEntry[] = [];
const EMPTY_LATEST_FIELD_FRAMES: Record<string, LatestFieldFrame> = {};

export interface NormalizedSessionState {
  stateVersion: number | null;
  session: SessionManifest | null;
  run: RunManifest | null;
  metadata: Record<string, unknown> | null;
  liveState: LiveState | null;
  scalarRows: ScalarRow[];
  engineLog: EngineLogEntry[];
  quantities: QuantityDescriptor[];
  artifacts: ArtifactEntry[];
  femMesh: FemLiveMesh | null;
  preview: PreviewState | null;
  scriptBuilder: ScriptBuilderState | null;
  runtimeStatus: RuntimeStatusState | null;
  commandStatus: CommandStatus | null;
  meshWorkspace: MeshWorkspaceState | null;
  stepUpdateV2: StepUpdateV2 | null;
  workspaceStatus: string;
  isFemBackend: boolean;
  domainCapabilities: CapabilityMap | null;
  resourceRevisions: ResourceRevisionMap | null;
  displaySelection: CurrentDisplaySelection | null;
  previewConfig: PreviewConfig | null;
  latestFieldFrames: Record<string, LatestFieldFrame>;
  latestFieldGrid: [number, number, number] | null;
  /** Canonical field-frame envelope synthesized from legacy state. */
  fieldFrameEnvelope: FieldFrameEnvelope | null;
}

/**
 * Normalize the raw SSE/bootstrap state from useCurrentLiveStream
 * into a structured, typed read-model.
 */
export function deriveSessionReadModel(
  state: SessionState | null,
): NormalizedSessionState {
  if (!state) {
    return {
      stateVersion: null,
      session: null,
      run: null,
      metadata: null,
      liveState: null,
      scalarRows: EMPTY_SCALAR_ROWS,
      engineLog: EMPTY_ENGINE_LOG,
      quantities: EMPTY_QUANTITIES,
      artifacts: EMPTY_ARTIFACTS,
      femMesh: null,
      preview: null,
      scriptBuilder: null,
      runtimeStatus: null,
      commandStatus: null,
      meshWorkspace: null,
      stepUpdateV2: null,
      workspaceStatus: "idle",
      isFemBackend: false,
      domainCapabilities: null,
      resourceRevisions: null,
      displaySelection: null,
      previewConfig: null,
      latestFieldFrames: EMPTY_LATEST_FIELD_FRAMES,
      latestFieldGrid: null,
      fieldFrameEnvelope: null,
    };
  }

  const session = state.session ?? null;
  const run = state.run ?? null;
  const metadata = (state.metadata as Record<string, unknown> | null) ?? null;
  const liveState = state.live_state ?? null;
  const scalarRows = state.scalar_rows ?? EMPTY_SCALAR_ROWS;
  const engineLog = state.engine_log ?? EMPTY_ENGINE_LOG;
  const quantities = state.quantities ?? EMPTY_QUANTITIES;
  const artifacts = state.artifacts ?? EMPTY_ARTIFACTS;
  const femMesh = state.fem_mesh ?? liveState?.fem_mesh ?? null;
  const preview = state.preview ?? null;
  const scriptBuilder = state.script_builder ?? null;
  const runtimeStatus = state.runtime_status ?? null;
  const commandStatus = state.command_status ?? null;
  const meshWorkspace = state.mesh_workspace ?? null;
  const stepUpdateV2 = state.step_update_v2 ?? null;
  const displaySelection = state.display_selection ?? null;
  const previewConfig = state.preview_config ?? null;
  const latestFieldFrames = state.latest_fields?.frames ?? EMPTY_LATEST_FIELD_FRAMES;
  const latestFieldGrid = state.latest_fields?.grid ?? null;

  const workspaceStatus =
    runtimeStatus?.code ?? liveState?.status ?? session?.status ?? run?.status ?? "idle";

  // Detect FEM backend
  const planSummary = session?.plan_summary as Record<string, unknown> | undefined;
  const sceneDocument = state.scene_document as { study?: { backend?: unknown } } | null;
  const scriptBackendHint =
    (typeof scriptBuilder?.backend === "string" ? scriptBuilder.backend : null) ??
    (typeof sceneDocument?.study?.backend === "string" ? sceneDocument.study.backend : null) ??
    null;
  const resolvedBackend =
    (typeof planSummary?.resolved_backend === "string" ? planSummary.resolved_backend : null) ??
    ((typeof session?.requested_backend === "string" && session.requested_backend !== "auto")
      ? session.requested_backend
      : null) ??
    scriptBackendHint;
  const spatialPreview = preview?.kind === "spatial" ? preview : null;
  const isFemBackend =
    resolvedBackend === "fem" ||
    femMesh != null ||
    (spatialPreview as Record<string, unknown> | null)?.spatial_kind === "mesh";
  const domainCapabilities = synthesizeCapabilitiesFromDiscretization(isFemBackend);

  return {
    stateVersion: typeof state.state_version === "number" ? state.state_version : null,
    session,
    run,
    metadata,
    liveState,
    scalarRows,
    engineLog,
    quantities,
    artifacts,
    femMesh,
    preview,
    scriptBuilder,
    runtimeStatus,
    commandStatus,
    meshWorkspace,
    stepUpdateV2,
    workspaceStatus,
    isFemBackend,
    domainCapabilities,
    resourceRevisions: null,
    displaySelection,
    previewConfig,
    latestFieldFrames,
    latestFieldGrid,
    fieldFrameEnvelope: buildEnvelopeFromLegacyState({
      sessionId: session?.session_id ?? null,
      runId: run?.run_id ?? null,
      liveState,
      femMesh,
      preview,
      stepUpdateV2,
      domainCapabilities,
      legacyFemBackend: isFemBackend,
      quantityId: "m",
    }),
  };
}

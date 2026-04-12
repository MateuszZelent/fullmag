/**
 * Layer B: Session Runtime – Normalization
 *
 * Single place where raw backend payloads become typed frontend models.
 * No component sees raw fetch results.
 */

import type {
  SessionManifest,
  RunManifest,
  FemLiveMesh,
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

// Empty stable arrays to avoid unnecessary re-renders
const EMPTY_SCALAR_ROWS: ScalarRow[] = [];
const EMPTY_ENGINE_LOG: EngineLogEntry[] = [];
const EMPTY_QUANTITIES: QuantityDescriptor[] = [];
const EMPTY_ARTIFACTS: ArtifactEntry[] = [];

export interface NormalizedSessionState {
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
}

/**
 * Normalize the raw SSE/bootstrap state from useCurrentLiveStream
 * into a structured, typed read-model.
 */
export function deriveSessionReadModel(
  state: Record<string, unknown> | null,
  connection: "connecting" | "connected" | "disconnected",
): NormalizedSessionState {
  if (!state) {
    return {
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
    };
  }

  const session = (state.session as SessionManifest | null) ?? null;
  const run = (state.run as RunManifest | null) ?? null;
  const metadata = (state.metadata as Record<string, unknown> | null) ?? null;
  const liveState = (state.live_state as LiveState | null) ?? null;
  const scalarRows = (state.scalar_rows as ScalarRow[] | null) ?? EMPTY_SCALAR_ROWS;
  const engineLog = (state.engine_log as EngineLogEntry[] | null) ?? EMPTY_ENGINE_LOG;
  const quantities = (state.quantities as QuantityDescriptor[] | null) ?? EMPTY_QUANTITIES;
  const artifacts = (state.artifacts as ArtifactEntry[] | null) ?? EMPTY_ARTIFACTS;
  const femMesh = (state.fem_mesh as FemLiveMesh | null) ?? liveState?.fem_mesh ?? null;
  const preview = (state.preview as PreviewState | null) ?? null;
  const scriptBuilder = (state.script_builder as ScriptBuilderState | null) ?? null;
  const runtimeStatus = (state.runtime_status as RuntimeStatusState | null) ?? null;
  const commandStatus = (state.command_status as CommandStatus | null) ?? null;
  const meshWorkspace = (state.mesh_workspace as MeshWorkspaceState | null) ?? null;
  const stepUpdateV2 = (state.step_update_v2 as StepUpdateV2 | null) ?? null;

  const workspaceStatus =
    runtimeStatus?.code ?? liveState?.status ?? session?.status ?? run?.status ?? "idle";

  // Detect FEM backend
  const planSummary = session?.plan_summary as Record<string, unknown> | undefined;
  const scriptBackendHint =
    (typeof scriptBuilder?.backend === "string" ? scriptBuilder.backend : null) ??
    (typeof (state.scene_document as Record<string, unknown> | null)?.study === "object"
      ? (((state.scene_document as Record<string, unknown>)?.study as Record<string, unknown>)?.backend as string)
      : null) ??
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

  return {
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
  };
}

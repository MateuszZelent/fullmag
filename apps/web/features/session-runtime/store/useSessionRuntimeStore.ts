/**
 * Layer B: Session Runtime Store
 *
 * Read-model store for backend session state.
 * Components subscribe to narrow selectors, never to the whole object.
 *
 * Owns:
 * - normalized backend snapshot
 * - connection status
 * - timestamps
 *
 * Does NOT own:
 * - authoring draft
 * - tree selection / UI state
 * - viewport interaction state
 * - panel layout
 */

import { create } from "zustand";
import type { NormalizedSessionState } from "../model/deriveSessionReadModel";
import type { ConnectionStatus } from "../model/sessionRuntime.types";
import type { CapabilityMap, ResourceRevisionMap } from "@/src/api/types";
import type {
  CurrentDisplaySelection,
  SessionManifest,
  RunManifest,
  FemLiveMesh,
  LatestFieldFrame,
  PreviewConfig,
  ScalarRow,
  EngineLogEntry,
  StepUpdateV2,
} from "@/lib/session/types";
import type { FieldFrameEnvelope } from "@/lib/fieldFrame/types";
import type {
  LiveState,
  PreviewState,
  QuantityDescriptor,
  ArtifactEntry,
  RuntimeStatusState,
  CommandStatus,
  MeshWorkspaceState,
  ScriptBuilderState,
} from "@/lib/session/types";

interface SessionRuntimeStoreState {
  stateVersion: number | null;
  /** Connection */
  connection: ConnectionStatus;
  error: string | null;

  /** Normalized backend state */
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
  /** Canonical field-frame envelope synthesized from current runtime state. */
  fieldFrameEnvelope: FieldFrameEnvelope | null;

  /** Timestamps */
  lastUpdateTimestamp: number | null;

  /** Actions */
  applyNormalizedState: (state: NormalizedSessionState) => void;
  setConnection: (connection: ConnectionStatus, error?: string | null) => void;
  reset: () => void;
}

const INITIAL_STATE: Omit<SessionRuntimeStoreState,
  "applyNormalizedState" | "setConnection" | "reset"
> = {
  stateVersion: null,
  connection: "connecting",
  error: null,
  session: null,
  run: null,
  metadata: null,
  liveState: null,
  scalarRows: [],
  engineLog: [],
  quantities: [],
  artifacts: [],
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
  latestFieldFrames: {},
  latestFieldGrid: null,
  fieldFrameEnvelope: null,
  lastUpdateTimestamp: null,
};

export const useSessionRuntimeStore = create<SessionRuntimeStoreState>((set) => ({
  ...INITIAL_STATE,
  applyNormalizedState: (normalized: NormalizedSessionState) =>
    set((previous) => {
      const sessionChanged =
        previous.session?.session_id !== normalized.session?.session_id ||
        previous.run?.run_id !== normalized.run?.run_id;
      const versionChanged =
        normalized.stateVersion != null &&
        normalized.stateVersion !== previous.stateVersion;
      const shouldStampUpdate =
        sessionChanged ||
        versionChanged ||
        (previous.lastUpdateTimestamp == null && normalized.session != null);
      return {
        ...normalized,
        lastUpdateTimestamp: shouldStampUpdate
          ? Date.now()
          : previous.lastUpdateTimestamp,
      };
    }),
  setConnection: (connection, error = null) =>
    set({ connection, error }),
  reset: () => set(INITIAL_STATE),
}));

/* ── Narrow selectors — components in hot path use these, not the whole store ── */

export const selectConnection = (s: SessionRuntimeStoreState) => s.connection;
export const selectWorkspaceStatus = (s: SessionRuntimeStoreState) => s.workspaceStatus;
export const selectIsFemBackend = (s: SessionRuntimeStoreState) => s.isFemBackend;
export const selectDomainCapabilities = (s: SessionRuntimeStoreState) => s.domainCapabilities;
export const selectResourceRevisions = (s: SessionRuntimeStoreState) => s.resourceRevisions;
export const selectDisplaySelection = (s: SessionRuntimeStoreState) => s.displaySelection;
export const selectPreviewConfig = (s: SessionRuntimeStoreState) => s.previewConfig;
export const selectSession = (s: SessionRuntimeStoreState) => s.session;
export const selectRun = (s: SessionRuntimeStoreState) => s.run;
export const selectLiveState = (s: SessionRuntimeStoreState) => s.liveState;
export const selectFemMesh = (s: SessionRuntimeStoreState) => s.femMesh;
export const selectPreview = (s: SessionRuntimeStoreState) => s.preview;
export const selectCommandStatus = (s: SessionRuntimeStoreState) => s.commandStatus;
export const selectRuntimeStatus = (s: SessionRuntimeStoreState) => s.runtimeStatus;
export const selectScalarRows = (s: SessionRuntimeStoreState) => s.scalarRows;
export const selectEngineLog = (s: SessionRuntimeStoreState) => s.engineLog;
export const selectQuantities = (s: SessionRuntimeStoreState) => s.quantities;
export const selectArtifacts = (s: SessionRuntimeStoreState) => s.artifacts;
export const selectScriptBuilder = (s: SessionRuntimeStoreState) => s.scriptBuilder;
export const selectMeshWorkspace = (s: SessionRuntimeStoreState) => s.meshWorkspace;
export const selectStepUpdateV2 = (s: SessionRuntimeStoreState) => s.stepUpdateV2;
export const selectLatestFieldFrames = (s: SessionRuntimeStoreState) => s.latestFieldFrames;
export const selectLatestFieldGrid = (s: SessionRuntimeStoreState) => s.latestFieldGrid;
export const selectFieldFrameEnvelope = (s: SessionRuntimeStoreState) => s.fieldFrameEnvelope;

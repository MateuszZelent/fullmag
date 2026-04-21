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
import type { FieldFrameEnvelope } from "@/lib/fieldFrame/types";
import type { CapabilityMap, ResourceRevisionMap } from "@/src/api/types";

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
  /** Canonical field-frame envelope carried by the resource-first runtime store. */
  fieldFrameEnvelope: FieldFrameEnvelope | null;
}

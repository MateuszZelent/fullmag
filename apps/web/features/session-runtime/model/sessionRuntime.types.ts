/**
 * Layer B: Session Runtime – Core Types
 *
 * Read-only normalized model representing backend state.
 * No authoring logic, no UI state.
 */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface SessionRuntimeSnapshot {
  connection: ConnectionStatus;
  error: string | null;

  /** Normalized backend session/run state */
  session: import("@/lib/session/types").SessionManifest | null;
  run: import("@/lib/session/types").RunManifest | null;
  metadata: Record<string, unknown> | null;

  /** Live telemetry (high-frequency) */
  liveState: import("@/lib/useSessionStream").LiveState | null;
  scalarRows: import("@/lib/session/types").ScalarRow[];
  engineLog: import("@/lib/session/types").EngineLogEntry[];

  /** Domain-specific data */
  quantities: import("@/lib/useSessionStream").QuantityDescriptor[];
  artifacts: import("@/lib/useSessionStream").ArtifactEntry[];
  femMesh: import("@/lib/session/types").FemLiveMesh | null;
  preview: import("@/lib/useSessionStream").PreviewState | null;
  displaySelection: import("@/lib/session/types").CurrentDisplaySelection | null;
  previewConfig: import("@/lib/session/types").PreviewConfig | null;
  latestFieldFrames: Record<string, import("@/lib/session/types").LatestFieldFrame>;
  latestFieldGrid: [number, number, number] | null;

  /** Script builder / model graph from backend */
  scriptBuilder: import("@/lib/useSessionStream").ScriptBuilderState | null;
  remoteSceneDocument: import("@/lib/session/types").SceneDocument | null;
  remoteModelBuilderGraph: import("@/lib/session/types").ModelBuilderGraphV2 | null;

  /** Runtime status */
  runtimeStatus: import("@/lib/useSessionStream").RuntimeStatusState | null;
  commandStatus: import("@/lib/useSessionStream").CommandStatus | null;
  meshWorkspace: import("@/lib/useSessionStream").MeshWorkspaceState | null;

  /** Derived convenience */
  workspaceStatus: string;
  isFemBackend: boolean;
  domainCapabilities: import("@/src/api/types").CapabilityMap | null;
  resourceRevisions: import("@/src/api/types").ResourceRevisionMap | null;
}

/**
 * Typed event envelope for session-to-store communication.
 * Each event has a type and version for forward compatibility.
 */
export type SessionEvent =
  | { type: "bootstrap"; version: 1; payload: Record<string, unknown> }
  | { type: "live_tick"; version: 1; payload: import("@/lib/useSessionStream").LiveState }
  | { type: "command_status"; version: 1; payload: import("@/lib/useSessionStream").CommandStatus }
  | { type: "runtime_status"; version: 1; payload: import("@/lib/useSessionStream").RuntimeStatusState }
  | { type: "connection_change"; version: 1; payload: { status: ConnectionStatus; error: string | null } }
  | { type: "fem_mesh"; version: 1; payload: import("@/lib/session/types").FemLiveMesh }
  | { type: "scene_document"; version: 1; payload: import("@/lib/session/types").SceneDocument };

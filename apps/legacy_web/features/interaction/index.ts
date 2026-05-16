/**
 * features/interaction — barrel export
 *
 * Central interaction model for Fullmag control room.
 * Implements ADR-001 through ADR-005.
 */

// ── Trace ─────────────────────────────────────────────────────
export { traceInteraction, subscribeToTrace, getTraceSnapshot } from "./trace/interactionTrace";
export type { UiInteractionEvent, InteractionTraceContext } from "./trace/interactionTrace";

// ── Selection model ───────────────────────────────────────────
export type { SelectionTarget, SelectionOrigin, SelectionState } from "./model/selection";
export {
  EMPTY_SELECTION,
  parseNodeIdToTarget,
  objectIdFromTarget,
  assetIdFromTarget,
  isTargetSpatial,
  isTargetTransformable,
  ribbonContextForTarget,
  inspectorPanelForTarget,
} from "./model/selection";

// ── Viewport interaction model ────────────────────────────────
export type {
  ViewportMode,
  TransformTool,
  TransformScope,
  TransformSpace,
  PivotMode,
  ActiveDrag,
  SnappingConfig,
  ViewportInteractionState,
} from "./model/viewportInteraction";
export { DEFAULT_VIEWPORT_INTERACTION } from "./model/viewportInteraction";

// ── Camera commands ───────────────────────────────────────────
export type { CameraCommand, CameraCommandState } from "./model/cameraCommand";

// ── Dirty graph ───────────────────────────────────────────────
export type {
  ArtifactName,
  ArtifactStatus,
  ArtifactValidity,
  DirtyGraphState,
  DirtyGraphAction,
} from "./model/dirtyGraph";
export { INITIAL_DIRTY_GRAPH, dirtyGraphReducer } from "./model/dirtyGraph";

// ── Run gate ──────────────────────────────────────────────────
export type { RunBlocker, RunGateState } from "./model/runGate";
export { deriveRunGate } from "./model/runGate";

// ── Scene transactions ────────────────────────────────────────
export type {
  SceneTransactionKind,
  InvalidationTarget,
  SceneTransaction,
  UndoableTransaction,
} from "./model/sceneTransaction";

// ── Magnetization ─────────────────────────────────────────────
export type {
  MagneticPresetKind,
  MagnetizationAsset,
  MagnetizationDraft,
  MagnetizationDraftStatus,
  MagnetizationRealization,
  MagnetizationMapping,
} from "./model/magnetization";
export {
  validateUniformDirection,
  validateSeed,
  isDraftDirty,
  createDraftFromAsset,
} from "./model/magnetization";

// ── Command registry ──────────────────────────────────────────
export type { CommandContext, CommandState, CommandDefinition } from "./commands/commandRegistry";
export {
  registerCommand,
  unregisterCommand,
  getCommand,
  getAllCommands,
  getCommandsForGroup,
  getCommandsForContext,
  executeCommand,
} from "./commands/commandRegistry";

// ── Command registrations ─────────────────────────────────────
export { registerCameraCommands } from "./commands/commands.camera";
export { registerTransformCommands } from "./commands/commands.transform";
export { registerMagnetizationCommands } from "./commands/commands.magnetization";
export { registerMeshCommands } from "./commands/commands.mesh";

// ── Inspector ─────────────────────────────────────────────────
export { InspectorApplyBar } from "./inspector/ApplyBar";
export type { InspectorApplyBarProps, ApplyBarStatus } from "./inspector/ApplyBar";

// ── Store ─────────────────────────────────────────────────────
export { useInteractionStore } from "./store/useInteractionStore";
export type { InteractionStoreState } from "./store/useInteractionStore";

export {
  useDirtyGraphStore,
  selectCanRun,
  selectCanRelax,
  selectBlockers,
  selectMeshStatus,
  selectInitialStateStatus,
} from "./store/useDirtyGraphStore";

// ── Controller ────────────────────────────────────────────────
export {
  handleTreeSelect,
  handleTreeDoubleClick,
  handleViewportSelect,
  handleViewportDeselect,
  focusOnSelection,
  fitCameraToAll,
  switchToCameraMode,
  switchToManipulateMode,
  setActiveTool,
  runCommand,
} from "./controller/interactionController";

// ── Bridge / wiring ───────────────────────────────────────────
export { initializeInteractionCommands } from "./commands/initCommands";
export {
  useInteractionBridge,
  useLegacySelectionSync,
} from "./bridge/controlRoomBridge";
export type { LegacySelectionSink, LegacyMeshPartResolver } from "./bridge/controlRoomBridge";
export { useInteractionKeyboard } from "./bridge/useInteractionKeyboard";

import type { ScriptBuilderMagneticInteractionKind } from "@/lib/session/types";
import type { StudyPrimitiveStageKind } from "@/lib/study-builder/types";
import type { MagneticPresetKind } from "@/lib/magnetizationPresetCatalog";
import type { BooleanOp, PrimitiveKind } from "@/features/geometry-builder/model/types";
import type { CapabilityMap } from "@/src/api/types";
import { isFemDiscretization } from "@/src/domain/capabilities";

export type ResultAnalysisKind =
  | "spectrum"
  | "dispersion"
  | "modes"
  | "time-traces"
  | "vortex-frequency"
  | "vortex-trajectory"
  | "vortex-orbit"
  | "quantity"
  | "table";

export interface RibbonCommandContext {
  viewMode?: string;
  isFemBackend?: boolean;
  domainCapabilities?: CapabilityMap | null;
  meshGenerating?: boolean;
  canRun?: boolean;
  canRelax?: boolean;
  canPause?: boolean;
  canStop?: boolean;
  canSkip?: boolean;
  runAction?: string;
  canSyncScriptBuilder?: boolean;
  scriptSyncBusy?: boolean;
  selectedObjectId?: string | null;
  airboxVisible?: boolean;
  viewportAxesScope?: "universe" | "object";
  universeWireframeVisible?: boolean;
  viewportLegendVisible?: boolean;
  activeTransformScope?: "object" | "texture" | null;
  onViewChange?: (mode: string) => void;
  onSidebarToggle?: () => void;
  onCreateVisualizationPreset?: () => void;
  onToggleAirbox?: () => void;
  onSetViewportAxesScope?: (scope: "universe" | "object") => void;
  onToggleUniverseWireframe?: () => void;
  onToggleViewportLegend?: () => void;
  onSimAction?: (action: string) => void;
  onQuickPreviewSelect?: (quantityId: string) => void;
  onExport?: () => void;
  onCapture?: () => void;
  onStateExport?: () => void;
  onAddAntenna?: (kind: "MicrostripAntenna" | "CPWAntenna") => void;
  onSelectModelNode?: (nodeId: string) => void;
  onBuildMeshSelected?: () => void;
  onBuildMeshAll?: () => void;
  onOpenMeshInspector?: () => void;
  onOpenMeshQuality?: () => void;
  onOpenMeshSizeSettings?: () => void;
  onOpenMeshMethodSettings?: () => void;
  onOpenMeshPipeline?: () => void;
  onRequestObjectFocus?: (objectId: string) => void;
  onSyncScriptBuilder?: () => void;
  onStudyAddPrimitive?: (
    kind: StudyPrimitiveStageKind,
    placement: "append" | "before" | "after",
  ) => void;
  onStudyAddMacro?: (
    kind:
      | "hysteresis_loop"
      | "field_sweep_relax"
      | "field_sweep_relax_snapshot"
      | "relax_run"
      | "relax_eigenmodes"
      | "parameter_sweep"
      | "current_sweep_run"
      | "dc_bias_plus_rf_probe",
    placement: "append" | "before" | "after",
  ) => void;
  onStudyDuplicateSelected?: () => void;
  onStudyToggleSelectedEnabled?: () => void;
  onObjectAddInteraction?: (
    objectId: string,
    kind: ScriptBuilderMagneticInteractionKind,
  ) => void;
  onAssignMagnetizationPreset?: (
    objectId: string,
    kind: MagneticPresetKind,
  ) => void;
  onSetTransformScope?: (
    scope: "camera" | "object" | "texture",
  ) => void;
  onSetTextureTransformMode?: (
    objectId: string,
    mode: "translate" | "rotate" | "scale",
  ) => void;
  onAddResultAnalysis?: (kind: ResultAnalysisKind) => void;

  // ── Geometry builder callbacks ──────────────────────────
  onBuilderAddPrimitive?: (kind: PrimitiveKind) => void;
  onBuilderCreateBoolean?: (op: BooleanOp) => void;
  onBuilderRemovePrimitive?: (id: string) => void;
  onBuilderDuplicatePrimitive?: (id: string) => void;
  onBuilderBuildGeometry?: () => void;
  onBuilderBuildMesh?: () => void;
  onBuilderBuildAll?: () => void;
  onBuilderValidateGeometry?: () => void;
  onBuilderSetViewportMode?: (mode: "camera" | "manipulate") => void;
  onBuilderSetTransformTool?: (tool: "move" | "rotate" | "scale") => void;
  onBuilderToggleSnap?: () => void;
  onBuilderFocusSelected?: () => void;
  onBuilderFrameAll?: () => void;
  onBuilderCenterInUniverse?: (id: string) => void;
  builderEnabled?: boolean;
  builderDirtyGeometry?: boolean;
  builderDirtyMesh?: boolean;
  builderHasRealization?: boolean;
  builderSceneObjectCount?: number;
  builderSelectedPrimitiveId?: string | null;
}

type CanonicalViewportMode = "3D" | "2D" | "Mesh" | "Analyze" | "charts";

function supportsFemMeshActions(ctx: RibbonCommandContext): boolean {
  if (ctx.domainCapabilities) {
    return isFemDiscretization(ctx.domainCapabilities);
  }
  return Boolean(ctx.isFemBackend);
}

function normalizeViewportMode(mode: string | undefined | null): CanonicalViewportMode | null {
  if (typeof mode !== "string") {
    return null;
  }
  const normalized = mode.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "3d") {
    return "3D";
  }
  if (normalized === "2d") {
    return "2D";
  }
  if (normalized === "mesh") {
    return "Mesh";
  }
  if (normalized === "analyze") {
    return "Analyze";
  }
  if (normalized === "charts" || normalized === "chart") {
    return "charts";
  }
  return null;
}

export type RibbonCommand =
  | { id: "navigation.select-node"; nodeId: string }
  | { id: "viewport.set-mode"; mode: string }
  | { id: "viewport.toggle-airbox" }
  | { id: "viewport.set-axes-scope"; scope: "universe" | "object" }
  | { id: "viewport.toggle-universe-wireframe" }
  | { id: "viewport.toggle-legend" }
  | { id: "visualization.create-preset" }
  | { id: "viewport.toggle-sidebar" }
  | { id: "viewport.focus-selected-object" }
  | { id: "solver.control"; action: "relax" | "run" | "pause" | "stop" | "skip" }
  | { id: "preview.select-quantity"; quantityId: string }
  | { id: "export.results" }
  | { id: "export.state" }
  | { id: "capture.viewport" }
  | { id: "script.sync" }
  | { id: "antenna.add"; kind: "MicrostripAntenna" | "CPWAntenna" }
  | { id: "mesh.build-selected" }
  | { id: "mesh.build-all" }
  | { id: "mesh.open-inspector" }
  | { id: "mesh.open-quality" }
  | { id: "mesh.open-size-settings" }
  | { id: "mesh.open-method-settings" }
  | { id: "mesh.open-pipeline" }
  | {
      id: "study.add-primitive";
      kind: StudyPrimitiveStageKind;
      placement: "append" | "before" | "after";
    }
  | {
      id: "study.add-macro";
      kind:
        | "hysteresis_loop"
        | "field_sweep_relax"
        | "field_sweep_relax_snapshot"
        | "relax_run"
        | "relax_eigenmodes"
        | "parameter_sweep"
        | "current_sweep_run"
        | "dc_bias_plus_rf_probe";
      placement: "append" | "before" | "after";
    }
  | { id: "study.duplicate-selected" }
  | { id: "study.toggle-selected-enabled" }
  | {
      id: "object.add-interaction";
      objectId: string;
      kind: ScriptBuilderMagneticInteractionKind;
    }
  | {
      id: "object.assign-magnetization-preset";
      objectId: string;
      kind: MagneticPresetKind;
    }
  | {
      id: "viewport.set-transform-scope";
      scope: "camera" | "object" | "texture";
    }
  | {
      id: "object.set-texture-transform-mode";
      objectId: string;
      mode: "translate" | "rotate" | "scale";
    }
  | { id: "results.add-analysis"; kind: ResultAnalysisKind }
  // ── Geometry Builder commands ────────────────────────────
  | { id: "builder.add-primitive"; primitiveKind: PrimitiveKind }
  | { id: "builder.create-boolean"; op: BooleanOp }
  | { id: "builder.remove-primitive"; primitiveId: string }
  | { id: "builder.duplicate-primitive"; primitiveId: string }
  | { id: "builder.build-geometry" }
  | { id: "builder.build-mesh" }
  | { id: "builder.build-all" }
  | { id: "builder.validate-geometry" }
  | { id: "builder.set-viewport-mode"; mode: "camera" | "manipulate" }
  | { id: "builder.set-transform-tool"; tool: "move" | "rotate" | "scale" }
  | { id: "builder.toggle-snap" }
  | { id: "builder.focus-selected" }
  | { id: "builder.frame-all" }
  | { id: "builder.center-in-universe"; primitiveId: string };

export function canExecuteRibbonCommand(
  ctx: RibbonCommandContext,
  command: RibbonCommand,
): boolean {
  switch (command.id) {
    case "navigation.select-node":
      return typeof ctx.onSelectModelNode === "function";
    case "viewport.set-mode":
      return typeof ctx.onViewChange === "function" && normalizeViewportMode(command.mode) !== null;
    case "viewport.toggle-airbox":
      return typeof ctx.onToggleAirbox === "function";
    case "viewport.set-axes-scope":
      return typeof ctx.onSetViewportAxesScope === "function";
    case "viewport.toggle-universe-wireframe":
      return typeof ctx.onToggleUniverseWireframe === "function";
    case "viewport.toggle-legend":
      return typeof ctx.onToggleViewportLegend === "function";
    case "visualization.create-preset":
      return typeof ctx.onCreateVisualizationPreset === "function";
    case "viewport.toggle-sidebar":
      return typeof ctx.onSidebarToggle === "function";
    case "viewport.focus-selected-object":
      return Boolean(ctx.selectedObjectId) && typeof ctx.onRequestObjectFocus === "function";
    case "solver.control":
      if (typeof ctx.onSimAction !== "function") return false;
      if (command.action === "run") return Boolean(ctx.canRun);
      if (command.action === "relax") return Boolean(ctx.canRelax);
      if (command.action === "pause") return Boolean(ctx.canPause);
      if (command.action === "skip") return Boolean(ctx.canSkip);
      return Boolean(ctx.canStop);
    case "preview.select-quantity":
      return typeof ctx.onQuickPreviewSelect === "function";
    case "export.results":
      return typeof ctx.onExport === "function";
    case "export.state":
      return typeof ctx.onStateExport === "function";
    case "capture.viewport":
      return typeof ctx.onCapture === "function";
    case "script.sync":
      return Boolean(ctx.canSyncScriptBuilder) && !ctx.scriptSyncBusy && typeof ctx.onSyncScriptBuilder === "function";
    case "antenna.add":
      return typeof ctx.onAddAntenna === "function";
    case "mesh.build-selected":
      return supportsFemMeshActions(ctx) && !ctx.meshGenerating && typeof ctx.onBuildMeshSelected === "function";
    case "mesh.build-all":
      return supportsFemMeshActions(ctx) && !ctx.meshGenerating && typeof ctx.onBuildMeshAll === "function";
    case "mesh.open-inspector":
      return supportsFemMeshActions(ctx) && typeof ctx.onOpenMeshInspector === "function";
    case "mesh.open-quality":
      return supportsFemMeshActions(ctx) && typeof ctx.onOpenMeshQuality === "function";
    case "mesh.open-size-settings":
      return supportsFemMeshActions(ctx) && typeof ctx.onOpenMeshSizeSettings === "function";
    case "mesh.open-method-settings":
      return supportsFemMeshActions(ctx) && typeof ctx.onOpenMeshMethodSettings === "function";
    case "mesh.open-pipeline":
      return supportsFemMeshActions(ctx) && typeof ctx.onOpenMeshPipeline === "function";
    case "study.add-primitive":
      return typeof ctx.onStudyAddPrimitive === "function";
    case "study.add-macro":
      return typeof ctx.onStudyAddMacro === "function";
    case "study.duplicate-selected":
      return typeof ctx.onStudyDuplicateSelected === "function";
    case "study.toggle-selected-enabled":
      return typeof ctx.onStudyToggleSelectedEnabled === "function";
    case "object.add-interaction":
      return Boolean(command.objectId) && typeof ctx.onObjectAddInteraction === "function";
    case "object.assign-magnetization-preset":
      return Boolean(command.objectId) && typeof ctx.onAssignMagnetizationPreset === "function";
    case "viewport.set-transform-scope":
      return typeof ctx.onSetTransformScope === "function";
    case "object.set-texture-transform-mode":
      return Boolean(command.objectId) && typeof ctx.onSetTextureTransformMode === "function";
    case "results.add-analysis":
      return typeof ctx.onAddResultAnalysis === "function";
    // ── Geometry Builder ──────────────────────────────────
    case "builder.add-primitive":
      return typeof ctx.onBuilderAddPrimitive === "function";
    case "builder.create-boolean":
      return false;
    case "builder.remove-primitive":
      return typeof ctx.onBuilderRemovePrimitive === "function" && Boolean(command.primitiveId);
    case "builder.duplicate-primitive":
      return typeof ctx.onBuilderDuplicatePrimitive === "function" && Boolean(command.primitiveId);
    case "builder.build-geometry":
      return typeof ctx.onBuilderBuildGeometry === "function";
    case "builder.build-mesh":
      return (
        typeof ctx.onBuilderBuildMesh === "function" &&
        Boolean(ctx.isFemBackend) &&
        (ctx.builderSceneObjectCount ?? 0) > 0
      );
    case "builder.build-all":
      return (
        typeof ctx.onBuilderBuildAll === "function" &&
        Boolean(ctx.isFemBackend) &&
        (ctx.builderSceneObjectCount ?? 0) > 0
      );
    case "builder.validate-geometry":
      return typeof ctx.onBuilderValidateGeometry === "function";
    case "builder.set-viewport-mode":
      return typeof ctx.onBuilderSetViewportMode === "function";
    case "builder.set-transform-tool":
      return typeof ctx.onBuilderSetTransformTool === "function";
    case "builder.toggle-snap":
      return typeof ctx.onBuilderToggleSnap === "function";
    case "builder.focus-selected":
      return typeof ctx.onBuilderFocusSelected === "function" && Boolean(ctx.builderSelectedPrimitiveId);
    case "builder.frame-all":
      return typeof ctx.onBuilderFrameAll === "function";
    case "builder.center-in-universe":
      return typeof ctx.onBuilderCenterInUniverse === "function" && Boolean(command.primitiveId);
  }
}

export function executeRibbonCommand(
  ctx: RibbonCommandContext,
  command: RibbonCommand,
): void {
  if (!canExecuteRibbonCommand(ctx, command)) {
    return;
  }
  switch (command.id) {
    case "navigation.select-node":
      ctx.onSelectModelNode?.(command.nodeId);
      return;
    case "viewport.set-mode":
      ctx.onViewChange?.(normalizeViewportMode(command.mode) ?? "Analyze");
      return;
    case "viewport.toggle-airbox":
      ctx.onToggleAirbox?.();
      return;
    case "viewport.set-axes-scope":
      ctx.onSetViewportAxesScope?.(command.scope);
      return;
    case "viewport.toggle-universe-wireframe":
      ctx.onToggleUniverseWireframe?.();
      return;
    case "viewport.toggle-legend":
      ctx.onToggleViewportLegend?.();
      return;
    case "visualization.create-preset":
      ctx.onCreateVisualizationPreset?.();
      return;
    case "viewport.toggle-sidebar":
      ctx.onSidebarToggle?.();
      return;
    case "viewport.focus-selected-object":
      if (ctx.selectedObjectId) {
        ctx.onRequestObjectFocus?.(ctx.selectedObjectId);
      }
      return;
    case "solver.control":
      ctx.onSimAction?.(command.action === "run" ? (ctx.runAction ?? "run") : command.action);
      return;
    case "preview.select-quantity":
      ctx.onQuickPreviewSelect?.(command.quantityId);
      return;
    case "export.results":
      ctx.onExport?.();
      return;
    case "export.state":
      ctx.onStateExport?.();
      return;
    case "capture.viewport":
      ctx.onCapture?.();
      return;
    case "script.sync":
      ctx.onSyncScriptBuilder?.();
      return;
    case "antenna.add":
      ctx.onAddAntenna?.(command.kind);
      return;
    case "mesh.build-selected":
      ctx.onBuildMeshSelected?.();
      return;
    case "mesh.build-all":
      ctx.onBuildMeshAll?.();
      return;
    case "mesh.open-inspector":
      ctx.onOpenMeshInspector?.();
      return;
    case "mesh.open-quality":
      ctx.onOpenMeshQuality?.();
      return;
    case "mesh.open-size-settings":
      ctx.onOpenMeshSizeSettings?.();
      return;
    case "mesh.open-method-settings":
      ctx.onOpenMeshMethodSettings?.();
      return;
    case "mesh.open-pipeline":
      ctx.onOpenMeshPipeline?.();
      return;
    case "study.add-primitive":
      ctx.onStudyAddPrimitive?.(command.kind, command.placement);
      return;
    case "study.add-macro":
      ctx.onStudyAddMacro?.(command.kind, command.placement);
      return;
    case "study.duplicate-selected":
      ctx.onStudyDuplicateSelected?.();
      return;
    case "study.toggle-selected-enabled":
      ctx.onStudyToggleSelectedEnabled?.();
      return;
    case "object.add-interaction":
      ctx.onObjectAddInteraction?.(command.objectId, command.kind);
      return;
    case "object.assign-magnetization-preset":
      ctx.onAssignMagnetizationPreset?.(command.objectId, command.kind);
      return;
    case "viewport.set-transform-scope":
      ctx.onSetTransformScope?.(command.scope);
      return;
    case "object.set-texture-transform-mode":
      ctx.onSetTextureTransformMode?.(command.objectId, command.mode);
      return;
    case "results.add-analysis":
      ctx.onAddResultAnalysis?.(command.kind);
      return;
    // ── Geometry Builder ──────────────────────────────────
    case "builder.add-primitive":
      ctx.onBuilderAddPrimitive?.(command.primitiveKind);
      return;
    case "builder.create-boolean":
      ctx.onBuilderCreateBoolean?.(command.op);
      return;
    case "builder.remove-primitive":
      ctx.onBuilderRemovePrimitive?.(command.primitiveId);
      return;
    case "builder.duplicate-primitive":
      ctx.onBuilderDuplicatePrimitive?.(command.primitiveId);
      return;
    case "builder.build-geometry":
      ctx.onBuilderBuildGeometry?.();
      return;
    case "builder.build-mesh":
      ctx.onBuilderBuildMesh?.();
      return;
    case "builder.build-all":
      ctx.onBuilderBuildAll?.();
      return;
    case "builder.validate-geometry":
      ctx.onBuilderValidateGeometry?.();
      return;
    case "builder.set-viewport-mode":
      ctx.onBuilderSetViewportMode?.(command.mode);
      return;
    case "builder.set-transform-tool":
      ctx.onBuilderSetTransformTool?.(command.tool);
      return;
    case "builder.toggle-snap":
      ctx.onBuilderToggleSnap?.();
      return;
    case "builder.focus-selected":
      ctx.onBuilderFocusSelected?.();
      return;
    case "builder.frame-all":
      ctx.onBuilderFrameAll?.();
      return;
    case "builder.center-in-universe":
      ctx.onBuilderCenterInUniverse?.(command.primitiveId);
      return;
  }
}

import type { ScriptBuilderMagneticInteractionKind } from "@/lib/session/types";
import type { StudyPrimitiveStageKind } from "@/lib/study-builder/types";
import type { MagneticPresetKind } from "@/lib/magnetizationPresetCatalog";
import type { GeometryPresetKind } from "@/lib/geometryPresetCatalog";
import type { PrimitiveKind } from "@/features/geometry-builder/model/types";

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
  activeTransformScope?: "object" | "texture" | null;
  onAddGeometryPreset?: (preset: GeometryPresetKind) => void;
  onViewChange?: (mode: string) => void;
  onSidebarToggle?: () => void;
  onCreateVisualizationPreset?: () => void;
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
  builderSelectedPrimitiveId?: string | null;
}

type CanonicalViewportMode = "3D" | "2D" | "Mesh" | "Analyze" | "charts";

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
  | { id: "geometry.add-preset"; preset: GeometryPresetKind }
  | { id: "navigation.select-node"; nodeId: string }
  | { id: "viewport.set-mode"; mode: string }
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
    case "geometry.add-preset":
      return typeof ctx.onAddGeometryPreset === "function";
    case "navigation.select-node":
      return typeof ctx.onSelectModelNode === "function";
    case "viewport.set-mode":
      return typeof ctx.onViewChange === "function" && normalizeViewportMode(command.mode) !== null;
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
      return Boolean(ctx.isFemBackend) && !ctx.meshGenerating && typeof ctx.onBuildMeshSelected === "function";
    case "mesh.build-all":
      return Boolean(ctx.isFemBackend) && !ctx.meshGenerating && typeof ctx.onBuildMeshAll === "function";
    case "mesh.open-inspector":
      return Boolean(ctx.isFemBackend) && typeof ctx.onOpenMeshInspector === "function";
    case "mesh.open-quality":
      return Boolean(ctx.isFemBackend) && typeof ctx.onOpenMeshQuality === "function";
    case "mesh.open-size-settings":
      return Boolean(ctx.isFemBackend) && typeof ctx.onOpenMeshSizeSettings === "function";
    case "mesh.open-method-settings":
      return Boolean(ctx.isFemBackend) && typeof ctx.onOpenMeshMethodSettings === "function";
    case "mesh.open-pipeline":
      return Boolean(ctx.isFemBackend) && typeof ctx.onOpenMeshPipeline === "function";
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
    case "builder.remove-primitive":
      return typeof ctx.onBuilderRemovePrimitive === "function" && Boolean(command.primitiveId);
    case "builder.duplicate-primitive":
      return typeof ctx.onBuilderDuplicatePrimitive === "function" && Boolean(command.primitiveId);
    case "builder.build-geometry":
      return typeof ctx.onBuilderBuildGeometry === "function" && Boolean(ctx.builderDirtyGeometry);
    case "builder.build-mesh":
      return typeof ctx.onBuilderBuildMesh === "function" && Boolean(ctx.builderHasRealization) && Boolean(ctx.builderDirtyMesh);
    case "builder.build-all":
      return typeof ctx.onBuilderBuildAll === "function" && Boolean(ctx.builderDirtyGeometry || ctx.builderDirtyMesh);
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
    case "geometry.add-preset":
      ctx.onAddGeometryPreset?.(command.preset);
      return;
    case "navigation.select-node":
      ctx.onSelectModelNode?.(command.nodeId);
      return;
    case "viewport.set-mode":
      ctx.onViewChange?.(normalizeViewportMode(command.mode) ?? "Analyze");
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

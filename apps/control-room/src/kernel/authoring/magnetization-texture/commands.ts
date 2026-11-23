import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type {
  JsonObject,
  MagnetizationApplyTarget,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { obsoleteSessionResult } from "@/kernel/commands/commandSessionScope";
import type {
  CommandContext,
  CommandContribution,
  CommandResult,
} from "@/kernel/commands/commandTypes";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  magnetizationTextureAssetId,
  presetMagnetizationAsset,
} from "@/shared/domain/magnetization-texture/assetFactory";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  computeRelativePresetDefaults,
  fitCharacteristicSizeToTarget,
  hydrateMagneticTextureDraftFromInitializer,
  resetDraftTransform,
  serializeMagneticTextureDraftToInitializer,
  synchronizePlaneAndProjection,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  extractMagnetizationTargetInputFromSelection,
  resolveMagnetizationTextureTarget,
} from "@/shared/domain/magnetization-texture/targetResolver";
import {
  requestTextureInspectorTab,
  runActiveTextureFitCharacteristicSize,
  runActiveTextureResetTransform,
  setTextureGizmoMode,
  setTransformScope,
  toggleTextureGizmo,
  type TextureGizmoMode,
  type TransformScopeMode,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";
import {
  canonicalPresetKind,
  type MagnetizationTexturePresetId,
} from "@/shared/domain/magnetization-texture/texturePresets";
import type { MagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/types";

function selectedScene(context: CommandContext): SceneResource | null {
  const raw = context.resourceData?.[MODEL_SCENE_PATH];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as SceneResource)
    : null;
}

function selectedTarget(context: CommandContext): MagnetizationTextureTarget | null {
  const selection = context.selection?.get();
  return resolveMagnetizationTextureTarget(
    extractMagnetizationTargetInputFromSelection(selection),
    selectedScene(context),
  );
}

function nonMagneticObjectReason(context: CommandContext): string | null {
  const selection = context.selection?.get();
  const input = extractMagnetizationTargetInputFromSelection(selection);
  const objectId = input.objectId?.trim();
  const scene = selectedScene(context);
  if (!objectId || !scene?.objects) return null;
  const obj = scene.objects.find((candidate) => candidate.id === objectId) as
    | { role?: string }
    | undefined;
  if (obj?.role && obj.role !== "magnet") {
    return `Selected object is non-magnetic (${obj.role}).`;
  }
  return null;
}

function disabledReason(context: CommandContext): string | null {
  const nonMagnetic = nonMagneticObjectReason(context);
  if (nonMagnetic) return nonMagnetic;
  if (!selectedTarget(context)) {
    return "Select an object or region texture target.";
  }
  if (!context.api) {
    return "Control Room API is not available.";
  }
  return null;
}

function loadFileDisabledReason(context: CommandContext): string | null {
  const nonMagnetic = nonMagneticObjectReason(context);
  if (nonMagnetic) return nonMagnetic;
  if (!selectedTarget(context)) {
    return "Select an object or region texture target.";
  }
  return null;
}

function sceneRevision(context: CommandContext): number | null {
  const scene = selectedScene(context);
  if (!scene) return null;
  const revision = (scene as Record<string, unknown>).revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : null;
}

async function syncScriptBestEffort(
  context: CommandContext,
  sessionScopeKey?: string,
): Promise<void> {
  const syncFn = context.api?.model?.syncAuthoringScript;
  if (typeof syncFn !== "function") return;
  try {
    await syncFn({}, sessionScopeKey ? { sessionScopeKey } : undefined);
  } catch {
    // Best-effort script sync: managed copy updates never fail the committed scene transaction.
  }
}

function buildPresetApplyTarget(
  scene: SceneResource | null,
  target: MagnetizationTextureTarget,
  presetKind: MagnetizationTexturePresetId,
): MagnetizationApplyTarget {
  const canonicalKind = canonicalPresetKind(presetKind);
  const bounds = resolveTargetBoundsMeters(scene, target);
  const presetParams = computeRelativePresetDefaults(canonicalKind, bounds) as JsonObject;
  const { mappingProjection } = synchronizePlaneAndProjection(
    canonicalKind,
    "auto",
    "xy",
    "object_local",
    bounds,
  );

  if (target.kind === "region") {
    return {
      kind: "region",
      object_id: target.objectId,
      region_id: target.regionId,
      texture_override: {
        initial_magnetization: {
          kind: "preset_texture",
          preset_kind: canonicalKind,
          preset_version: 2,
          preset_params: presetParams,
          mapping: {
            clamp_mode: "none",
            projection: mappingProjection,
            space: "region",
          },
          texture_transform: {
            pivot: [0, 0, 0],
            rotate_vectors: true,
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
        } as never,
      },
    };
  }

  const assetId = magnetizationTextureAssetId(target, canonicalKind);
  return {
    kind: "object",
    object_id: target.objectId,
    asset: presetMagnetizationAsset({
      id: assetId,
      label: null,
      presetKind: canonicalKind,
      presetVersion: 2,
      presetParams,
      mapping: {
        clamp_mode: "none",
        projection: mappingProjection,
        space: "object",
      },
      textureTransform: {
        pivot: [0, 0, 0],
        rotate_vectors: true,
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        translation: bounds.localCenter,
      },
    }),
  };
}

async function executeAtomicMagnetizationApply(
  context: CommandContext,
  historyLabel: string,
  applyTarget: MagnetizationApplyTarget,
): Promise<CommandResult> {
  if (!context.api) {
    return { status: "failed", message: "Control Room API is not available." };
  }
  const obsoleteBefore = obsoleteSessionResult(context);
  if (obsoleteBefore) return obsoleteBefore;

  const sessionScopeKey = context.sessionScopeKey;
  if (!sessionScopeKey) {
    return { status: "failed", message: "Session scope is not ready." };
  }
  const baseRevision = sceneRevision(context);
  if (baseRevision === null) {
    return { status: "failed", message: "Scene revision is not loaded yet." };
  }

  const historyContext = {
    api: context.api,
    authoringHistory: context.authoringHistory,
    resourceData: context.resourceData,
    selection: context.selection,
    sessionScopeKey,
    isCurrentSessionScope: context.isCurrentSessionScope,
  };

  const response = await runAuthoringMutationWithHistory(
    historyContext,
    historyLabel,
    (before) => {
      if (before.baseRevision !== null && before.baseRevision !== baseRevision) {
        throw new Error(
          "The scene changed before assigning magnetization. Retry on the refreshed scene.",
        );
      }
      return context.api!.model.applyMagnetization(applyTarget, {
        baseRevision,
        sessionScopeKey,
      });
    },
    undefined,
    { expectedSceneRevision: baseRevision },
  );

  const obsoleteAfterApply = obsoleteSessionResult(context);
  if (obsoleteAfterApply) return obsoleteAfterApply;

  const revision = acknowledgedAuthoringSceneRevision(response);
  if (context.resources) {
    if ("publish" in context.resources && typeof context.resources.publish === "function") {
      publishCommittedSceneResource(
        context.resources as never,
        response.committed_scene,
        revision,
        undefined,
        false,
        sessionScopeKey,
        context.api.resourceCacheScope,
      );
    }
    invalidateAuthoringMutationDependents(context.resources, "magnetization", revision);
  }
  await syncScriptBestEffort(context, sessionScopeKey);
  const obsoleteAfterSync = obsoleteSessionResult(context);
  if (obsoleteAfterSync) return obsoleteAfterSync;

  return { status: "completed" };
}

async function assignPreset(
  context: CommandContext,
  presetKind: MagnetizationTexturePresetId,
): Promise<CommandResult> {
  const target = selectedTarget(context);
  if (!target || !context.api) {
    return {
      status: "failed",
      message: disabledReason(context) ?? "Magnetization target unavailable.",
    };
  }
  const scene = selectedScene(context);
  const applyTarget = buildPresetApplyTarget(scene, target, presetKind);
  const scopeLabel = target.kind === "region" ? target.regionId : target.objectId;
  return executeAtomicMagnetizationApply(
    context,
    `Assign ${canonicalPresetKind(presetKind)} magnetization (${scopeLabel})`,
    applyTarget,
  );
}

function presetCommand(
  id: string,
  title: string,
  presetKind: MagnetizationTexturePresetId,
): CommandContribution {
  return {
    category: "magnetization-texture",
    disabledReason,
    group: "magnetization-texture",
    id,
    isEnabled: (context) => disabledReason(context) === null,
    run: (context) => assignPreset(context, presetKind),
    scope: "selection",
    title,
  };
}

function gizmoModeCommand(
  id: string,
  title: string,
  mode: TextureGizmoMode,
): CommandContribution {
  return {
    category: "magnetization-texture",
    disabledReason: loadFileDisabledReason,
    group: "magnetization-texture",
    id,
    isEnabled: (context) => loadFileDisabledReason(context) === null,
    run: () => {
      setTextureGizmoMode(mode);
      return { status: "completed" };
    },
    scope: "selection",
    title,
  };
}

function transformScopeCommand(
  id: string,
  title: string,
  scope: TransformScopeMode,
): CommandContribution {
  return {
    category: "magnetization-texture",
    group: "magnetization-texture",
    id,
    isEnabled: () => true,
    run: () => {
      setTransformScope(scope);
      return { status: "completed" };
    },
    scope: "global",
    title,
  };
}

export const MAGNETIZATION_TEXTURE_COMMANDS: CommandContribution[] = [
  {
    category: "magnetization-texture",
    disabledReason: loadFileDisabledReason,
    group: "magnetization-texture",
    id: "magnetization-texture.activate-load-file",
    isEnabled: (context) => loadFileDisabledReason(context) === null,
    run: (context) => {
      const target = selectedTarget(context);
      if (!target) {
        return {
          status: "failed",
          message:
            loadFileDisabledReason(context) ?? "Magnetization target unavailable.",
        };
      }
      requestTextureInspectorTab(target, "field-file");
      return {
        status: "completed",
        message: "Field file mode activated.",
      };
    },
    scope: "selection",
    title: "Load Texture from Field File",
  },
  {
    category: "magnetization-texture",
    disabledReason: loadFileDisabledReason,
    group: "magnetization-texture",
    id: "magnetization-texture.toggle-gizmo",
    isEnabled: (context) => loadFileDisabledReason(context) === null,
    run: () => {
      const enabled = toggleTextureGizmo();
      return {
        status: "completed",
        message: enabled ? "3D texture gizmo enabled." : "3D texture gizmo hidden.",
      };
    },
    scope: "selection",
    title: "Toggle 3D Texture Gizmo",
  },
  gizmoModeCommand(
    "magnetization-texture.gizmo-mode-view",
    "Texture Gizmo: View [Q]",
    "view",
  ),
  gizmoModeCommand(
    "magnetization-texture.gizmo-mode-translate",
    "Texture Gizmo: Translate [W]",
    "translate",
  ),
  gizmoModeCommand(
    "magnetization-texture.gizmo-mode-rotate",
    "Texture Gizmo: Rotate [E]",
    "rotate",
  ),
  gizmoModeCommand(
    "magnetization-texture.gizmo-mode-scale",
    "Texture Gizmo: Scale [R]",
    "scale",
  ),
  transformScopeCommand(
    "magnetization-texture.scope-object",
    "Transform Scope: Object",
    "object",
  ),
  transformScopeCommand(
    "magnetization-texture.scope-texture",
    "Transform Scope: Texture",
    "texture",
  ),
  {
    category: "magnetization-texture",
    disabledReason,
    group: "magnetization-texture",
    id: "magnetization-texture.fit-characteristic-size",
    isEnabled: (context) => disabledReason(context) === null,
    run: async (context) => {
      if (runActiveTextureFitCharacteristicSize()) {
        return { status: "completed", message: "Characteristic size fitted in active draft." };
      }
      const target = selectedTarget(context);
      const scene = selectedScene(context);
      if (!target || !scene) {
        return { status: "failed", message: "Select a magnetic object or region first." };
      }
      const bounds = resolveTargetBoundsMeters(scene, target);
      const obj = scene.objects?.find((o) => o.id === target.objectId);
      const currentInit =
        target.kind === "region"
          ? obj?.regions?.find((r) => r.region_id === target.regionId)?.texture_override
              ?.initial_magnetization
          : scene.magnetization_assets?.find((a) => a.id === obj?.magnetization_ref);
      const hydrated = hydrateMagneticTextureDraftFromInitializer(
        currentInit,
        bounds,
        target.kind === "region" ? "region" : "object",
      );
      const fitted = fitCharacteristicSizeToTarget(
        { ...hydrated, inheritanceMode: "override" },
        bounds,
      );
      const initializer = serializeMagneticTextureDraftToInitializer(fitted, bounds);
      const applyTarget: MagnetizationApplyTarget =
        target.kind === "region"
          ? {
              kind: "region",
              object_id: target.objectId,
              region_id: target.regionId,
              texture_override: { initial_magnetization: initializer as never },
            }
          : {
              kind: "object",
              object_id: target.objectId,
              asset: presetMagnetizationAsset({
                id: magnetizationTextureAssetId(target, canonicalPresetKind(fitted.presetKind)),
                label: fitted.customUiLabel.trim() || null,
                presetKind: canonicalPresetKind(fitted.presetKind),
                presetVersion: 2,
                presetParams: (initializer.preset_params ?? {}) as never,
                mapping: (initializer.mapping ?? null) as never,
                textureTransform: (initializer.texture_transform ?? null) as never,
              }),
            };
      return executeAtomicMagnetizationApply(
        context,
        "Fit characteristic texture size",
        applyTarget,
      );
    },
    scope: "selection",
    title: "Fit Characteristic Size to Target",
  },
  {
    category: "magnetization-texture",
    disabledReason,
    group: "magnetization-texture",
    id: "magnetization-texture.reset-transform",
    isEnabled: (context) => disabledReason(context) === null,
    run: async (context) => {
      if (runActiveTextureResetTransform()) {
        return { status: "completed", message: "Texture transform reset in active draft." };
      }
      const target = selectedTarget(context);
      const scene = selectedScene(context);
      if (!target || !scene) {
        return { status: "failed", message: "Select a magnetic object or region first." };
      }
      const bounds = resolveTargetBoundsMeters(scene, target);
      const obj = scene.objects?.find((o) => o.id === target.objectId);
      const currentInit =
        target.kind === "region"
          ? obj?.regions?.find((r) => r.region_id === target.regionId)?.texture_override
              ?.initial_magnetization
          : scene.magnetization_assets?.find((a) => a.id === obj?.magnetization_ref);
      const hydrated = hydrateMagneticTextureDraftFromInitializer(
        currentInit,
        bounds,
        target.kind === "region" ? "region" : "object",
      );
      const reset = resetDraftTransform(
        { ...hydrated, inheritanceMode: "override" },
        bounds,
      );
      const initializer = serializeMagneticTextureDraftToInitializer(reset, bounds);
      const applyTarget: MagnetizationApplyTarget =
        target.kind === "region"
          ? {
              kind: "region",
              object_id: target.objectId,
              region_id: target.regionId,
              texture_override: { initial_magnetization: initializer as never },
            }
          : {
              kind: "object",
              object_id: target.objectId,
              asset: presetMagnetizationAsset({
                id: magnetizationTextureAssetId(target, canonicalPresetKind(reset.presetKind)),
                label: reset.customUiLabel.trim() || null,
                presetKind: canonicalPresetKind(reset.presetKind),
                presetVersion: 2,
                presetParams: (initializer.preset_params ?? {}) as never,
                mapping: (initializer.mapping ?? null) as never,
                textureTransform: (initializer.texture_transform ?? null) as never,
              }),
            };
      return executeAtomicMagnetizationApply(context, "Reset texture transform", applyTarget);
    },
    scope: "selection",
    title: "Reset Texture Transform",
  },

  // All 20 analytic presets (16 + 4 Wave-2 extensions)
  presetCommand(
    "magnetization-texture.assign-uniform",
    "Assign Uniform Magnetization",
    "uniform",
  ),
  presetCommand(
    "magnetization-texture.assign-random-seeded",
    "Assign Random Seeded Magnetization",
    "random",
  ),
  presetCommand(
    "magnetization-texture.assign-random",
    "Assign Random Magnetization",
    "random",
  ),
  presetCommand(
    "magnetization-texture.assign-vortex",
    "Assign Vortex Magnetization",
    "vortex",
  ),
  presetCommand(
    "magnetization-texture.assign-antivortex",
    "Assign Antivortex Magnetization",
    "antivortex",
  ),
  presetCommand(
    "magnetization-texture.assign-bloch-skyrmion",
    "Assign Bloch Skyrmion Magnetization",
    "bloch_skyrmion",
  ),
  presetCommand(
    "magnetization-texture.assign-neel-skyrmion",
    "Assign Néel Skyrmion Magnetization",
    "neel_skyrmion",
  ),
  presetCommand(
    "magnetization-texture.assign-antiskyrmion",
    "Assign Antiskyrmion Magnetization",
    "antiskyrmion",
  ),
  presetCommand(
    "magnetization-texture.assign-skyrmionium",
    "Assign Skyrmionium Magnetization",
    "skyrmionium",
  ),
  presetCommand(
    "magnetization-texture.assign-bimeron",
    "Assign Bimeron Magnetization",
    "bimeron",
  ),
  presetCommand(
    "magnetization-texture.assign-skyrmion-lattice",
    "Assign Skyrmion Lattice Magnetization",
    "skyrmion_lattice",
  ),
  presetCommand(
    "magnetization-texture.assign-domain-wall",
    "Assign Domain Wall Magnetization",
    "domain_wall",
  ),
  presetCommand(
    "magnetization-texture.assign-two-domain",
    "Assign Two Domain Magnetization",
    "two_domain",
  ),
  presetCommand(
    "magnetization-texture.assign-vortex-wall",
    "Assign Vortex Wall Magnetization",
    "vortex_wall",
  ),
  presetCommand(
    "magnetization-texture.assign-artificial-spin-ice",
    "Assign Artificial Spin Ice Magnetization",
    "artificial_spin_ice",
  ),
  presetCommand(
    "magnetization-texture.assign-helical",
    "Assign Helical Magnetization",
    "helical",
  ),
  presetCommand(
    "magnetization-texture.assign-conical",
    "Assign Conical Magnetization",
    "conical",
  ),
  presetCommand(
    "magnetization-texture.assign-spiral",
    "Assign Spiral Magnetization",
    "spiral",
  ),
  presetCommand(
    "magnetization-texture.assign-hopfion",
    "Assign Hopfion Magnetization",
    "hopfion",
  ),
  presetCommand(
    "magnetization-texture.assign-hopfion-compact-support",
    "Assign Hopfion (Compact Support) Magnetization",
    "hopfion_compact_support",
  ),
  presetCommand(
    "magnetization-texture.assign-bloch-point",
    "Assign Bloch Point Magnetization",
    "bloch_point",
  ),
];

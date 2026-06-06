import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject } from "@/kernel/api/apiTypes";
import type {
  CommandContext,
  CommandContribution,
  CommandResult,
} from "@/kernel/commands/commandTypes";
import {
  MODEL_REGIONS_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  VISUALIZATION_STATE_RESOURCE_KEY,
} from "@/kernel/resources/geometryLifecycleResources";

import {
  magnetizationTextureAssetId,
  presetMagnetizationAsset,
} from "@/shared/domain/magnetization-texture/assetFactory";
import { resolveMagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/targetResolver";
import type { MagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/types";

function selectedTarget(context: CommandContext): MagnetizationTextureTarget | null {
  const selection = context.selection?.get();
  const ref = selection?.ref?.type === "scene-object" ? selection.ref : null;
  return resolveMagnetizationTextureTarget({
    kind: selection?.kind,
    objectId: ref?.objectId ?? selection?.objectId,
    regionId: ref?.regionId,
  });
}

function disabledReason(context: CommandContext): string | null {
  if (!selectedTarget(context)) {
    return "Select an object or region texture target.";
  }
  if (!context.api) {
    return "Control Room API is not available.";
  }
  return null;
}

function loadFileDisabledReason(context: CommandContext): string | null {
  const target = selectedTarget(context);
  if (!target) {
    return "Select an object texture target.";
  }
  if (target.kind !== "object") {
    return "Field-state texture loading is available on object texture targets.";
  }
  return null;
}

function sceneRevision(context: CommandContext): number | null {
  const scene = context.resourceData?.[MODEL_SCENE_PATH];
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) return null;
  const revision = (scene as Record<string, unknown>).revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

import type { MagnetizationTexturePresetId } from "@/shared/domain/magnetization-texture/texturePresets";

async function assignPreset(
  context: CommandContext,
  presetKind: MagnetizationTexturePresetId,
  presetParams: JsonObject,
): Promise<CommandResult> {
  const target = selectedTarget(context);
  if (!target || !context.api) {
    return {
      status: "failed",
      message: disabledReason(context) ?? "Magnetization target unavailable.",
    };
  }

  const assetId = magnetizationTextureAssetId(target, presetKind);
  const assetResponse = await context.api.model.patchMagnetizationAsset(
    assetId,
    {
      asset: presetMagnetizationAsset({
        id: assetId,
        presetKind,
        presetParams,
      }),
      base_revision: sceneRevision(context),
    },
  );

  if (target.kind === "region") {
    await context.api.model.patchObjectRegionResource(
      target.objectId,
      target.regionId,
      {
        magnetization_ref: assetId,
      },
      { baseRevision: assetResponse.scene_revision ?? undefined },
    );
  } else {
    await context.api.model.patchObject(target.objectId, {
      base_revision: assetResponse.scene_revision,
      magnetization_ref: assetId,
    });
  }

  const revision = assetResponse.scene_revision ?? Date.now();
  context.resources?.invalidate(SCENE_RESOURCE_KEY, revision);
  context.resources?.invalidate(MODEL_REGIONS_RESOURCE_KEY, revision);
  context.resources?.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, revision);
  return { status: "completed" };
}

function presetCommand(
  id: string,
  title: string,
  presetKind: MagnetizationTexturePresetId,
  presetParams: JsonObject,
): CommandContribution {
  return {
    category: "magnetization-texture",
    disabledReason,
    group: "magnetization-texture",
    id,
    isEnabled: (context) => disabledReason(context) === null,
    run: (context) => assignPreset(context, presetKind, presetParams),
    scope: "selection",
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
      if (!target || target.kind !== "object") {
        return {
          status: "failed",
          message:
            loadFileDisabledReason(context) ??
            "Object texture target unavailable.",
        };
      }
      context.bus?.emit("explorer:texture-load-node-requested", {
        objectId: target.objectId,
        source: context.source === "test" ? "explorer" : context.source,
      });
      return {
        status: "completed",
        message: "Load texture node activated.",
      };
    },
    scope: "selection",
    title: "Load Texture",
  },
  presetCommand(
    "magnetization-texture.assign-uniform",
    "Assign Uniform Magnetization",
    "uniform",
    { direction: [1, 0, 0] },
  ),
  presetCommand(
    "magnetization-texture.assign-random-seeded",
    "Assign Random Seeded Magnetization",
    "random_seeded",
    { seed: 1 },
  ),
  presetCommand(
    "magnetization-texture.assign-vortex",
    "Assign Vortex Magnetization",
    "vortex",
    { plane: "xy", circulation: 1, core_polarity: 1, core_radius: 1e-9 },
  ),
  presetCommand(
    "magnetization-texture.assign-antivortex",
    "Assign Antivortex Magnetization",
    "antivortex",
    { plane: "xy", circulation: 1, core_polarity: 1, core_radius: 1e-9 },
  ),
  presetCommand(
    "magnetization-texture.assign-bloch-skyrmion",
    "Assign Bloch Skyrmion Magnetization",
    "bloch_skyrmion",
    { plane: "xy", radius: 10e-9, wall_width: 2e-9, core_polarity: -1, chirality: 1 },
  ),
  presetCommand(
    "magnetization-texture.assign-neel-skyrmion",
    "Assign Néel Skyrmion Magnetization",
    "neel_skyrmion",
    { plane: "xy", radius: 10e-9, wall_width: 2e-9, core_polarity: -1, chirality: 1 },
  ),
  presetCommand(
    "magnetization-texture.assign-domain-wall",
    "Assign Domain Wall Magnetization",
    "domain_wall",
    { normal_axis: "x", center_offset: 0.0, width: 10e-9, left: [1, 0, 0], right: [-1, 0, 0], kind: "neel" },
  ),
  presetCommand(
    "magnetization-texture.assign-two-domain",
    "Assign Two Domain Magnetization",
    "two_domain",
    { normal_axis: "x", left: [1, 0, 0], right: [-1, 0, 0], wall: [0, 1, 0] },
  ),
  presetCommand(
    "magnetization-texture.assign-helical",
    "Assign Helical Magnetization",
    "helical",
    { wavevector: [1, 0, 0], e1: [1, 0, 0], e2: [0, 1, 0], phase_rad: 0.0 },
  ),
  presetCommand(
    "magnetization-texture.assign-conical",
    "Assign Conical Magnetization",
    "conical",
    { wavevector: [1, 0, 0], cone_axis: [0, 0, 1], phase_rad: 0.0, cone_angle_rad: 0.785398 },
  ),
];

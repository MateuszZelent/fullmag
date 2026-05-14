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

function sceneRevision(context: CommandContext): number | null {
  const scene = context.resourceData?.[MODEL_SCENE_PATH];
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) return null;
  const revision = (scene as Record<string, unknown>).revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

async function assignPreset(
  context: CommandContext,
  presetKind: "random_seeded" | "uniform" | "vortex",
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
    await context.api.model.patchRegion(target.regionId, {
      magnetization_ref: assetId,
    });
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
  presetKind: "random_seeded" | "uniform" | "vortex",
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
    { chirality: 1, polarity: 1 },
  ),
];

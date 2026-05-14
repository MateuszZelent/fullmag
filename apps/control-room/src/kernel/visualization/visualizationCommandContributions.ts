import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import type { CommandContext, CommandContribution } from "../commands/commandTypes";

import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  renderModePatch,
  resolveVisualizationTargetFromSelection,
  type SurfaceColorSource,
  type VisualizationColorMode,
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "./ObjectVisualizationController";

function selectedTarget(context: CommandContext) {
  const selection = context.selection?.get();
  return selection ? resolveVisualizationTargetFromSelection(selection) : null;
}

function targetCommandEnabled(context: CommandContext): boolean {
  return Boolean(context.visualization && selectedTarget(context));
}

function targetCommandDisabledReason(context: CommandContext): string | null {
  if (!context.visualization) return "Visualization registry is unavailable.";
  if (!selectedTarget(context)) return "Select an object, mesh part, or airbox.";
  return null;
}

async function patchSelectedTarget(
  context: CommandContext,
  patch: VisualizationTargetPatch,
) {
  const target = selectedTarget(context);
  const visualization = context.visualization;
  if (!target || !visualization) {
    return {
      status: "failed" as const,
      message: targetCommandDisabledReason(context) ?? "Target unavailable.",
    };
  }

  if (target.kind !== "airbox") {
    if (!(await patchTargetOverrideResource(context, target, patch))) {
      visualization.patchTarget(target, patch);
    }
    return { status: "completed" as const };
  }

  const localPatch = airboxLocalVisualizationPatchFromTargetPatch(patch);
  const statePatch = airboxVisualizationStatePatchFromTargetPatch(patch);
  if (Object.keys(localPatch).length > 0) {
    visualization.patchTarget(target, localPatch);
  }
  if (!hasVisualizationStatePatch(statePatch)) {
    return { status: "completed" as const };
  }
  if (!context.api || !context.resources) {
    return {
      status: "failed" as const,
      message: "Visualization API is unavailable.",
    };
  }

  const next = await context.api.visualization.patch(statePatch);
  context.resources.invalidate(VISUALIZATION_STATE_PATH, next.revision);
  return { status: "completed" as const };
}

async function patchTargetOverrideResource(
  context: CommandContext,
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
  basePatch: VisualizationStatePatch = {},
): Promise<boolean> {
  const state = visualizationStateFromContext(context);
  if (!context.api || !context.resources || !state) {
    return false;
  }

  const next = await context.api.visualization.patch({
    ...basePatch,
    overrides: mergeVisualizationStateTargetOverride(
      state.overrides ?? [],
      target,
      patch,
    ),
  });
  context.resources.invalidate(VISUALIZATION_STATE_PATH, next.revision);
  return true;
}

async function clearTargetOverrideResource(
  context: CommandContext,
  target: VisualizationTargetRef,
): Promise<boolean> {
  const state = visualizationStateFromContext(context);
  if (!context.api || !context.resources || !state) {
    return false;
  }

  const next = await context.api.visualization.patch({
    overrides: (state.overrides ?? []).filter(
      (entry) => !(entry.scope === target.kind && entry.scope_id === target.id),
    ),
  });
  context.resources.invalidate(VISUALIZATION_STATE_PATH, next.revision);
  return true;
}

function visualizationStateFromContext(
  context: CommandContext,
): VisualizationStateResource | null {
  const value = context.resourceData?.[VISUALIZATION_STATE_PATH];
  return value && typeof value === "object"
    ? (value as VisualizationStateResource)
    : null;
}

function booleanPayload(context: CommandContext): boolean | null {
  return typeof context.input === "boolean" ? context.input : null;
}

function numberPayload(context: CommandContext): number | null {
  return typeof context.input === "number" && Number.isFinite(context.input)
    ? context.input
    : null;
}

function stringPayload(context: CommandContext): string | null {
  return typeof context.input === "string" ? context.input : null;
}

function invalidPayload(commandId: string) {
  return {
    status: "failed" as const,
    message: `Invalid payload for ${commandId}.`,
  };
}

function boolPatchCommand(
  id: string,
  title: string,
  patchKey: keyof Pick<
    VisualizationTargetPatch,
    | "boundsVisible"
    | "pointsVisible"
    | "shaderVisible"
    | "vectorsVisible"
    | "visible"
    | "wireframeVisible"
  >,
): CommandContribution {
  return {
    id,
    title,
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = booleanPayload(context);
      return value === null
        ? invalidPayload(id)
        : patchSelectedTarget(context, {
            [patchKey]: value,
          } as VisualizationTargetPatch);
    },
  };
}

function numberPatchCommand(
  id: string,
  title: string,
  patchKey: keyof Pick<
    VisualizationTargetPatch,
    | "opacityPercent"
    | "vectorAlphaPercent"
    | "vectorThickness"
    | "wireframeOpacityPercent"
  >,
): CommandContribution {
  return {
    id,
    title,
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = numberPayload(context);
      return value === null
        ? invalidPayload(id)
        : patchSelectedTarget(context, {
            [patchKey]: value,
          } as VisualizationTargetPatch);
    },
  };
}

function stringPatchCommand(
  id: string,
  title: string,
  patchKey: keyof Pick<
    VisualizationTargetPatch,
    "shaderMonoColor" | "vectorMonoColor" | "wireframeColor"
  >,
): CommandContribution {
  return {
    id,
    title,
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = stringPayload(context);
      return value === null
        ? invalidPayload(id)
        : patchSelectedTarget(context, {
            ...(patchKey === "shaderMonoColor"
              ? { surfaceColorSource: "solid" }
              : {}),
            [patchKey]: value,
          } as VisualizationTargetPatch);
    },
  };
}

export const VISUALIZATION_TARGET_COMMANDS: CommandContribution[] = [
  boolPatchCommand(
    "visualization.target.set-visible",
    "Set selected target visibility",
    "visible",
  ),
  boolPatchCommand(
    "visualization.target.set-surface-visible",
    "Set selected target surface visibility",
    "shaderVisible",
  ),
  boolPatchCommand(
    "visualization.target.set-vectors-visible",
    "Set selected target vector visibility",
    "vectorsVisible",
  ),
  boolPatchCommand(
    "visualization.target.set-wireframe-visible",
    "Set selected target wireframe visibility",
    "wireframeVisible",
  ),
  boolPatchCommand(
    "visualization.target.set-bounds-visible",
    "Set selected target frame visibility",
    "boundsVisible",
  ),
  boolPatchCommand(
    "visualization.target.set-points-visible",
    "Set selected target point visibility",
    "pointsVisible",
  ),
  numberPatchCommand(
    "visualization.target.set-opacity-percent",
    "Set selected target opacity",
    "opacityPercent",
  ),
  numberPatchCommand(
    "visualization.target.set-vector-alpha-percent",
    "Set selected target vector alpha",
    "vectorAlphaPercent",
  ),
  numberPatchCommand(
    "visualization.target.set-vector-thickness",
    "Set selected target vector thickness",
    "vectorThickness",
  ),
  numberPatchCommand(
    "visualization.target.set-wireframe-opacity-percent",
    "Set selected target wireframe opacity",
    "wireframeOpacityPercent",
  ),
  stringPatchCommand(
    "visualization.target.set-shader-mono-color",
    "Set selected target solid color",
    "shaderMonoColor",
  ),
  stringPatchCommand(
    "visualization.target.set-vector-mono-color",
    "Set selected target vector color",
    "vectorMonoColor",
  ),
  stringPatchCommand(
    "visualization.target.set-wireframe-color",
    "Set selected target wireframe color",
    "wireframeColor",
  ),
  {
    id: "visualization.target.set-surface-color-source",
    title: "Set selected target surface color source",
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = stringPayload(context);
      if (!value) return invalidPayload("visualization.target.set-surface-color-source");
      if (value === "inherit") {
        return patchSelectedTarget(context, {
          shaderColorMode: undefined,
          surfaceColorSource: undefined,
        });
      }
      return patchSelectedTarget(context, {
        surfaceColorSource: value as SurfaceColorSource,
      });
    },
  },
  {
    id: "visualization.target.set-vector-color-mode",
    title: "Set selected target vector color mode",
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = stringPayload(context);
      return value
        ? patchSelectedTarget(context, {
            vectorColorMode: value as VisualizationColorMode,
          })
        : invalidPayload("visualization.target.set-vector-color-mode");
    },
  },
  {
    id: "visualization.target.set-render-mode",
    title: "Set selected target render mode",
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = stringPayload(context);
      return value
        ? patchSelectedTarget(
            context,
            renderModePatch(value as VisualizationRenderMode),
          )
        : invalidPayload("visualization.target.set-render-mode");
    },
  },
  {
    id: "visualization.target.set-geometry-scope",
    title: "Set selected target geometry scope",
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: (context) => {
      const value = stringPayload(context);
      return value
        ? patchSelectedTarget(context, {
            geometryScope: value as VisualizationGeometryScope,
          })
        : invalidPayload("visualization.target.set-geometry-scope");
    },
  },
  {
    id: "visualization.target.clear-overrides",
    title: "Clear selected target visualization overrides",
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetCommandDisabledReason,
    isEnabled: targetCommandEnabled,
    run: async (context) => {
      const target = selectedTarget(context);
      const visualization = context.visualization;
      if (!target || !visualization) {
        return {
          status: "failed" as const,
          message: targetCommandDisabledReason(context) ?? "Target unavailable.",
        };
      }
      if (!(await clearTargetOverrideResource(context, target))) {
        visualization.clearTarget(target);
      }
      return { status: "completed" as const };
    },
  },
];

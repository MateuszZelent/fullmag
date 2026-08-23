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
  isFdmUniverseOutsideSupportTarget,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  removeTargetOverrideField,
  renderModePatch,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  visualizationTargetUnsupportedPatchFields,
  viewportRenderingPreferencesFromTargetPatch,
  visualizationStateOverrideMatchesTarget,
  visualizationTargetKey,
  type SurfaceColorSource,
  type VisualizationColorMode,
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "./ObjectVisualizationController";

function selectedTarget(context: CommandContext) {
  if (context.visualizationTarget) return context.visualizationTarget;
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

function targetPassCommandEnabled(context: CommandContext): boolean {
  const target = selectedTarget(context);
  const visualization = context.visualization;
  if (!target || !visualization) return false;
  return resolveTargetVisualization({
    snapshot: visualization.getSnapshot(),
    target,
    visualizationState: visualizationStateFromContext(context),
  }).settings.visible;
}

function targetPassCommandDisabledReason(context: CommandContext): string | null {
  const unavailableReason = targetCommandDisabledReason(context);
  if (unavailableReason) return unavailableReason;
  return targetPassCommandEnabled(context)
    ? null
    : "Show the selected target before changing its display passes or style.";
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

  const unsupportedFields = visualizationTargetUnsupportedPatchFields(
    target,
    patch,
  );
  if (unsupportedFields.length > 0) {
    return {
      status: "failed" as const,
      message: `The selected target does not support ${unsupportedFields.join(", ")}.`,
    };
  }

  if (target.kind !== "airbox") {
    const viewportPreferences = viewportRenderingPreferencesFromTargetPatch(patch);
    if (Object.keys(viewportPreferences).length > 0) {
      visualization.patchViewportPreferences(target, viewportPreferences);
    }
    const persistentPatch = persistentVisualizationTargetPatch(patch);
    if (Object.keys(persistentPatch).length > 0) {
      const persisted = await patchTargetOverrideResource(
        context,
        target,
        persistentPatch,
      );
      if (!persisted) {
        if (!context.visualizationSync && !context.api) {
          visualization.patchTarget(target, persistentPatch);
        } else {
          return {
            status: "failed" as const,
            message: "Visualization state resource is unavailable.",
          };
        }
      }
    }
    return { status: "completed" as const };
  }

  const localPatch = airboxLocalVisualizationPatchFromTargetPatch(patch);
  const state = visualizationStateFromContext(context);
  const statePatch = airboxVisualizationStatePatchFromTargetPatch(
    patch,
    state ? state.overrides ?? [] : undefined,
  );
  if (Object.keys(localPatch).length > 0) {
    visualization.patchViewportPreferences(target, localPatch);
  }
  if (!hasVisualizationStatePatch(statePatch)) {
    return { status: "completed" as const };
  }
  if (!context.visualizationSync && (!context.api || !context.resources)) {
    return {
      status: "failed" as const,
      message: "Visualization API is unavailable.",
    };
  }

  await patchVisualizationState(context, statePatch, [visualizationTargetKey(target)]);
  return { status: "completed" as const };
}

async function patchTargetOverrideResource(
  context: CommandContext,
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
  basePatch: VisualizationStatePatch = {},
): Promise<boolean> {
  const state = visualizationStateFromContext(context);
  if ((!context.visualizationSync && (!context.api || !context.resources)) || !state) {
    return false;
  }

  const receipt = await patchVisualizationState(
    context,
    {
      ...basePatch,
      overrides: mergeVisualizationStateTargetOverride(
        state.overrides ?? [],
        target,
        patch,
      ),
    },
    [visualizationTargetKey(target)],
  );
  if (receipt) {
    context.visualization?.patchTargetPending(
      target,
      patch,
      state.revision,
      receipt.transactionId,
    );
  }
  return true;
}

async function clearTargetOverrideResource(
  context: CommandContext,
  target: VisualizationTargetRef,
): Promise<boolean> {
  const state = visualizationStateFromContext(context);
  if ((!context.visualizationSync && (!context.api || !context.resources)) || !state) {
    return false;
  }

  await patchVisualizationState(
    context,
    {
      overrides: (state.overrides ?? []).filter(
        (entry) => !visualizationStateOverrideMatchesTarget(entry, target),
      ),
    },
    [visualizationTargetKey(target)],
  );
  context.visualization?.clearPendingTarget(target);
  return true;
}

async function removeTargetOverrideFieldResource(
  context: CommandContext,
  target: VisualizationTargetRef,
  field: keyof VisualizationTargetPatch,
): Promise<boolean> {
  const state = visualizationStateFromContext(context);
  if ((!context.visualizationSync && (!context.api || !context.resources)) || !state) {
    return false;
  }

  await patchVisualizationState(
    context,
    {
      overrides: removeTargetOverrideField(state.overrides ?? [], target, field),
    },
    [visualizationTargetKey(target)],
  );
  return true;
}

async function patchVisualizationState(
  context: CommandContext,
  patch: VisualizationStatePatch,
  targetIds: readonly string[] = [],
): Promise<{ transactionId: string } | null> {
  if (context.visualizationSync) {
    return context.visualizationSync.queuePatch(patch, targetIds);
  }

  const next = await context.api?.visualization.patch(patch);
  if (next) {
    context.resources?.invalidate(VISUALIZATION_STATE_PATH, next.revision);
  }
  return null;
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
  options: { passOnly?: boolean } = {},
): CommandContribution {
  return {
    id,
    title,
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: options.passOnly
      ? targetPassCommandDisabledReason
      : targetCommandDisabledReason,
    isEnabled: options.passOnly ? targetPassCommandEnabled : targetCommandEnabled,
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
    | "surfaceOpacityPercent"
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
    disabledReason: targetPassCommandDisabledReason,
    isEnabled: targetPassCommandEnabled,
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
    "pointColor" | "shaderMonoColor" | "vectorMonoColor" | "wireframeColor"
  >,
): CommandContribution {
  return {
    id,
    title,
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetPassCommandDisabledReason,
    isEnabled: targetPassCommandEnabled,
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
    { passOnly: true },
  ),
  boolPatchCommand(
    "visualization.target.set-vectors-visible",
    "Set selected target vector visibility",
    "vectorsVisible",
    { passOnly: true },
  ),
  boolPatchCommand(
    "visualization.target.set-wireframe-visible",
    "Set selected target wireframe visibility",
    "wireframeVisible",
    { passOnly: true },
  ),
  boolPatchCommand(
    "visualization.target.set-bounds-visible",
    "Set selected target frame visibility",
    "boundsVisible",
    { passOnly: true },
  ),
  boolPatchCommand(
    "visualization.target.set-points-visible",
    "Set selected target point visibility",
    "pointsVisible",
    { passOnly: true },
  ),
  numberPatchCommand(
    "visualization.target.set-opacity-percent",
    "Set selected target surface opacity",
    "surfaceOpacityPercent",
  ),
  numberPatchCommand(
    "visualization.target.set-vector-alpha-percent",
    "Set selected target vector opacity",
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
    "visualization.target.set-point-color",
    "Set selected target point color",
    "pointColor",
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
    disabledReason: targetPassCommandDisabledReason,
    isEnabled: targetPassCommandEnabled,
    run: async (context) => {
      const value = stringPayload(context);
      if (!value) return invalidPayload("visualization.target.set-surface-color-source");
      if (value === "inherit") {
        const target = selectedTarget(context);
        const visualization = context.visualization;
        if (!target || !visualization) {
          return {
            status: "failed" as const,
            message: targetCommandDisabledReason(context) ?? "Target unavailable.",
          };
        }
        if (
          visualizationTargetUnsupportedPatchFields(target, {
            surfaceColorSource: "solid",
          }).length > 0
        ) {
          return {
            status: "failed" as const,
            message: "The selected target does not support surfaceColorSource.",
          };
        }
        if (
          target.kind !== "airbox" &&
          (await removeTargetOverrideFieldResource(
            context,
            target,
            "surfaceColorSource",
          ))
        ) {
          visualization.removeTargetOverrideField(target, "surfaceColorSource");
          return { status: "completed" as const };
        }
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
    disabledReason: targetPassCommandDisabledReason,
    isEnabled: targetPassCommandEnabled,
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
    disabledReason: targetPassCommandDisabledReason,
    isEnabled: targetPassCommandEnabled,
    run: (context) => {
      const value = stringPayload(context);
      if (!value) return invalidPayload("visualization.target.set-render-mode");
      const target = selectedTarget(context);
      const renderMode = value as VisualizationRenderMode | "off";
      return patchSelectedTarget(
        context,
        target && isFdmUniverseOutsideSupportTarget(target)
          ? { renderMode }
          : renderModePatch(renderMode),
      );
    },
  },
  {
    id: "visualization.target.set-geometry-scope",
    title: "Set selected target geometry scope",
    group: "visualization",
    category: "visualization",
    scope: "selection",
    disabledReason: targetPassCommandDisabledReason,
    isEnabled: targetPassCommandEnabled,
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
        return {
          status: "failed" as const,
          message: "Visualization state resource is unavailable.",
        };
      }
      return { status: "completed" as const };
    },
  },
];

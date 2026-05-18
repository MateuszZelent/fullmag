import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type {
  CommandContext,
  CommandContribution,
  CommandResult,
} from "@/kernel/commands/commandTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import {
  BACKEND_INTERACTION_IDS,
  findInteractionSpec,
  type PhysicsInteractionId,
} from "@/shared/domain/physics/interactions";
import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  visualizationStatePatchFromDefaultTargetPatch,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";

export const RIBBON_VISUALIZATION_PATCH_STATE_COMMAND =
  "ribbon.visualization.patch-state";
export const RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND =
  "ribbon.visualization.patch-defaults";
export const RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND =
  "ribbon.visualization.patch-target";
const RIBBON_VISUALIZATION_CLEAR_TARGET_COMMAND =
  "ribbon.visualization.clear-target";
export const RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND =
  "ribbon.visualization.patch-airbox";
export const RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND =
  "ribbon.visualization.reset-airbox";
export const RIBBON_SELECTION_FOCUS_AIRBOX_COMMAND =
  "ribbon.selection.focus-airbox";
export const RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND =
  "ribbon.physics.select-interaction";

interface PatchDefaultsInput {
  patch: VisualizationTargetPatch;
  targetKinds: VisualizationTargetKind[];
}

interface PatchTargetInput {
  patch: VisualizationTargetPatch;
  target: VisualizationTargetRef;
}

export function visualizationStateCommandInput(
  patch: VisualizationStatePatch,
): VisualizationStatePatch {
  return patch;
}

export function visualizationDefaultsCommandInput(
  patch: VisualizationTargetPatch,
  targetKinds: VisualizationTargetKind[] = ["object", "part"],
): PatchDefaultsInput {
  return { patch, targetKinds };
}

export function visualizationTargetCommandInput(
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): PatchTargetInput {
  return { patch, target };
}

export function visualizationAirboxCommandInput(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  return patch;
}

export const RIBBON_COMMANDS: CommandContribution[] = [
  {
    id: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
    title: "Patch Visualization State",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    isEnabled: (context) => Boolean(context.api),
    disabledReason: (context) =>
      context.api ? null : "Control Room API is not available.",
    run: patchVisualizationStateFromCommand,
  },
  {
    id: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
    title: "Patch Visualization Defaults",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    run: patchVisualizationDefaultsFromCommand,
  },
  {
    id: RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
    title: "Patch Visualization Target",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    run: patchVisualizationTargetFromCommand,
  },
  {
    id: RIBBON_VISUALIZATION_CLEAR_TARGET_COMMAND,
    title: "Clear Visualization Target Overrides",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    run: clearVisualizationTargetFromCommand,
  },
  {
    id: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
    title: "Patch Airbox Visualization",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    run: patchAirboxVisualizationFromCommand,
  },
  {
    id: RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
    title: "Reset Airbox Visualization",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    run: resetAirboxVisualizationFromCommand,
  },
  {
    id: RIBBON_SELECTION_FOCUS_AIRBOX_COMMAND,
    title: "Focus Airbox",
    group: "ribbon-selection",
    category: "View",
    scope: "workspace",
    isEnabled: (context) => Boolean(context.selection),
    disabledReason: (context) =>
      context.selection ? null : "Selection controller is not available.",
    run: focusAirboxFromCommand,
  },
  {
    id: RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
    title: "Select Physics Interaction",
    group: "ribbon-physics",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) => Boolean(context.selection),
    disabledReason: (context) =>
      context.selection ? null : "Selection controller is not available.",
    run: selectPhysicsInteractionFromCommand,
  },
];

async function patchVisualizationStateFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.visualizationSync && !context.api) {
    return { message: "Control Room API is not available.", status: "failed" };
  }
  const patch = asRecord(context.input) as VisualizationStatePatch | null;
  if (!patch) {
    return { message: "Visualization state patch is missing.", status: "failed" };
  }

  await patchVisualizationState(context, patch);
  return { status: "completed" };
}

async function patchVisualizationDefaultsFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  const input = asPatchDefaultsInput(context.input);
  if (!input || !context.visualization) {
    return {
      message: "Visualization defaults input is missing.",
      status: "failed",
    };
  }

  for (const kind of input.targetKinds) {
    context.visualization.patchDefaults(kind, input.patch);
  }
  const statePatch = visualizationStatePatchFromDefaultTargetPatch(input.patch);
  if (
    (context.visualizationSync || context.api) &&
    hasVisualizationStatePatch(statePatch)
  ) {
    await patchVisualizationState(context, statePatch);
  }
  return { status: "completed" };
}

async function patchVisualizationTargetFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  const input = asPatchTargetInput(context.input);
  if (!input || !context.visualization) {
    return { message: "Visualization target input is missing.", status: "failed" };
  }

  if (input.target.kind === "airbox") {
    return patchAirboxVisualization(context, input.patch);
  }

  if (!(await patchTargetOverrideResource(context, input.target, input.patch))) {
    context.visualization.patchTarget(input.target, input.patch);
  }
  return { status: "completed" };
}

async function clearVisualizationTargetFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  const target = asVisualizationTargetRef(context.input);
  if (!target || !context.visualization) {
    return { message: "Visualization target input is missing.", status: "failed" };
  }

  if (!(await clearTargetOverrideResource(context, target))) {
    context.visualization.clearTarget(target);
  }
  return { status: "completed" };
}

async function patchAirboxVisualizationFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  const patch = asRecord(context.input) as VisualizationTargetPatch | null;
  if (!patch) {
    return { message: "Airbox visualization patch is missing.", status: "failed" };
  }
  return patchAirboxVisualization(context, patch);
}

async function resetAirboxVisualizationFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  if (context.visualizationSync || context.api) {
    await patchVisualizationState(
      context,
      airboxVisualizationStatePatchFromTargetPatch(DEFAULT_AIRBOX_VISUALIZATION),
    );
  }
  context.visualization?.clearTarget(AIRBOX_VISUALIZATION_TARGET);
  return { status: "completed" };
}

function focusAirboxFromCommand(context: CommandContext): CommandResult {
  context.selection?.set(
    {
      kind: "airbox.visualization",
      label: "Airbox Visualization",
      nodeId: "model:airbox:visualization",
      objectId: null,
    },
    context.source,
  );
  return { status: "completed" };
}

function selectPhysicsInteractionFromCommand(context: CommandContext): CommandResult {
  const input = asPhysicsInteractionInput(context.input);
  if (!input) {
    return {
      message: "Physics interaction input is missing.",
      status: "failed",
    };
  }

  const spec = findInteractionSpec(input.interactionId);
  if (!spec) {
    return {
      message: `Unknown physics interaction: ${input.interactionId}`,
      status: "failed",
    };
  }

  const current = context.selection?.get() as Selection | undefined;
  const objectId = current?.objectId ?? null;
  const regionId =
    current?.ref?.type === "scene-object" ? current.ref.regionId : undefined;
  const nodeId = objectId
    ? `model:object:${objectId}:physics:${input.interactionId}`
    : `model:physics:${input.interactionId}`;

  context.selection?.set(
    {
      kind: "object.physics",
      label: spec.label,
      nodeId,
      objectId,
      ref: objectId
        ? {
            kind: "object.physics",
            nodeId,
            objectId,
            ...(regionId ? { regionId } : {}),
            type: "scene-object",
            visualizationTargetId: `object:${objectId}`,
          }
        : null,
    },
    context.source,
  );
  return { status: "completed" };
}

async function patchAirboxVisualization(
  context: CommandContext,
  patch: VisualizationTargetPatch,
): Promise<CommandResult> {
  const localPatch = airboxLocalVisualizationPatchFromTargetPatch(patch);
  if (Object.keys(localPatch).length > 0) {
    context.visualization?.patchTarget(AIRBOX_VISUALIZATION_TARGET, localPatch);
  }

  const statePatch = airboxVisualizationStatePatchFromTargetPatch(patch);
  if (patch.geometryScope !== undefined) {
    const state = visualizationStateFromContext(context);
    if (state) {
      statePatch.overrides = mergeVisualizationStateTargetOverride(
        state.overrides ?? [],
        AIRBOX_VISUALIZATION_TARGET,
        { geometryScope: patch.geometryScope },
      );
    }
  }
  if (!hasVisualizationStatePatch(statePatch)) {
    return { status: "completed" };
  }

  if (!context.visualizationSync && !context.api) {
    context.visualization?.patchTarget(AIRBOX_VISUALIZATION_TARGET, patch);
    return { status: "completed" };
  }

  await patchVisualizationState(context, statePatch);
  return { status: "completed" };
}

async function patchVisualizationState(
  context: CommandContext,
  patch: VisualizationStatePatch,
): Promise<void> {
  if (context.visualizationSync) {
    context.visualizationSync.queuePatch(patch);
    return;
  }

  const state = await context.api?.visualization.patch(patch);
  if (state) {
    invalidateVisualizationState(context, state);
  }
}

function invalidateVisualizationState(
  context: CommandContext,
  state: Pick<VisualizationStateResource, "revision">,
): void {
  context.resources?.invalidate(VISUALIZATION_STATE_PATH, state.revision);
}

async function patchTargetOverrideResource(
  context: CommandContext,
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): Promise<boolean> {
  const state = visualizationStateFromContext(context);
  if ((!context.visualizationSync && (!context.api || !context.resources)) || !state) {
    return false;
  }

  await patchVisualizationState(context, {
    overrides: mergeVisualizationStateTargetOverride(
      state.overrides ?? [],
      target,
      patch,
    ),
  });
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

  await patchVisualizationState(context, {
    overrides: (state.overrides ?? []).filter(
      (entry) => !(entry.scope === target.kind && entry.scope_id === target.id),
    ),
  });
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

function asPatchDefaultsInput(value: unknown): PatchDefaultsInput | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.targetKinds)) return null;
  const targetKinds = record.targetKinds.filter(isVisualizationTargetKind);
  const patch = asRecord(record.patch) as VisualizationTargetPatch | null;
  return targetKinds.length > 0 && patch ? { patch, targetKinds } : null;
}

function asPatchTargetInput(value: unknown): PatchTargetInput | null {
  const record = asRecord(value);
  if (!record) return null;
  const target = asVisualizationTargetRef(record.target);
  const patch = asRecord(record.patch) as VisualizationTargetPatch | null;
  return target && patch ? { patch, target } : null;
}

function asVisualizationTargetRef(value: unknown): VisualizationTargetRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : null;
  const kind = isVisualizationTargetKind(record.kind) ? record.kind : null;
  if (!id || !kind) return null;
  return {
    id,
    kind,
    label: typeof record.label === "string" ? record.label : null,
  };
}

function asPhysicsInteractionInput(
  value: unknown,
): { interactionId: PhysicsInteractionId } | null {
  const record = asRecord(value);
  if (!record) return null;
  const interactionId = record.interactionId;
  return typeof interactionId === "string" &&
    (BACKEND_INTERACTION_IDS as readonly string[]).includes(interactionId)
    ? { interactionId: interactionId as PhysicsInteractionId }
    : null;
}

function isVisualizationTargetKind(
  value: unknown,
): value is VisualizationTargetKind {
  return value === "airbox" || value === "object" || value === "part";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

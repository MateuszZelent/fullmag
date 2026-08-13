import type {
  LiveStatusResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { normalizeQuantityIdOrDefault } from "@/kernel/api/quantityIds";
import type {
  CommandContext,
  CommandContribution,
  CommandResult,
} from "@/kernel/commands/commandTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { resolveActiveLaneOperation } from "@/kernel/resources/useActiveLaneCapabilities";
import { beginPlanarMonitorDraft } from "@/kernel/workspace/crossSectionWorkspace";
import {
  BACKEND_INTERACTION_IDS,
  findInteractionSpec,
  interactionAvailabilityForDiscretization,
  normalizeInteractionDiscretization,
  type InteractionDiscretization,
  type PhysicsInteractionId,
} from "@/shared/domain/physics/interactions";
import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resetAirboxVisualizationState,
  visualizationStateOverrideMatchesTarget,
  visualizationStatePatchFromDefaultTargetPatch,
  visualizationTargetUnsupportedPatchFields,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";

export const RIBBON_VISUALIZATION_PATCH_STATE_COMMAND =
  "ribbon.visualization.patch-state";
export const RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND =
  "ribbon.visualization.apply-global-quantity";
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
export const RIBBON_PHYSICS_CREATE_FIELD_DRIVE_COMMAND =
  "ribbon.physics.create-field-drive";
export const RIBBON_PHYSICS_CREATE_SPIN_TRANSPORT_COMMAND =
  "ribbon.physics.create-spin-transport";
export const RIBBON_PHYSICS_CREATE_SPIN_INTERFACE_COMMAND =
  "ribbon.physics.create-spin-interface";
export const RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND =
  "ribbon.cross-section.begin-draft";

interface PatchDefaultsInput {
  patch: VisualizationTargetPatch;
  targetKinds: VisualizationTargetKind[];
}

interface PatchTargetInput {
  patch: VisualizationTargetPatch;
  target: VisualizationTargetRef;
}

export interface ApplyGlobalQuantityInput {
  activeQuantityId: string;
  clearTargetQuantities?: boolean;
  requiresConfirmation?: boolean;
  targetQuantityOverrideCount?: number;
}

export function visualizationStateCommandInput(
  patch: VisualizationStatePatch,
): VisualizationStatePatch {
  return patch;
}

export function globalQuantityCommandInput(
  activeQuantityId: string,
  clearTargetQuantities = false,
  requiresConfirmation = false,
  targetQuantityOverrideCount = 0,
): ApplyGlobalQuantityInput {
  return {
    activeQuantityId: normalizeQuantityIdOrDefault(activeQuantityId),
    clearTargetQuantities,
    requiresConfirmation,
    targetQuantityOverrideCount,
  };
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
    id: RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
    title: "Apply Global Visualization Quantity",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    isEnabled: (context) => Boolean(context.api),
    disabledReason: (context) =>
      context.api ? null : "Control Room API is not available.",
    run: applyGlobalQuantityFromCommand,
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
    isEnabled: (context) => ribbonInteractionDiscretization(context) === "fem",
    disabledReason: airboxCommandDisabledReason,
    run: patchAirboxVisualizationFromCommand,
  },
  {
    id: RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
    title: "Reset Airbox Visualization",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    isEnabled: (context) => ribbonInteractionDiscretization(context) === "fem",
    disabledReason: airboxCommandDisabledReason,
    run: resetAirboxVisualizationFromCommand,
  },
  {
    id: RIBBON_SELECTION_FOCUS_AIRBOX_COMMAND,
    title: "Focus Airbox",
    group: "ribbon-selection",
    category: "View",
    scope: "workspace",
    isEnabled: (context) =>
      Boolean(context.selection) && ribbonInteractionDiscretization(context) === "fem",
    disabledReason: (context) =>
      context.selection
        ? airboxCommandDisabledReason(context)
        : "Selection controller is not available.",
    run: focusAirboxFromCommand,
  },
  {
    id: RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
    title: "Create Planar Monitor",
    group: "ribbon-visualization",
    category: "View",
    scope: "workspace",
    run: beginCrossSectionDraftFromCommand,
  },
  {
    id: RIBBON_PHYSICS_CREATE_FIELD_DRIVE_COMMAND,
    title: "Create Global Field Drive",
    group: "ribbon-physics",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) => Boolean(context.selection),
    disabledReason: (context) => context.selection
      ? null
      : "Selection controller is not available.",
    run: createFieldDriveFromCommand,
  },
  {
    id: RIBBON_PHYSICS_CREATE_SPIN_TRANSPORT_COMMAND,
    title: "Create Spin Transport / SHE",
    group: "ribbon-physics",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) => Boolean(context.selection),
    disabledReason: (context) => context.selection
      ? null
      : "Selection controller is not available.",
    run: createSpinTransportFromCommand,
  },
  {
    id: RIBBON_PHYSICS_CREATE_SPIN_INTERFACE_COMMAND,
    title: "Create Spin Interface",
    group: "ribbon-physics",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) => Boolean(context.selection),
    disabledReason: (context) => context.selection
      ? null
      : "Selection controller is not available.",
    run: createSpinInterfaceFromCommand,
  },
  {
    id: RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
    title: "Select Physics Interaction",
    group: "ribbon-physics",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) =>
      Boolean(context.selection) && physicsInteractionOperation(context).enabled,
    disabledReason: (context) => {
      if (!context.selection) return "Selection controller is not available.";
      const operation = physicsInteractionOperation(context);
      return operation.enabled ? null : operation.reason;
    },
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

  await patchVisualizationState(context, patch, { flush: true });
  return { status: "completed" };
}

async function applyGlobalQuantityFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.visualizationSync && !context.api) {
    return { message: "Control Room API is not available.", status: "failed" };
  }
  const input = asApplyGlobalQuantityInput(context.input);
  if (!input) {
    return {
      message: "Global quantity input is missing.",
      status: "failed",
    };
  }

  const patch: VisualizationStatePatch = {
    active_quantity_id: input.activeQuantityId,
    quantity: { active_quantity_id: input.activeQuantityId },
  };
  const state = visualizationStateFromContext(context);
  if (input.clearTargetQuantities && state) {
    patch.overrides = [];
    for (const entry of state.overrides ?? []) {
      const nextEntry = clearTargetQuantityOverride(entry);
      if (nextEntry) {
        patch.overrides.push(nextEntry);
      }
    }
  }

  await patchVisualizationState(context, patch, { flush: true });
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

  const localPatch = airboxLocalVisualizationPatchFromTargetPatch(input.patch);
  const persistentPatch = persistentVisualizationTargetPatch(input.patch);
  for (const kind of input.targetKinds) {
    if (Object.keys(localPatch).length > 0) {
      context.visualization.patchViewportPreferenceDefaults(kind, localPatch);
    }
    if (Object.keys(persistentPatch).length > 0) {
      context.visualization.patchDefaults(kind, persistentPatch);
    }
  }
  const statePatch = visualizationStatePatchFromDefaultTargetPatch(persistentPatch);
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
    const guard = requireFemAirboxLane(context);
    if (guard) return guard;
    return patchAirboxVisualization(context, input.patch);
  }

  const unsupportedFields = visualizationTargetUnsupportedPatchFields(
    input.target,
    input.patch,
  );
  if (unsupportedFields.length > 0) {
    return {
      message: `Visualization target does not support: ${unsupportedFields.join(", ")}.`,
      status: "failed",
    };
  }

  const localPatch = airboxLocalVisualizationPatchFromTargetPatch(input.patch);
  if (Object.keys(localPatch).length > 0) {
    context.visualization.patchViewportPreferences(input.target, localPatch);
  }
  const persistentPatch = persistentVisualizationTargetPatch(input.patch);
  if (
    Object.keys(persistentPatch).length > 0 &&
    !(await patchTargetOverrideResource(context, input.target, persistentPatch))
  ) {
    context.visualization.patchTarget(input.target, persistentPatch);
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
  const guard = requireFemAirboxLane(context);
  if (guard) return guard;
  const patch = asRecord(context.input) as VisualizationTargetPatch | null;
  if (!patch) {
    return { message: "Airbox visualization patch is missing.", status: "failed" };
  }
  return patchAirboxVisualization(context, patch);
}

async function resetAirboxVisualizationFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  const guard = requireFemAirboxLane(context);
  if (guard) return guard;
  if (context.visualizationSync || context.api) {
    await patchVisualizationState(
      context,
      resetAirboxVisualizationState(
        visualizationStateFromContext(context) ?? { overrides: [] },
      ),
    );
  }
  context.visualization?.clearTarget(AIRBOX_VISUALIZATION_TARGET);
  return { status: "completed" };
}

function focusAirboxFromCommand(context: CommandContext): CommandResult {
  const guard = requireFemAirboxLane(context);
  if (guard) return guard;
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

async function beginCrossSectionDraftFromCommand(
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.api) {
    return { message: "Domain bounds are unavailable for planar monitor placement.", status: "failed" };
  }
  const domain = await context.api.data.domain.meta();
  const draft = beginPlanarMonitorDraft(
    visualizationStateFromContext(context),
    {
      min: domain.bounds.min as [number, number, number],
      max: domain.bounds.max as [number, number, number],
    },
    { source: "ribbon" },
  );
  const nodeId = "model:definitions:planar-monitors:draft";
  selectPlanarMonitorDraft(context, draft.monitor.name, nodeId);
  context.layout?.setPanelVisible("left", true);
  context.layout?.setPanelVisible("right", true);
  context.layout?.setFocusedSlot("viewport-main");

  return { status: "completed" };
}

function selectPlanarMonitorDraft(
  context: CommandContext,
  label: string,
  nodeId: string,
): void {
  context.selection?.set(
    {
      kind: "model.planar.monitor.draft",
      label,
      nodeId,
      objectId: null,
      ref: {
        draftId: "draft",
        kind: "model.planar.monitor.draft",
        nodeId,
        type: "planar-monitor-draft",
        visualizationTargetId: "planar-monitor:draft",
      },
    },
    context.source,
  );
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

  const availability = interactionAvailabilityForDiscretization(
    input.interactionId,
    ribbonInteractionDiscretization(context),
  );
  if (availability.status !== "supported") {
    return {
      message:
        availability.reason ??
        `Interaction '${input.interactionId}' is unavailable for the current lane.`,
      status: "failed",
    };
  }

  const current = context.selection?.get() as Selection | undefined;
  const selectedObjectId = current?.objectId ?? null;
  if (spec.scope === "object_or_region" && !selectedObjectId) {
    return {
      message: `Select an object or region before adding '${spec.label}'.`,
      status: "failed",
    };
  }
  const objectId = spec.scope === "global" ? null : selectedObjectId;
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

function createFieldDriveFromCommand(context: CommandContext): CommandResult {
  if (!context.selection) {
    return {
      message: "Selection controller is not available.",
      status: "failed",
    };
  }
  const nodeId = "model:physics:field-drive:draft";
  context.selection.set(
    {
      kind: "physics.field-drive",
      label: "New field drive",
      nodeId,
      objectId: null,
      ref: {
        draft: true,
        kind: "physics.field-drive",
        nodeId,
        type: "physics-field-drive",
      },
    },
    context.source,
  );
  return { status: "completed" };
}

function createSpinTransportFromCommand(context: CommandContext): CommandResult {
  if (!context.selection) {
    return {
      message: "Selection controller is not available.",
      status: "failed",
    };
  }
  const current = context.selection.get() as Selection | null;
  const objectId = current?.objectId ?? null;
  const regionId = current?.ref && "regionId" in current.ref &&
    typeof current.ref.regionId === "string"
    ? current.ref.regionId
    : null;
  const nodeId = "model:physics:spin-transport:draft";
  context.selection.set(
    {
      kind: "physics.spin-transport",
      label: "New spin transport",
      nodeId,
      objectId,
      ref: {
        draft: true,
        kind: "physics.spin-transport",
        nodeId,
        ...(objectId && regionId ? { regionId } : {}),
        type: "spin-transport",
      },
    },
    context.source,
  );
  return { status: "completed" };
}

function createSpinInterfaceFromCommand(context: CommandContext): CommandResult {
  if (!context.selection) {
    return {
      message: "Selection controller is not available.",
      status: "failed",
    };
  }
  const nodeId = "model:physics:spin-interface:draft";
  context.selection.set(
    {
      kind: "physics.spin-interface",
      label: "New spin interface",
      nodeId,
      objectId: null,
      ref: {
        draft: true,
        kind: "physics.spin-interface",
        nodeId,
        type: "spin-interface",
      },
    },
    context.source,
  );
  return { status: "completed" };
}

function physicsInteractionOperation(context: CommandContext) {
  const input = asPhysicsInteractionInput(context.input);
  if (!input) {
    return resolveActiveLaneOperation(null, "interaction.exchange");
  }
  const rawStatus = context.resourceData?.[SESSION_STATUS_RESOURCE_KEY];
  const record = asRecord(rawStatus);
  const status = (record?.data ?? rawStatus) as
    | LiveStatusResource
    | null
    | undefined;
  return resolveActiveLaneOperation(
    status?.capabilities?.active_lane ?? null,
    `interaction.${input.interactionId}`,
  );
}

async function patchAirboxVisualization(
  context: CommandContext,
  patch: VisualizationTargetPatch,
): Promise<CommandResult> {
  const guard = requireFemAirboxLane(context);
  if (guard) return guard;
  const localPatch = airboxLocalVisualizationPatchFromTargetPatch(patch);
  if (Object.keys(localPatch).length > 0) {
    context.visualization?.patchViewportPreferences(
      AIRBOX_VISUALIZATION_TARGET,
      localPatch,
    );
  }

  const state = visualizationStateFromContext(context);
  const statePatch = airboxVisualizationStatePatchFromTargetPatch(
    patch,
    state ? state.overrides ?? [] : undefined,
  );
  if (!hasVisualizationStatePatch(statePatch)) {
    return { status: "completed" };
  }

  if (!context.visualizationSync && !context.api) {
    context.visualization?.patchTarget(
      AIRBOX_VISUALIZATION_TARGET,
      persistentVisualizationTargetPatch(patch),
    );
    return { status: "completed" };
  }

  const revision = state?.revision;
  if (typeof revision === "number") {
    context.visualization?.patchTargetPending(
      AIRBOX_VISUALIZATION_TARGET,
      persistentVisualizationTargetPatch(patch),
      revision,
    );
  }
  await patchVisualizationState(context, statePatch);
  return { status: "completed" };
}

async function patchVisualizationState(
  context: CommandContext,
  patch: VisualizationStatePatch,
  options: { flush?: boolean } = {},
): Promise<void> {
  if (context.visualizationSync) {
    context.visualizationSync.queuePatch(patch);
    if (options.flush) {
      await context.visualizationSync.flushNow();
    }
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
  // The structured-grid FDM target is viewport-local.  The v2 visualization
  // registry has no `fdm-domain` scope, so callers must fall back to the
  // ObjectVisualizationController instead of queueing an unchanged backend
  // override and reporting success.
  if (target.kind === "fdm-domain") return false;
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
  // See patchTargetOverrideResource: FDM display state is not a backend
  // visualization-state scope.
  if (target.kind === "fdm-domain") return false;
  const state = visualizationStateFromContext(context);
  if ((!context.visualizationSync && (!context.api || !context.resources)) || !state) {
    return false;
  }

  await patchVisualizationState(context, {
    overrides: (state.overrides ?? []).filter(
      (entry) => !visualizationStateOverrideMatchesTarget(entry, target),
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

function asApplyGlobalQuantityInput(
  value: unknown,
): ApplyGlobalQuantityInput | null {
  const record = asRecord(value);
  const rawActiveQuantityId =
    typeof record?.activeQuantityId === "string"
      ? record.activeQuantityId.trim()
      : "";
  if (!record || !rawActiveQuantityId) return null;
  const activeQuantityId = normalizeQuantityIdOrDefault(rawActiveQuantityId);
  return {
    activeQuantityId,
    clearTargetQuantities: Boolean(record.clearTargetQuantities),
    requiresConfirmation: Boolean(record.requiresConfirmation),
    targetQuantityOverrideCount:
      typeof record.targetQuantityOverrideCount === "number"
        ? record.targetQuantityOverrideCount
        : 0,
  };
}

function clearTargetQuantityOverride(
  override: VisualizationStateResource["overrides"][number],
): VisualizationStateResource["overrides"][number] | null {
  if (!override.quantity) return override;
  const next: VisualizationStateResource["overrides"][number] = {
    scope: override.scope,
    scope_id: override.scope_id,
    ...(override.visible === undefined ? {} : { visible: override.visible }),
    ...(override.display ? { display: override.display } : {}),
    ...(override.style ? { style: override.style } : {}),
  };
  if (next.visible !== undefined || next.display || next.style) {
    return next;
  }
  return null;
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

export function isVisualizationTargetKind(
  value: unknown,
): value is VisualizationTargetKind {
  return (
    value === "airbox" ||
    value === "fdm-domain" ||
    value === "object" ||
    value === "part" ||
    value === "region"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ribbonInteractionDiscretization(
  context: CommandContext,
): InteractionDiscretization {
  const rawResource = context.resourceData?.[SESSION_STATUS_RESOURCE_KEY];
  // Keep direct command consumers that predate session-status injection
  // compatible; live RibbonModule contexts publish the key explicitly and
  // therefore still fail closed while the lane is unresolved.
  if (rawResource === undefined) return "fem";
  const resource = asRecord(rawResource);
  const status = asRecord(resource?.data ?? resource);
  return normalizeInteractionDiscretization(
    asRecord(status?.domain)?.discretization,
  );
}

function airboxCommandDisabledReason(context: CommandContext): string | null {
  const lane = ribbonInteractionDiscretization(context);
  if (lane === "fdm") {
    return "FEM airbox visualization is not applicable to FDM; use the structured universe/grid extent.";
  }
  if (lane === "unknown") {
    return "Discretization lane is unresolved; FEM airbox visualization is disabled.";
  }
  return null;
}

function requireFemAirboxLane(context: CommandContext): CommandResult | null {
  const reason = airboxCommandDisabledReason(context);
  return reason ? { message: reason, status: "failed" } : null;
}

import {
  MODEL_COUPLINGS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type { RegionListResource } from "../api/apiTypes";
import type { CommandContext, CommandContribution } from "../commands/commandTypes";

function selectedRegion(
  context: Pick<CommandContext, "selection">,
): { objectId: string; regionId: string } | null {
  const selection = context.selection?.get();
  if (selection?.ref?.type !== "scene-object") return null;
  const regionId = selection.ref.regionId;
  if (!selection.ref.objectId || !regionId) return null;
  return { objectId: selection.ref.objectId, regionId };
}

function selectedCouplingId(
  context: Pick<CommandContext, "selection">,
): string | null {
  const selection = context.selection?.get();
  return selection?.ref?.type === "physics-coupling"
    ? selection.ref.couplingId
    : null;
}

function regionDisabledReason(context: CommandContext): string | null {
  if (!selectedRegion(context)) return "Select an authored object region.";
  return context.api ? null : "Control Room API is not available.";
}

function regionOrderDisabledReason(context: CommandContext): string | null {
  const baseReason = regionDisabledReason(context);
  if (baseReason) return baseReason;
  return ownerRegionOrder(context) ? null : "Region order resource is not loaded.";
}

function couplingDisabledReason(context: CommandContext): string | null {
  if (!selectedCouplingId(context)) return "Select an authored coupling.";
  return context.api ? null : "Control Room API is not available.";
}

function invalidateAuthoringModel(context: CommandContext): void {
  const revision = `${Date.now()}`;
  context.resources?.invalidate(MODEL_SCENE_PATH, revision);
  context.resources?.invalidate(MODEL_READINESS_PATH, revision);
  context.resources?.invalidate(MODEL_REGIONS_PATH, revision);
  context.resources?.invalidate(MODEL_COUPLINGS_PATH, revision);
}

function focusSelection(context: CommandContext): void {
  context.layout?.setActiveTab("view");
  context.layout?.setFocusedSlot("viewport-main");
}

function ownerRegionOrder(context: CommandContext): string[] | null {
  const target = selectedRegion(context);
  const regions = context.resourceData?.[MODEL_REGIONS_PATH] as
    | RegionListResource
    | undefined;
  if (!target || !Array.isArray(regions?.regions)) return null;
  const ordered: string[] = [];
  for (const region of regions.regions) {
    if (
      region.source === "authored_object_region" &&
      regionReferencesObject(region, target.objectId)
    ) {
      ordered.push(region.region_id);
    }
  }
  return ordered.includes(target.regionId) ? ordered : null;
}

function regionReferencesObject(
  region: RegionListResource["regions"][number],
  objectId: string,
): boolean {
  if ((region.owner_object_id ?? null) === objectId) return true;
  for (const sourceObjectId of region.source_object_ids) {
    if (sourceObjectId === objectId) return true;
  }
  return false;
}

function movedRegionOrder(
  context: CommandContext,
  direction: "up" | "down",
): string[] | null {
  const target = selectedRegion(context);
  const order = ownerRegionOrder(context);
  if (!target || !order) return null;
  const index = order.indexOf(target.regionId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapIndex < 0 || swapIndex >= order.length) return null;
  const next = [...order];
  [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  return next;
}

function regionPriorityCommand(
  id: "regions.priority-up" | "regions.priority-down",
  title: string,
  direction: "up" | "down",
): CommandContribution {
  return {
    id,
    title,
    group: "regions",
    category: "Regions",
    scope: "selection",
    isEnabled: (context) => regionOrderDisabledReason(context) === null,
    disabledReason: regionOrderDisabledReason,
    run: async (context) => {
      const target = selectedRegion(context);
      const nextOrder = movedRegionOrder(context, direction);
      if (!target || !nextOrder || !context.api) {
        return {
          message: regionOrderDisabledReason(context) ?? "Region cannot be reordered.",
          status: "failed",
        };
      }
      await context.api.model.reorderObjectRegions(target.objectId, nextOrder);
      invalidateAuthoringModel(context);
      return { status: "completed" };
    },
  };
}

export const REGION_COMMANDS: CommandContribution[] = [
  {
    id: "regions.focus",
    title: "Focus Region",
    group: "regions",
    category: "Regions",
    scope: "selection",
    isEnabled: (context) => Boolean(selectedRegion(context)),
    disabledReason: (context) =>
      selectedRegion(context) ? null : "Select an authored object region.",
    run: (context) => {
      focusSelection(context);
      return { status: "completed" };
    },
  },
  {
    id: "regions.duplicate",
    title: "Duplicate Region",
    group: "regions",
    category: "Regions",
    scope: "selection",
    isEnabled: (context) => regionDisabledReason(context) === null,
    disabledReason: regionDisabledReason,
    run: async (context) => {
      const target = selectedRegion(context);
      if (!target || !context.api) {
        return { message: regionDisabledReason(context) ?? undefined, status: "failed" };
      }
      await context.api.model.duplicateObjectRegion(target.objectId, target.regionId, {});
      invalidateAuthoringModel(context);
      return { status: "completed" };
    },
  },
  {
    id: "regions.delete",
    title: "Delete Region",
    group: "regions",
    category: "Regions",
    scope: "selection",
    isEnabled: (context) => regionDisabledReason(context) === null,
    disabledReason: regionDisabledReason,
    run: async (context) => {
      const target = selectedRegion(context);
      if (!target || !context.api) {
        return { message: regionDisabledReason(context) ?? undefined, status: "failed" };
      }
      await context.api.model.deleteObjectRegion(target.objectId, target.regionId);
      invalidateAuthoringModel(context);
      context.selection?.clear("inspector");
      return { status: "completed" };
    },
  },
  regionPriorityCommand("regions.priority-up", "Move Region Priority Up", "up"),
  regionPriorityCommand(
    "regions.priority-down",
    "Move Region Priority Down",
    "down",
  ),
  {
    id: "couplings.disable",
    title: "Disable Coupling",
    group: "couplings",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) => couplingDisabledReason(context) === null,
    disabledReason: couplingDisabledReason,
    run: async (context) => {
      const couplingId = selectedCouplingId(context);
      if (!couplingId || !context.api) {
        return { message: couplingDisabledReason(context) ?? undefined, status: "failed" };
      }
      await context.api.model.patchCoupling(couplingId, { enabled: false });
      invalidateAuthoringModel(context);
      return { status: "completed" };
    },
  },
  {
    id: "couplings.delete",
    title: "Delete Coupling",
    group: "couplings",
    category: "Physics",
    scope: "selection",
    isEnabled: (context) => couplingDisabledReason(context) === null,
    disabledReason: couplingDisabledReason,
    run: async (context) => {
      const couplingId = selectedCouplingId(context);
      if (!couplingId || !context.api) {
        return { message: couplingDisabledReason(context) ?? undefined, status: "failed" };
      }
      await context.api.model.deleteCoupling(couplingId);
      invalidateAuthoringModel(context);
      context.selection?.clear("inspector");
      return { status: "completed" };
    },
  },
  {
    id: "mesh.open-region-report",
    title: "Open Region Mesh Report",
    group: "mesh",
    category: "Mesh",
    scope: "selection",
    isEnabled: (context) => Boolean(selectedRegion(context)),
    disabledReason: (context) =>
      selectedRegion(context) ? null : "Select an authored object region.",
    run: (context) => {
      const target = selectedRegion(context);
      if (!target) {
        return { message: "Select an authored object region.", status: "failed" };
      }
      context.layout?.setActiveTab("mesh");
      context.selection?.set(
        {
          kind: "mesh.regions",
          label: "Regions And Mesh Parts",
          nodeId: "model:mesh:regions",
          objectId: target.objectId,
          ref: null,
        },
        "explorer",
      );
      return { status: "completed" };
    },
  },
];

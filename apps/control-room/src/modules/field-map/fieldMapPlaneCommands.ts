import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";
import { obsoleteSessionResult } from "@/kernel/commands/commandSessionScope";
import { planarSectionPlanePatch, type PlanarSectionPlane } from "@/kernel/visualization/planarSectionModel";

import { fieldMapActive, planarFromContext } from "./fieldMapViewCommands";

export const PLANAR_SECTION_PLANES: readonly { id: PlanarSectionPlane; label: string; commandId: string }[] = [
  { id: "xy", label: "XY", commandId: "field-map.plane.xy" },
  { id: "xz", label: "XZ", commandId: "field-map.plane.xz" },
  { id: "yz", label: "YZ", commandId: "field-map.plane.yz" },
];

export const MONITOR_PLANE_REASON = "The monitor defines this section plane. Choose Source: Default to change it.";

function planeDisabledReason(context: CommandContext): string | null {
  if (!fieldMapActive(context)) return "Open the 2D view first.";
  const planar = planarFromContext(context);
  if (!planar) return "Planar visualization state is unavailable.";
  return planar.source.kind === "monitor" ? MONITOR_PLANE_REASON : null;
}

function runPlaneCommand(plane: PlanarSectionPlane, context: CommandContext): CommandResult {
  const obsolete = obsoleteSessionResult(context);
  if (obsolete) return obsolete;
  const planar = planarFromContext(context);
  if (!context.visualizationSync || !planar) {
    return { message: "Planar visualization state is unavailable.", status: "failed" };
  }
  if (planar.source.kind === "monitor") return { message: MONITOR_PLANE_REASON, status: "failed" };
  if (planar.default_slice.plane === plane) return { status: "completed" };
  context.visualizationSync.queuePatch({ planar: planarSectionPlanePatch(planar.default_slice, plane) });
  // The plane is part of the sample identity: send it now.
  void context.visualizationSync.flushNow?.();
  return { status: "completed" };
}

/**
 * Section plane of the whole 2D view (spec 15 §4.1). One command per plane,
 * shared by the 2D toolbar and the Inspector, so both always agree.
 */
export const fieldMapPlaneCommands: CommandContribution[] = PLANAR_SECTION_PLANES.map(({ id, label, commandId }) => ({
  category: "Viewport",
  group: "field-map",
  id: commandId,
  isEnabled: (context) => planeDisabledReason(context) === null,
  isActive: (context) => planarFromContext(context)?.default_slice.plane === id,
  disabledReason: planeDisabledReason,
  run: (context) => runPlaneCommand(id, context),
  scope: "viewport",
  title: `2D Section Plane ${label}`,
}));

import type { CommandContext, CommandContribution } from "@/kernel/commands/commandTypes";
import {
  MODEL_PLANAR_MONITORS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";
import { beginPlanarMonitorDraft } from "@/kernel/workspace/crossSectionWorkspace";

import { downloadPlanarPng, planarExportFilename } from "./fieldMapExport";

const commandTitles = {
  "field-map.export-data": "Export 2D Data",
  "field-map.export-png": "Export 2D PNG",
  "field-map.fit": "Fit 2D View",
  "field-map.open": "Open 2D View",
  "field-map.reset-view": "Reset 2D View",
  "field-map.select-monitor": "Select Planar Monitor",
  "field-map.toggle-contours": "Toggle 2D Contours",
  "field-map.toggle-mesh": "Toggle 2D Mesh",
  "field-map.toggle-vectors": "Toggle 2D Vectors",
  "planar-monitor.delete": "Delete Planar Monitor",
  "planar-monitor.duplicate": "Duplicate Planar Monitor",
  "planar-monitor.rename": "Rename Planar Monitor",
  "planar-monitor.show-frame-3d": "Show Monitor Frame in 3D",
} as const;

function queuePlanarMonitorSelection(
  context: CommandContext,
  monitorId: string | null,
  state: VisualizationStateResource | null = visualizationStateFromContext(context),
): boolean {
  if (!context.visualizationSync || !state?.planar) return false;
  context.visualizationSync.queuePatch({
    planar: { active_monitor_id: monitorId },
  });
  return true;
}

function visualizationStateFromContext(
  context: CommandContext,
): VisualizationStateResource | null {
  const state = context.resourceData?.[VISUALIZATION_STATE_PATH];
  return state && typeof state === "object"
    ? (state as VisualizationStateResource)
    : null;
}

export const fieldMapCommands: CommandContribution[] = Object.entries(
  commandTitles,
).map(([id, title]) => ({
  category: "Viewport",
  group: "field-map",
  id,
  run: async (context) => {
    const input =
      context.input && typeof context.input === "object"
        ? (context.input as { monitorId?: unknown; newName?: unknown })
        : null;
    if (id === "field-map.open" || id === "field-map.select-monitor") {
      if (id === "field-map.select-monitor") {
        if (typeof input?.monitorId !== "string") {
          return {
            message: "A planar monitor id is required.",
            status: "failed",
          };
        }
        if (!queuePlanarMonitorSelection(context, input.monitorId)) {
          return {
            message: "Planar visualization state is unavailable.",
            status: "failed",
          };
        }
      }
      context.layout?.setActiveViewportMainModule("field-map");
      context.layout?.setFocusedSlot("viewport-main");
      if (id === "field-map.open" && context.api) {
        const collection = await context.api.model.planarMonitors.list();
        if (collection.monitors.length === 0) {
          const draft = beginPlanarMonitorDraft();
          const nodeId = "model:definitions:planar-monitors:draft";
          context.selection?.set(
            {
              kind: "model.planar.monitor.draft",
              label: draft.monitor.name,
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
          context.layout?.setPanelVisible("right", true);
          return {
            message: "Apply the Midplane draft to render the 2D field.",
            status: "completed",
          };
        }
      }
    }
    if (id === "planar-monitor.show-frame-3d") {
      if (!context.api || typeof input?.monitorId !== "string") {
        return {
          message: "Planar field API or monitor id is missing.",
          status: "failed",
        };
      }
      const visualization = await context.api.visualization.state();
      const planar = visualization.planar;
      if (!planar) {
        return {
          message: "The server did not publish a planar visualization profile.",
          status: "failed",
        };
      }
      const meta = await context.api.data.fields.planar.meta(
        planar.quantity_id,
        input.monitorId,
        {
          component: planar.component,
          resolution_x: planar.resolution.width,
          resolution_y: planar.resolution.height,
          scope_id:
            planar.view_scope.kind === "mesh_part"
              ? planar.view_scope.scope_id
              : undefined,
          scope_kind: planar.view_scope.kind,
        },
      );
      planarMonitorFramePreviewStore.set({
        boundsUvM: meta.frame.bounds_uv_m as [number, number, number, number],
        monitorId: input.monitorId,
        normal: meta.frame.normal as [number, number, number],
        operator: null,
        originM: meta.frame.origin_m as [number, number, number],
        uAxis: meta.frame.u_axis as [number, number, number],
        vAxis: meta.frame.v_axis as [number, number, number],
      });
      if (!queuePlanarMonitorSelection(context, input.monitorId, visualization)) {
        return {
          message: "Planar visualization state is unavailable.",
          status: "failed",
        };
      }
      context.layout?.setActiveViewportMainModule("viewport-3d");
      context.layout?.setFocusedSlot("viewport-main");
    }
    if (id === "field-map.export-png") {
      if (!context.api) {
        return { message: "Planar field API is unavailable.", status: "failed" };
      }
      const visualization = await context.api.visualization.state();
      const planar = visualization.planar;
      if (!planar) {
        return {
          message: "The server did not publish a planar visualization profile.",
          status: "failed",
        };
      }
      const monitorId =
        (typeof input?.monitorId === "string" ? input.monitorId : null) ??
        planar.active_monitor_id;
      if (!monitorId) {
        return { message: "Select a planar monitor first.", status: "failed" };
      }
      const query = {
        component: planar.component,
        include_mesh: planar.layers.mesh,
        quality: "export",
        resolution_x: planar.resolution.width,
        resolution_y: planar.resolution.height,
        scope_id:
          planar.view_scope.kind === "mesh_part"
            ? planar.view_scope.scope_id
            : undefined,
        scope_kind: planar.view_scope.kind,
        vector_budget: planar.resolution.vector_budget,
      };
      const [meta, monitor, png] = await Promise.all([
        context.api.data.fields.planar.meta(
          planar.quantity_id,
          monitorId,
          query,
        ),
        context.api.model.planarMonitors.get(monitorId),
        context.api.data.fields.planar.renderPng(
          planar.quantity_id,
          monitorId,
          query,
        ),
      ]);
      if (png.status !== "ready") {
        return {
          message: "The planar PNG is not available for this revision.",
          status: "failed",
        };
      }
      downloadPlanarPng(
        png.data,
        planarExportFilename({
          fieldRevision: meta.field_revision,
          monitorName: monitor.monitor.name,
          quantityId: planar.quantity_id,
          unit: planar.display_unit ?? meta.canonical_unit,
        }),
      );
    }
    if (
      id === "planar-monitor.delete" ||
      id === "planar-monitor.duplicate" ||
      id === "planar-monitor.rename"
    ) {
      if (!context.api || typeof input?.monitorId !== "string") {
        return {
          message: "Planar monitor API or monitor id is missing.",
          status: "failed",
        };
      }
      const collection = await context.api.model.planarMonitors.list();
      let revision = collection.scene_revision;
      if (id === "planar-monitor.delete") {
        const visualization = await context.api.visualization.state();
        const response = await context.api.model.planarMonitors.remove(
          input.monitorId,
          { expected_scene_revision: revision },
        );
        revision = response.scene_revision;
        if (visualization.planar?.active_monitor_id === input.monitorId) {
          if (!queuePlanarMonitorSelection(context, null, visualization)) {
            return {
              message: "Planar visualization state is unavailable.",
              status: "failed",
            };
          }
        }
      } else if (id === "planar-monitor.duplicate") {
        const visualization = await context.api.visualization.state();
        const response = await context.api.model.planarMonitors.duplicate(
          input.monitorId,
          { expected_scene_revision: revision },
        );
        revision = response.scene_revision;
        if (!queuePlanarMonitorSelection(context, response.monitor.id, visualization)) {
          return {
            message: "Planar visualization state is unavailable.",
            status: "failed",
          };
        }
      } else {
        if (typeof input.newName !== "string" || !input.newName.trim()) {
          context.layout?.setPanelVisible("right", true);
          return {
            message: "Edit the monitor name in the Inspector.",
            status: "completed",
          };
        }
        const current = await context.api.model.planarMonitors.get(
          input.monitorId,
        );
        const response = await context.api.model.planarMonitors.patch(
          input.monitorId,
          {
            expected_scene_revision: revision,
            monitor: { ...current.monitor, name: input.newName.trim() },
          },
        );
        revision = response.scene_revision;
      }
      context.resources?.invalidate(MODEL_PLANAR_MONITORS_PATH, revision);
    }
    return { status: "completed" };
  },
  scope: "viewport",
  shortcut: id === "field-map.open" ? "2" : undefined,
  title,
}));

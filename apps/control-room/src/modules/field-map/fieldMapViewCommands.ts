import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";
import { obsoleteSessionResult } from "@/kernel/commands/commandSessionScope";
import { normalizeTensorProjection, tensorProjectionOutputKind } from "@/kernel/api/tensorFieldProjection";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import { decodeFieldVector } from "@/kernel/api/codecs/fieldVectorCodec";
import type {
  PlanarFieldSource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { stepSectionFraction } from "@/kernel/visualization/planarSectionModel";

import { downloadPlanarBlob, planarDataCsv, planarExportFilename } from "./fieldMapExport";
import { fieldMapSurfaceStore as fieldMapStore } from "@/kernel/visualization/fieldMapSurfaceStore";
import { planarComponentPresetPatch, type PlanarComponentPreset } from "./model/planarComponentPresets";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarLayerKey = "contours" | "mesh" | "vectors";

/**
 * mumax3-style keyboard and toolbar commands of the mounted 2D surface. They
 * patch the same server-owned `visualization/state.planar` as the Inspector
 * and are enabled only while the 2D surface is the active center module, so
 * single-key shortcuts never fire over the 3D viewport.
 */
const viewCommands = {
  "field-map.layer-next": { title: "Next 2D Layer", shortcut: "]" },
  "field-map.layer-previous": { title: "Previous 2D Layer", shortcut: "[" },
  "field-map.layer-next-10": { title: "Forward 10 2D Layers", shortcut: "Shift+}" },
  "field-map.layer-previous-10": { title: "Back 10 2D Layers", shortcut: "Shift+{" },
  "field-map.component-direction": { title: "2D Direction Colours", shortcut: "V" },
  "field-map.component-x": { title: "2D Component X", shortcut: "X" },
  "field-map.component-y": { title: "2D Component Y", shortcut: "Y" },
  "field-map.component-z": { title: "2D Component Z", shortcut: "Z" },
  "field-map.component-magnitude": { title: "2D Magnitude", shortcut: "M" },
  "field-map.toggle-vectors": { title: "Toggle 2D Vectors", shortcut: "A" },
  "field-map.toggle-mesh": { title: "Toggle 2D Mesh", shortcut: "G" },
  "field-map.toggle-contours": { title: "Toggle 2D Contours", shortcut: undefined },
  "field-map.fit": { title: "Fit 2D View", shortcut: undefined },
  "field-map.reset-view": { title: "Reset 2D View", shortcut: undefined },
  "field-map.export-data": { title: "Export 2D Data", shortcut: undefined },
} as const;

type ViewCommandId = keyof typeof viewCommands;

const LAYER_STEPS: Partial<Record<ViewCommandId, number>> = {
  "field-map.layer-next": 1,
  "field-map.layer-next-10": 10,
  "field-map.layer-previous": -1,
  "field-map.layer-previous-10": -10,
};

const COMPONENT_PRESETS: Partial<Record<ViewCommandId, PlanarComponentPreset>> = {
  "field-map.component-direction": "direction",
  "field-map.component-magnitude": "magnitude",
  "field-map.component-x": "x",
  "field-map.component-y": "y",
  "field-map.component-z": "z",
};

const LAYER_TOGGLES: Partial<Record<ViewCommandId, PlanarLayerKey>> = {
  "field-map.toggle-contours": "contours",
  "field-map.toggle-mesh": "mesh",
  "field-map.toggle-vectors": "vectors",
};

function planarFromContext(context: CommandContext): PlanarState | null {
  // The mounted surface publishes its presented profile (including queued
  // patches); shortcut contexts do not carry the visualization resource.
  const presented = fieldMapStore.get().planar;
  if (presented) return presented;
  const state = context.resourceData?.[VISUALIZATION_STATE_PATH];
  return state && typeof state === "object"
    ? (state as VisualizationStateResource).planar ?? null
    : null;
}

function fieldMapActive(context: CommandContext): boolean {
  return context.layout?.get().activeViewportMainModuleId === "field-map";
}

function unavailable(message: string): CommandResult {
  return { message, status: "failed" };
}

async function exportPlanarData(context: CommandContext): Promise<CommandResult> {
  if (!context.api) return unavailable("Planar field API is unavailable.");
  const options = context.sessionScopeKey ? { sessionScopeKey: context.sessionScopeKey } : undefined;
  const visualization = await context.api.visualization.state(options);
  const obsolete = obsoleteSessionResult(context);
  if (obsolete) return obsolete;
  const planar = visualization.planar;
  if (!planar) return unavailable("The server did not publish a planar visualization profile.");
  const input = context.input && typeof context.input === "object"
    ? context.input as { monitorId?: unknown }
    : null;
  const source: PlanarFieldSource = typeof input?.monitorId === "string"
    ? { kind: "monitor", monitorId: input.monitorId }
    : planar.source.kind === "monitor"
      ? { kind: "monitor", monitorId: planar.source.monitor_id }
      : { kind: "default" };
  const query = {
    component: planar.component,
    quality: "export",
    resolution_x: planar.resolution.width,
    resolution_y: planar.resolution.height,
    scope_id:
      planar.view_scope.kind === "mesh_part" || planar.view_scope.kind === "layer"
        ? planar.view_scope.scope_id
        : undefined,
    scope_kind: planar.view_scope.kind,
  };
  const [meta, scalar, mask] = await Promise.all([
    context.api.data.fields.planar.meta(planar.quantity_id, source, query, options),
    context.api.data.fields.planar.scalar(planar.quantity_id, source, query, options),
    context.api.data.fields.planar.emptyMask(planar.quantity_id, source, query, options),
  ]);
  const obsoleteAfter = obsoleteSessionResult(context);
  if (obsoleteAfter) return obsoleteAfter;
  if (scalar.status !== "ready") {
    return unavailable("The planar field is not available for this revision.");
  }
  const csv = planarDataCsv({
    bounds: meta.frame.bounds_uv_m as [number, number, number, number],
    component: planar.component,
    fieldRevision: meta.field_revision,
    mask: mask.status === "ready" ? new Uint8Array(mask.data) : null,
    origin: meta.frame.origin_m as [number, number, number],
    quantityId: planar.quantity_id,
    resolution: meta.resolution as [number, number],
    sampleToken: meta.sample_token,
    uAxis: meta.frame.u_axis as [number, number, number],
    unit: meta.canonical_unit,
    vAxis: meta.frame.v_axis as [number, number, number],
    values: decodeFieldVector(scalar.data).values,
  });
  downloadPlanarBlob(
    new Blob([csv], { type: "text/csv" }),
    planarExportFilename({
      extension: "csv",
      fieldRevision: meta.field_revision,
      quantityId: planar.quantity_id,
      sourceLabel: source.kind === "monitor" ? source.monitorId : `default-${planar.default_slice.plane}`,
      unit: meta.canonical_unit,
    }),
  );
  return { status: "completed" };
}

function runViewCommand(id: ViewCommandId, context: CommandContext): Promise<CommandResult> | CommandResult {
  const obsolete = obsoleteSessionResult(context);
  if (obsolete) return obsolete;
  if (id === "field-map.export-data") return exportPlanarData(context);
  const planar = planarFromContext(context);
  if (!context.visualizationSync || !planar) {
    return unavailable("Planar visualization state is unavailable.");
  }
  const step = LAYER_STEPS[id];
  if (step !== undefined) {
    if (planar.source.kind !== "default") {
      return unavailable("Layer stepping applies to the session Default source; edit the monitor frame instead.");
    }
    const fraction = stepSectionFraction(
      planar.default_slice.position_fraction,
      fieldMapStore.get().sectionGeometry,
      step,
    );
    context.visualizationSync.queuePatch({
      planar: { default_slice: { ...planar.default_slice, position_fraction: fraction } },
    });
    return { status: "completed" };
  }
  const preset = COMPONENT_PRESETS[id];
  if (preset) {
    if (normalizeTensorProjection(planar.component) !== null) {
      return unavailable("Choose a catalogued tensor projection in the 2D controls; vector presets do not apply to tensors.");
    }
    context.visualizationSync.queuePatch({ planar: planarComponentPresetPatch(preset, planar.range) });
    return { status: "completed" };
  }
  const layer = LAYER_TOGGLES[id];
  if (layer) {
    if (layer === "vectors" && tensorProjectionOutputKind(planar.component) === "scalar" && !planar.layers.vectors) {
      return unavailable("The selected tensor projection is scalar and has no vector arrows.");
    }
    context.visualizationSync.queuePatch({
      planar: { layers: { ...planar.layers, [layer]: !planar.layers[layer] } },
    });
    return { status: "completed" };
  }
  // fit and reset-view both return the camera to the full sample extent.
  context.visualizationSync.queuePatch({
    planar: { interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 } },
  });
  return { status: "completed" };
}

export const fieldMapViewCommands: CommandContribution[] = (
  Object.entries(viewCommands) as [ViewCommandId, (typeof viewCommands)[ViewCommandId]][]
).map(([id, { title, shortcut }]) => ({
  category: "Viewport",
  group: "field-map",
  id,
  // Export also serves Explorer monitor rows, so it does not need the mounted surface.
  isEnabled: id === "field-map.export-data" ? undefined : (context) => fieldMapActive(context),
  disabledReason: id === "field-map.export-data"
    ? undefined
    : (context) => fieldMapActive(context) ? null : "Open the 2D view first.",
  run: (context) => runViewCommand(id, context),
  scope: "viewport",
  shortcut,
  title,
}));

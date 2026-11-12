import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";
import { obsoleteSessionResult } from "@/kernel/commands/commandSessionScope";
import { tensorProjectionOutputKind } from "@/kernel/api/tensorFieldProjection";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { planarToolStore, type PlanarToolId } from "@/kernel/visualization/planarToolStore";

import { fieldMapActive, planarFromContext } from "./fieldMapViewCommands";
import {
  MULTISLICE_MAX_PANELS,
  MULTISLICE_MIN_PANELS,
  evenMultisliceFractions,
} from "./model/planarMultislice";
import { zoomPlanarInteractionAt } from "./renderer/planarInteraction";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarMaskLayer = "points" | "streamlines";

/** One zoom-in step of the toolbar, matching the canvas `+` key. */
export const PLANAR_ZOOM_STEP = 1.25;

const OPEN_2D_VIEW = "Open the 2D view first.";
const STATE_UNAVAILABLE = "Planar visualization state is unavailable.";

/** Tool group (plan §2.2, group 1): exactly one tool is active. */
export const PLANAR_TOOL_COMMANDS: readonly {
  id: `field-map.tool.${PlanarToolId}`;
  tool: PlanarToolId;
  title: string;
  shortcut: string;
}[] = [
  { id: "field-map.tool.navigate", tool: "navigate", title: "Navigate", shortcut: "H" },
  { id: "field-map.tool.zoom-box", tool: "zoom-box", title: "Zoom to Box", shortcut: "B" },
  { id: "field-map.tool.crop", tool: "crop", title: "Crop", shortcut: "C" },
  { id: "field-map.tool.inspect", tool: "inspect", title: "Inspect Node", shortcut: "I" },
  { id: "field-map.tool.profile", tool: "profile", title: "Line Profile", shortcut: "P" },
  { id: "field-map.tool.measure", tool: "measure", title: "Measure", shortcut: "R" },
];

/**
 * View-mask toggles (plan §2.2, group 3) over `planar.layers.*` that have no
 * keyboard command yet. Vectors, mesh and contours are the existing
 * `field-map.toggle-vectors|mesh|contours` view commands.
 */
const MASK_TOGGLES: readonly { id: string; layer: PlanarMaskLayer; title: string }[] = [
  { id: "field-map.toggle-points", layer: "points", title: "Sample Points" },
  { id: "field-map.toggle-streamlines", layer: "streamlines", title: "Field Lines" },
];

function unavailable(message: string): CommandResult {
  return { message, status: "failed" };
}

function layerOn(planar: PlanarState, layer: PlanarMaskLayer): boolean {
  return planar.layers[layer] ?? false;
}

/** A scalar tensor projection has no vectors; turning a stale layer off stays allowed. */
function maskDisabledReason(planar: PlanarState | null, layer: PlanarMaskLayer): string | null {
  if (!planar || layer !== "streamlines" || layerOn(planar, layer)) return null;
  return tensorProjectionOutputKind(planar.component) === "scalar"
    ? "The selected tensor projection is scalar and has no vector field."
    : null;
}

function multisliceDisabledReason(planar: PlanarState | null): string | null {
  if (!planar) return null;
  if (planar.source.kind !== "default") return "Slice panels apply to the Default source.";
  if (planar.field_overlays?.length && !planar.multislice?.enabled) {
    return "Combined object fields use one shared section.";
  }
  return null;
}

function queueInteraction(
  context: CommandContext,
  interaction: { panU: number; panV: number; zoom: number },
): CommandResult {
  context.visualizationSync!.queuePatch({
    planar: {
      interaction: { pan_u_m: interaction.panU, pan_v_m: interaction.panV, zoom: interaction.zoom },
    },
  });
  return { status: "completed" };
}

/**
 * Zoom about the centre of the current view. Pan is stored relative to the
 * bounds centre, so the anchor is the pan itself and the bounds cancel out;
 * the result is clamped exactly as wheel zoom is.
 */
export function zoomPlanarViewCentre(
  interaction: { panU: number; panV: number; zoom: number },
  factor: number,
): { panU: number; panV: number; zoom: number } {
  const origin = [0, 0, 0, 0] as const;
  return zoomPlanarInteractionAt(
    origin,
    interaction,
    interaction.panU,
    interaction.panV,
    interaction.zoom * factor,
  );
}

interface ToolCommandSpec {
  id: string;
  title: string;
  shortcut?: string;
  requiresInput?: boolean;
  isActive?: (context: CommandContext) => boolean;
  reason?: (planar: PlanarState | null) => string | null;
  /** Patches the planar profile; requires the presented state and the sync controller. */
  run?: (context: CommandContext, planar: PlanarState) => CommandResult;
  /** Changes only client tool state; needs no planar profile. */
  runClient?: (context: CommandContext) => CommandResult;
}

function contribution(spec: ToolCommandSpec): CommandContribution {
  const reason = (context: CommandContext): string | null => {
    if (!fieldMapActive(context)) return OPEN_2D_VIEW;
    return spec.reason?.(planarFromContext(context)) ?? null;
  };
  return {
    category: "Viewport",
    disabledReason: reason,
    group: "field-map",
    id: spec.id,
    isActive: spec.isActive,
    isEnabled: (context) => reason(context) === null,
    requiresInput: spec.requiresInput,
    run: (context) => {
      const obsolete = obsoleteSessionResult(context);
      if (obsolete) return obsolete;
      if (spec.runClient) return spec.runClient(context);
      const planar = planarFromContext(context);
      if (!context.visualizationSync || !planar || !spec.run) return unavailable(STATE_UNAVAILABLE);
      const refusal = spec.reason?.(planar);
      if (refusal) return unavailable(refusal);
      return spec.run(context, planar);
    },
    scope: "viewport",
    shortcut: spec.shortcut,
    title: spec.title,
  };
}

function planarInteraction(planar: PlanarState) {
  return {
    panU: planar.interaction.pan_u_m,
    panV: planar.interaction.pan_v_m,
    zoom: planar.interaction.zoom,
  };
}

function panelCount(input: unknown): number | null {
  const value = typeof input === "number"
    ? input
    : input && typeof input === "object"
      ? (input as { count?: unknown }).count
      : null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MULTISLICE_MIN_PANELS &&
    value <= MULTISLICE_MAX_PANELS
    ? value
    : null;
}

const toolSpecs: ToolCommandSpec[] = PLANAR_TOOL_COMMANDS.map(({ id, title, tool, shortcut }) => ({
  id,
  isActive: () => planarToolStore.getSnapshot().activeTool === tool,
  runClient: () => {
    planarToolStore.setActiveTool(tool);
    return { status: "completed" };
  },
  shortcut,
  title: `${title} (2D)`,
}));

const navigationSpecs: ToolCommandSpec[] = [
  {
    id: "field-map.zoom-in",
    title: "Zoom In 2D View",
    run: (context, planar) => queueInteraction(context, zoomPlanarViewCentre(planarInteraction(planar), PLANAR_ZOOM_STEP)),
  },
  {
    id: "field-map.zoom-out",
    title: "Zoom Out 2D View",
    run: (context, planar) => queueInteraction(context, zoomPlanarViewCentre(planarInteraction(planar), 1 / PLANAR_ZOOM_STEP)),
  },
  {
    id: "field-map.fit",
    shortcut: "F",
    title: "Fit 2D View",
    run: (context) => queueInteraction(context, { panU: 0, panV: 0, zoom: 1 }),
  },
];

const maskSpecs: ToolCommandSpec[] = [
  ...MASK_TOGGLES.map(({ id, layer, title }): ToolCommandSpec => ({
    id,
    isActive: (context) => {
      const planar = planarFromContext(context);
      return planar ? layerOn(planar, layer) : false;
    },
    reason: (planar) => maskDisabledReason(planar, layer),
    run: (context, planar) => {
      context.visualizationSync!.queuePatch({
        planar: { layers: { ...planar.layers, [layer]: !layerOn(planar, layer) } },
      });
      return { status: "completed" };
    },
    title: `Toggle 2D ${title}`,
  })),
  {
    id: "field-map.toggle-multislice",
    isActive: (context) => planarFromContext(context)?.multislice?.enabled ?? false,
    reason: multisliceDisabledReason,
    run: (context, planar) => {
      context.visualizationSync!.queuePatch({
        planar: {
          multislice: {
            enabled: !(planar.multislice?.enabled ?? false),
            position_fractions: planar.multislice?.position_fractions ?? evenMultisliceFractions(3),
          },
        },
      });
      return { status: "completed" };
    },
    title: "Toggle 2D Slice Panels",
  },
  {
    id: "field-map.multislice-panels",
    reason: (planar) => planar && planar.source.kind !== "default"
      ? "Slice panels apply to the Default source."
      : null,
    requiresInput: true,
    run: (context) => {
      const count = panelCount(context.input);
      if (count === null) {
        return unavailable(`Slice panels must be between ${MULTISLICE_MIN_PANELS} and ${MULTISLICE_MAX_PANELS}.`);
      }
      context.visualizationSync!.queuePatch({
        planar: { multislice: { enabled: true, position_fractions: evenMultisliceFractions(count) } },
      });
      // Panel positions are sample identity of every panel.
      void context.visualizationSync!.flushNow?.();
      return { status: "completed" };
    },
    title: "Set 2D Slice Panel Count",
  },
  {
    id: "field-map.toggle-legend",
    isActive: (context) => planarFromContext(context)?.viewport_colorbar_visible ?? false,
    run: (context, planar) => {
      context.visualizationSync!.queuePatch({
        planar: { viewport_colorbar_visible: !planar.viewport_colorbar_visible },
      });
      return { status: "completed" };
    },
    title: "Toggle 2D Legend",
  },
];

/**
 * Toolbar commands of the 2D view (plan §2.2): canvas tools, one-shot
 * navigation and whole-view masks. The toolbar, ribbon, shortcuts and
 * palette render these same contributions; tools change only the ephemeral
 * `planarToolStore`, the rest patch `visualization/state.planar`.
 */
export const fieldMapToolCommands: CommandContribution[] = [
  ...toolSpecs,
  ...navigationSpecs,
  ...maskSpecs,
].map(contribution);

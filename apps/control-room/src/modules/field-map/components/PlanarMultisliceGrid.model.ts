import type { MultisliceExtent } from "../model/planarMultislice";
import { type PlanarFieldLayer } from "@/modules/inspector/public";
import { isDirectionColormap } from "@/shared/visualization/directionColor";
import { planarScopeQuery } from "../model/fieldMapDataPlan";
import { normalizePlanarColorRange, type PlanarDisplayRange } from "../model/fieldMapRenderModel";
import type { PlanarFieldQuery, PlanarFieldSource } from "@/kernel/api/apiTypes";
import { type ReactNode } from "react";

export interface PlanarMultisliceGridProps {
  quantityId: string;
  source: PlanarFieldSource;
  /** Data-plan query of the single view; each panel adds its `position_fraction`. */
  baseQuery: PlanarFieldQuery;
  positionFractions: readonly number[];
  colormap: string;
  colorByDirection: boolean;
  /** Client-derived component (x, y, z, |v|) from the vector payload, or null. */
  clientComponent: string | null;
  requestVectors: boolean;
  range: PlanarDisplayRange | null;
  rasterOpacity: number;
  /**
   * Shared colour legend, rendered with the union range and the canonical
   * unit the panels' metadata reports (`null` until the first panel loads).
   */
  renderLegend: (range: { max: number; min: number } | null, panelCanonicalUnit: string | null) => ReactNode;
  /**
   * Layers model (ADR 0080 W7): the panels draw this layer — the first visible
   * one — instead of the base field. `null` means no layer is visible.
   * Omitted in the legacy model.
   */
  fieldLayer?: PlanarFieldLayer | null;
}

/** Panel inputs of one field layer: its quantity, component, scope and colouring. */
export function multisliceLayerProps(
  props: PlanarMultisliceGridProps,
  layer: PlanarFieldLayer,
): PlanarMultisliceGridProps {
  const direction = isDirectionColormap(layer.colormap);
  return {
    ...props,
    baseQuery: {
      ...props.baseQuery,
      component: layer.component,
      ...planarScopeQuery(layer.view_scope),
      vector_budget: direction ? Math.max(1, props.baseQuery.vector_budget ?? 1) : 0,
    },
    clientComponent: null,
    colorByDirection: direction,
    colormap: layer.colormap,
    quantityId: layer.quantity_id,
    range: normalizePlanarColorRange(layer.range),
    rasterOpacity: layer.raster_opacity,
    requestVectors: direction,
  };
}

interface MultisliceExtents {
  getSnapshot: () => ReadonlyMap<number, MultisliceExtent>;
  getServerSnapshot: () => ReadonlyMap<number, MultisliceExtent>;
  subscribe: (listener: () => void) => () => void;
  update: (fraction: number, extent: MultisliceExtent | null) => void;
}

export function createMultisliceExtents(): MultisliceExtents {
  const empty = new Map<number, MultisliceExtent>();
  let snapshot = empty;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => empty,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(fraction, extent) {
      const previous = snapshot.get(fraction);
      if (previous?.min === extent?.min && previous?.max === extent?.max) return;
      const next = new Map(snapshot);
      if (extent) next.set(fraction, extent);
      else next.delete(fraction);
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

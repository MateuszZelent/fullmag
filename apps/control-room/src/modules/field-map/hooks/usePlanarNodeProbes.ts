"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  PlanarFieldMetaResource,
  PlanarFieldProbeResource,
  PlanarFieldQuery,
  PlanarFieldSource,
  PlanarProbeNodeResource,
} from "@/kernel/api/apiTypes";
import { usePlanarProbeLoader } from "@/kernel/resources/planarFieldResources";
import type { PlanarCursorUv } from "@/kernel/visualization/planarToolStore";

import { localProbe } from "../model/fieldMapProbe";
import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";

/** Quiet time after the last pointer move before the node probes are sent. */
export const NODE_PROBE_DEBOUNCE_MS = 80;
/** Visible occupied layers probed per position (plan §2.3). */
export const NODE_PROBE_MAX_LAYERS = 4;

/** One visible field layer as the inspect tool sees it. */
export interface PlanarFieldLayerRuntime {
  id: string;
  /** `target · quantity` as in the legend. */
  label: string;
  quantityId: string;
  source: PlanarFieldSource;
  meta: PlanarFieldMetaResource;
  /** Canonical sample query of the layer (sample token, revisions, window). */
  query: PlanarFieldQuery;
  /** Display unit and the canonical→display factor of its values. */
  unit: string;
  scale: number;
  /** Raster placement in the displayed frame and its occupancy mask. */
  bounds: readonly [number, number, number, number];
  resolution: readonly [number, number];
  mask: Uint8Array | null;
  /** Displayed-frame u/v minus the layer's own frame u/v (composition shift). */
  shift: readonly [number, number];
}

export type PlanarNodeProbeStatus =
  | "loading"
  | "ok"
  | "empty"
  | "unsupported_operator"
  | "unsupported_quantity"
  | "error";

/**
 * Reading of one layer. Values are in `unit`; the node's `u_m`/`v_m` are in
 * the displayed frame, so a ring drawn there sits on the shown raster.
 */
export interface PlanarNodeProbeResult {
  layerId: string;
  label: string;
  unit: string;
  status: PlanarNodeProbeStatus;
  point: { scalar: number | null; vector: [number, number, number] | null };
  node: PlanarProbeNodeResource | null;
}

/** True when the layer's own mask marks the point as part of its target. */
export function planarLayerOccupiedAt(layer: PlanarFieldLayerRuntime, uv: PlanarCursorUv): boolean {
  const [uMin, uMax, vMin, vMax] = layer.bounds;
  if (!(uv.u_m >= uMin && uv.u_m <= uMax && uv.v_m >= vMin && uv.v_m <= vMax)) return false;
  if (!layer.mask) return true;
  const { index } = localProbe(uv.u_m, uv.v_m, layer.bounds, layer.resolution, layer.mask, layer.mask);
  return isRenderablePlanarOccupancy(layer.mask[index]);
}

/** Layers probed at a point: occupied ones, in list order, at most four. */
export function selectNodeProbeLayers(
  layers: readonly PlanarFieldLayerRuntime[],
  uv: PlanarCursorUv,
): PlanarFieldLayerRuntime[] {
  return layers.filter((layer) => planarLayerOccupiedAt(layer, uv)).slice(0, NODE_PROBE_MAX_LAYERS);
}

function scaled(value: number | null | undefined, scale: number): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * scale : null;
}

function scaledVector(vector: readonly number[] | null | undefined, scale: number): [number, number, number] | null {
  return vector?.length === 3 && vector.every(Number.isFinite)
    ? [vector[0]! * scale, vector[1]! * scale, vector[2]! * scale]
    : null;
}

function emptyResult(layer: PlanarFieldLayerRuntime, status: PlanarNodeProbeStatus): PlanarNodeProbeResult {
  return {
    label: layer.label,
    layerId: layer.id,
    node: null,
    point: { scalar: null, vector: null },
    status,
    unit: layer.unit,
  };
}

/** Maps a `/probe?nearest=node` response into the displayed frame and unit. */
export function nodeProbeResult(
  layer: PlanarFieldLayerRuntime,
  probe: PlanarFieldProbeResource,
): PlanarNodeProbeResult {
  const status: PlanarNodeProbeStatus = probe.nearest_node_status === "ok" && probe.nearest_node
    ? "ok"
    : probe.nearest_node_status === "unsupported_operator" || probe.nearest_node_status === "unsupported_quantity"
      ? probe.nearest_node_status
      : probe.nearest_node_status === "empty" || probe.occupancy !== "occupied"
        ? "empty"
        : "error";
  const node = status === "ok" && probe.nearest_node
    ? {
        ...probe.nearest_node,
        scalar: scaled(probe.nearest_node.scalar, layer.scale),
        u_m: probe.nearest_node.u_m + layer.shift[0],
        v_m: probe.nearest_node.v_m + layer.shift[1],
        vector: scaledVector(probe.nearest_node.vector, layer.scale),
      }
    : null;
  return {
    ...emptyResult(layer, status),
    node,
    point: { scalar: scaled(probe.scalar, layer.scale), vector: scaledVector(probe.vector, layer.scale) },
  };
}

/**
 * Nearest-node readings of the visible layers under a point (plan Task 9).
 * Requests go only to layers whose own mask is occupied there, in list
 * order, at most `NODE_PROBE_MAX_LAYERS`; they are debounced by
 * `NODE_PROBE_DEBOUNCE_MS` and a new position aborts the previous requests,
 * so a late answer for an old position is never shown (Review Focus 4).
 */
export function usePlanarNodeProbes({
  enabled,
  uv,
  layers,
}: {
  enabled: boolean;
  uv: PlanarCursorUv | null;
  layers: readonly PlanarFieldLayerRuntime[];
}): PlanarNodeProbeResult[] {
  const loader = usePlanarProbeLoader();
  const selected = useMemo(
    () => (enabled && uv ? selectNodeProbeLayers(layers, uv) : []),
    [enabled, layers, uv],
  );
  const requestKey = uv && selected.length > 0
    ? JSON.stringify([uv.u_m, uv.v_m, selected.map((layer) => [layer.id, layer.quantityId, layer.source, layer.query])])
    : null;
  const [settled, setSettled] = useState<{ key: string; results: PlanarNodeProbeResult[] } | null>(null);
  const pending = useMemo(() => selected.map((layer) => emptyResult(layer, "loading")), [selected]);

  useEffect(() => {
    if (requestKey === null || uv === null || loader === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const results = selected.map((layer) => emptyResult(layer, "loading"));
      const publish = (index: number, result: PlanarNodeProbeResult) => {
        if (controller.signal.aborted) return;
        results[index] = result;
        setSettled({ key: requestKey, results: [...results] });
      };
      selected.forEach((layer, index) => {
        loader(
          layer.quantityId,
          layer.source,
          {
            ...layer.query,
            nearest: "node",
            u_m: uv.u_m - layer.shift[0],
            v_m: uv.v_m - layer.shift[1],
          },
          controller.signal,
        ).then(
          (probe) => publish(index, nodeProbeResult(layer, probe)),
          () => publish(index, emptyResult(layer, "error")),
        );
      });
    }, NODE_PROBE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loader, requestKey, selected, uv]);

  if (requestKey === null) return EMPTY_RESULTS;
  return settled?.key === requestKey ? settled.results : pending;
}

const EMPTY_RESULTS: PlanarNodeProbeResult[] = [];

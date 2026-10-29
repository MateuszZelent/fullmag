"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { decodeFieldVector } from "@/kernel/api/codecs";
import type { PlanarFieldQuery, PlanarFieldSource } from "@/kernel/api/apiTypes";
import {
  planarFieldQueryFromMeta,
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
  usePlanarScalarResource,
  usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";

import {
  derivePlanarComponentScalar,
  isClientDerivablePlanarComponent,
} from "../model/planarComponentDerivation";
import { resolvePlanarDisplayRange, type PlanarDisplayRange } from "../model/fieldMapRenderModel";
import { createPlanarColorizer } from "../renderer/planarColorizer";
import { createPlanarRenderer, type PlanarRenderer } from "../renderer/planarRenderer";
import {
  resolveMultisliceRange,
  type MultisliceExtent,
} from "../model/planarMultislice";

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
  /** Shared colour legend, rendered with the union range. */
  renderLegend: (range: { max: number; min: number } | null) => ReactNode;
}

/**
 * Multislice panels of the Default source (F6 B2, note 0970 § Multislice
 * panels). Every panel is its own sample; quantity, component, palette and the
 * colour range are shared, the auto range being the union of panel extrema.
 */
export function PlanarMultisliceGrid(props: PlanarMultisliceGridProps) {
  const [extents, setExtents] = useState<readonly (MultisliceExtent | null)[]>([]);
  // One panel per distinct position: a repeated fraction is the same sample.
  const fractions = useMemo(() => [...new Set(props.positionFractions)], [props.positionFractions]);
  const count = fractions.length;
  const onExtent = useCallback((index: number, extent: MultisliceExtent | null) => {
    setExtents((current) => {
      const previous = current[index] ?? null;
      if (previous?.min === extent?.min && previous?.max === extent?.max) return current;
      const next = Array.from({ length: Math.max(current.length, index + 1) }, (_, i) => current[i] ?? null);
      next[index] = extent;
      return next;
    });
  }, []);
  const sharedRange = useMemo(
    () => resolveMultisliceRange(props.range, extents.slice(0, count)),
    [count, extents, props.range],
  );
  return (
    <div className="fm-field-map__multislice" data-multislice-panels={count}>
      <div
        className="fm-field-map__multislice-grid"
        style={{ gridTemplateColumns: `repeat(${count <= 2 ? count : 2}, minmax(0, 1fr))` }}
      >
        {fractions.map((fraction, index) => (
          <PlanarMultislicePanel
            key={fraction}
            fraction={fraction}
            index={index}
            onExtent={onExtent}
            sharedRange={sharedRange}
            {...props}
          />
        ))}
      </div>
      {props.renderLegend(sharedRange)}
    </div>
  );
}

function PlanarMultislicePanel({
  baseQuery,
  clientComponent,
  colorByDirection,
  colormap,
  fraction,
  index,
  onExtent,
  quantityId,
  rasterOpacity,
  requestVectors,
  sharedRange,
  source,
}: PlanarMultisliceGridProps & {
  fraction: number;
  index: number;
  onExtent: (index: number, extent: MultisliceExtent | null) => void;
  sharedRange: { max: number; min: number } | null;
}) {
  const query = useMemo(() => ({ ...baseQuery, position_fraction: fraction }), [baseQuery, fraction]);
  const meta = usePlanarFieldMetaResource(quantityId, source, query, { enabled: true });
  const canonical = useMemo(
    () => (meta.status === "ready" && meta.data ? planarFieldQueryFromMeta(quantityId, source, meta.data) : null),
    [meta.data, meta.status, quantityId, source],
  );
  const dataQuery = canonical?.ok ? canonical.query : null;
  const ready = dataQuery !== null;
  const scalar = usePlanarScalarResource(quantityId, source, dataQuery ?? query, { enabled: ready });
  const mask = usePlanarMaskResource(quantityId, source, dataQuery ?? query, { enabled: ready });
  const vectors = usePlanarVectorResource(quantityId, source, dataQuery ?? query, {
    enabled: ready && requestVectors,
  });
  const worldVectors = useMemo(
    () => (vectors.data ? decodeFieldVector(vectors.data).values : null),
    [vectors.data],
  );
  const values = useMemo(
    () => clientComponent && worldVectors && isClientDerivablePlanarComponent(clientComponent)
      ? derivePlanarComponentScalar(worldVectors, clientComponent)
      : scalar.data ? decodeFieldVector(scalar.data.data).values : null,
    [clientComponent, scalar.data, worldVectors],
  );
  const maskValues = useMemo(() => (mask.data ? new Uint8Array(mask.data) : null), [mask.data]);
  const resolution = meta.data?.resolution;
  const width = resolution?.[0] ?? 0;
  const height = resolution?.[1] ?? 0;
  const [uMin, uMax, vMin, vMax] = (meta.data?.frame.bounds_uv_m ?? []) as (number | undefined)[];

  useEffect(() => {
    const extent = values ? resolvePlanarDisplayRange(values, maskValues ?? undefined, { mode: "auto" }) : null;
    onExtent(index, extent);
  }, [index, maskValues, onExtent, values]);
  useEffect(() => () => onExtent(index, null), [index, onExtent]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PlanarRenderer | null>(null);
  const colorizerRef = useRef<ReturnType<typeof createPlanarColorizer> | null>(null);
  const sizeRef = useRef({ height: 0, width: 0 });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createPlanarRenderer(canvas);
    rendererRef.current = renderer;
    colorizerRef.current = createPlanarColorizer(
      new Worker(new URL("../renderer/planarRendererWorker.ts", import.meta.url), { type: "module" }),
      ({ pixels }) => rendererRef.current?.draw(pixels, sizeRef.current.width, sizeRef.current.height),
    );
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      renderer.resize(entry.contentRect.width, entry.contentRect.height, window.devicePixelRatio || 1);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      colorizerRef.current?.dispose();
      colorizerRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);
  const rangeMin = sharedRange?.min;
  const rangeMax = sharedRange?.max;
  useEffect(() => {
    const colorizer = colorizerRef.current;
    if (!colorizer || !values || width < 1 || height < 1) return;
    if (rangeMin === undefined || rangeMax === undefined) return;
    if (uMin === undefined || uMax === undefined || vMin === undefined || vMax === undefined) return;
    sizeRef.current = { height, width };
    const bounds = [uMin, uMax, vMin, vMax] as const;
    rendererRef.current?.setViewport(bounds, bounds);
    colorizer.colorize(values, { max: rangeMax, min: rangeMin }, maskValues ?? undefined, {
      colormap,
      contours: false,
      directionVectors: colorByDirection ? worldVectors : null,
      height,
      level: (rangeMin + rangeMax) / 2,
      opacity: rasterOpacity,
      width,
    });
  }, [colorByDirection, colormap, height, maskValues, rangeMax, rangeMin, rasterOpacity, uMax, uMin, vMax, vMin, values, width, worldVectors]);

  const coordinate = meta.data?.section?.resolved_coordinate_m;
  const error = meta.status === "error"
    ? meta.error?.message
    : canonical && !canonical.ok
      ? String(canonical.error instanceof Error ? canonical.error.message : canonical.error)
      : scalar.status === "error" ? scalar.error?.message : null;
  const state = error ? "error" : values && sharedRange ? "ready" : "loading";
  return (
    <figure
      className="fm-field-map__multislice-panel"
      data-multislice-fraction={fraction}
      data-multislice-sample-token={meta.data?.sample_token ?? ""}
      data-multislice-state={state}
    >
      <div className="fm-field-map__multislice-plot">
        <div
          className="fm-field-map__multislice-stack"
          // Keep the physical u:v aspect of the sample, as the single view does.
          style={uMin !== undefined && uMax !== undefined && vMin !== undefined && vMax !== undefined && vMax > vMin
            ? ({ "--fm-planar-aspect": String((uMax - uMin) / (vMax - vMin)) } as CSSProperties)
            : undefined}
        >
          <canvas
            aria-label={`Slice at ${(fraction * 100).toFixed(1)}% of the domain`}
            className="fm-field-map__multislice-canvas"
            ref={canvasRef}
            role="img"
          />
        </div>
      </div>
      <figcaption className="fm-field-map__multislice-caption">
        {meta.data?.section?.normal_axis ?? "n"} ={" "}
        {coordinate === undefined ? "…" : `${(coordinate * 1e9).toFixed(2)} nm`}
        {error ? <span className="fm-field-map__multislice-error"> — {error}</span> : null}
      </figcaption>
    </figure>
  );
}

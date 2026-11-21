"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import { decodeFieldVector } from "@/kernel/api/codecs";

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
import { resolvePlanarDisplayRange } from "../model/fieldMapRenderModel";
import { createPlanarColorizer } from "../renderer/planarColorizer";
import { createPlanarRenderer, type PlanarRenderer } from "../renderer/planarRenderer";
import { resolveMultisliceRange } from "../model/planarMultislice";
import { useRetainedPlanarFrame } from "../hooks/useRetainedPlanarFrame";
import { describePlanarError, isSupersededPlanarError } from "../model/planarErrorCopy";
import { createMultisliceExtents, type PlanarMultisliceGridProps, multisliceLayerProps } from "./PlanarMultisliceGrid.model";

/**
 * Multislice panels of the Default source (F6 B2, note 0970 § Multislice
 * panels). Every panel is its own sample; quantity, component, palette and the
 * colour range are shared, the auto range being the union of panel extrema.
 */
export function PlanarMultisliceGrid(props: PlanarMultisliceGridProps) {
  if (props.fieldLayer === null) {
    return (
      <div className="fm-field-map__multislice" data-multislice-panels={0}>
        <p className="fm-field-map__diagnostic" role="status">No visible field layer. Show a layer to draw slice panels.</p>
      </div>
    );
  }
  return <PlanarMultislicePanels {...(props.fieldLayer ? multisliceLayerProps(props, props.fieldLayer) : props)} />;
}

function PlanarMultislicePanels(props: PlanarMultisliceGridProps) {
  const [extentStore] = useState(createMultisliceExtents);
  const extents = useSyncExternalStore(extentStore.subscribe, extentStore.getSnapshot, extentStore.getServerSnapshot);
  // One panel per distinct position: a repeated fraction is the same sample.
  const fractions = useMemo(() => [...new Set(props.positionFractions)], [props.positionFractions]);
  const count = fractions.length;
  // Every panel samples the same quantity, so the first panel's metadata (the
  // same resource the panel itself loads) names the legend unit.
  const firstQuery = useMemo(
    () => ({ ...props.baseQuery, position_fraction: fractions[0] }),
    [fractions, props.baseQuery],
  );
  const firstMeta = usePlanarFieldMetaResource(props.quantityId, props.source, firstQuery, { enabled: count > 0 });
  const panelUnit = firstMeta.data?.canonical_unit ?? null;
  const sharedRange = useMemo(
    () => resolveMultisliceRange(props.range, fractions.map((fraction) => extents.get(fraction) ?? null)),
    [extents, fractions, props.range],
  );
  return (
    <div className="fm-field-map__multislice" data-multislice-panels={count}>
      <div
        className="fm-field-map__multislice-grid"
        style={{ gridTemplateColumns: `repeat(${count <= 2 ? count : 2}, minmax(0, 1fr))` }}
      >
        {fractions.map((fraction) => (
          <PlanarMultislicePanel
            key={fraction}
            fraction={fraction}
            extentStore={extentStore}
            sharedRange={sharedRange}
            {...props}
          />
        ))}
      </div>
      {props.renderLegend(sharedRange, panelUnit)}
    </div>
  );
}

function PlanarMultislicePanel({
  baseQuery,
  clientComponent,
  colorByDirection,
  colormap,
  fraction,
  extentStore,
  quantityId,
  rasterOpacity,
  requestVectors,
  sharedRange,
  source,
}: PlanarMultisliceGridProps & {
  fraction: number;
  extentStore: ReturnType<typeof createMultisliceExtents>;
  sharedRange: { max: number; min: number } | null;
}) {
  const query = useMemo(() => ({ ...baseQuery, position_fraction: fraction }), [baseQuery, fraction]);
  const metadata = usePlanarFieldMetaResource(quantityId, source, query, { enabled: true });
  const canonical = useMemo(
    () => (metadata.status === "ready" && metadata.data ? planarFieldQueryFromMeta(quantityId, source, metadata.data) : null),
    [metadata.data, metadata.status, quantityId, source],
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
  // Colour a panel only once its mask and vectors match the scalar, so a live
  // refresh never draws an unmasked or direction-less intermediate frame.
  const layersSettled =
    ["ready", "stale", "error"].includes(mask.status) &&
    (!requestVectors || ["ready", "stale", "error"].includes(vectors.status));
  const resolution = metadata.data?.resolution;
  const width = resolution?.[0] ?? 0;
  const height = resolution?.[1] ?? 0;
  // Keep the panel's bounds while its metadata reloads so the aspect does not jump.
  const bounds = useRetainedPlanarFrame(String(fraction), metadata.data?.frame.bounds_uv_m ?? null);
  const [uMin, uMax, vMin, vMax] = (bounds ?? []) as (number | undefined)[];

  // While a live refresh resamples the panel, keep its last extent so the
  // shared range and legend do not fall back to "pending" on every revision.
  useEffect(() => {
    if (!values) return;
    extentStore.update(fraction, resolvePlanarDisplayRange(values, maskValues ?? undefined, { mode: "auto" }));
  }, [extentStore, fraction, maskValues, values]);
  useEffect(() => () => extentStore.update(fraction, null), [extentStore, fraction]);

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
    if (!colorizer || !values || !layersSettled || width < 1 || height < 1) return;
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
  }, [colorByDirection, colormap, height, layersSettled, maskValues, rangeMax, rangeMin, rasterOpacity, uMax, uMin, vMax, vMin, values, width, worldVectors]);

  const coordinate = useRetainedPlanarFrame(
    String(fraction),
    metadata.data?.section?.resolved_coordinate_m ?? null,
  ) ?? undefined;
  const failure = metadata.status === "error"
    ? metadata.error
    : canonical && !canonical.ok
      ? canonical.error
      : scalar.status === "error" ? scalar.error : null;
  const error = failure && !isSupersededPlanarError(failure) ? describePlanarError(failure) : null;
  const state = error ? "error" : values && sharedRange ? "ready" : "loading";
  return (
    <figure
      className="fm-field-map__multislice-panel"
      data-multislice-fraction={fraction}
      data-multislice-sample-token={metadata.data?.sample_token ?? ""}
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
        {metadata.data?.section?.normal_axis ?? "n"} ={" "}
        {coordinate === undefined ? "…" : `${(coordinate * 1e9).toFixed(2)} nm`}
        {error ? (
          <span className="fm-field-map__multislice-error" title={error.technical}> — {error.message}</span>
        ) : null}
      </figcaption>
    </figure>
  );
}

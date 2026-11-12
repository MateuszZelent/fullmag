"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type { PlanarFieldMetaResource, PlanarFieldQuery, PlanarFieldSource } from "@/kernel/api/apiTypes";
import { decodeFieldVector } from "@/kernel/api/codecs";
import {
  planarFieldQueryFromMeta, planarWindowFromQuery, usePlanarFieldMetaResource, usePlanarMaskResource,
  usePlanarScalarResource, usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { isDirectionColormap } from "@/shared/visualization/directionColor";
import { effectivePass, layerVisible, type PlanarLayerPass, type PlanarLayerState } from "@/modules/inspector/public";
import { buildFieldMapRenderModel, normalizePlanarColorRange, projectPlanarVectors, type FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { createPlanarCompositionFrameStore, type PlanarCompositionFrameStore, type PlanarLayerFrame } from "../model/planarCompositionFrame";
import {
  alignPlanarFieldFrames, isPlanarWindowMissError, overlayPlanarWindow, planarMetaFrame, planarPhysicalPosition,
  type PlanarFieldOverlay,
} from "../model/planarFieldComposition";
import { planarScopeQuery } from "../model/fieldMapDataPlan";
import { PlanarSurface } from "../renderer/PlanarSurface";
import { PlanarCompositionBuffers } from "./PlanarCompositionBuffers";

type Props = Omit<ComponentProps<typeof PlanarSurface>, "fieldOverlayContent"> & {
  active: boolean;
  baseMeta: PlanarFieldMetaResource;
  baseQuery: PlanarFieldQuery;
  source: PlanarFieldSource;
  profiles: readonly PlanarFieldOverlay[];
  vectorBudget?: number;
  targetLabels?: Readonly<Record<string, string>>;
  renderBaseLegend?: (model: FieldMapRenderModel, meta: PlanarFieldMetaResource) => ReactNode;
  /**
   * Whole-view masks (`planar.layers`, ADR 0080 W5). A pass is drawn when the
   * mask AND the layer flag are on; omitted, every layer flag applies as is.
   */
  viewMasks?: PlanarLayerState;
};

const ALL_MASKS_ON: PlanarLayerState = {
  boundaries: true, bounds: true, contours: true, mesh: true, points: true,
  probes: true, raster: true, streamlines: true, vectors: true,
};
const DRAWN_PASSES: readonly PlanarLayerPass[] = ["raster", "vectors", "points", "contours", "streamlines"];
type LayerPasses = Readonly<Record<PlanarLayerPass, boolean>>;

/** Passes a layer draws: view mask AND layer flag; a hidden layer draws nothing. */
export function planarLayerPasses(profile: PlanarFieldOverlay, viewMasks: PlanarLayerState): LayerPasses {
  const on = (pass: PlanarLayerPass) => effectivePass(profile, viewMasks, pass) === "on";
  return {
    raster: on("raster"), vectors: on("vectors"), points: on("points"),
    mesh: on("mesh"), contours: on("contours"), streamlines: on("streamlines"),
  };
}

/**
 * Layers that take part in the composite, bottom first: the list is drawn from
 * its end to its start so the first layer is on top. Hidden layers and layers
 * without a drawn pass are left out and therefore request no data.
 */
export function planarCompositionLayers(
  profiles: readonly PlanarFieldOverlay[],
  viewMasks: PlanarLayerState,
): { profile: PlanarFieldOverlay; passes: LayerPasses }[] {
  const drawn: { profile: PlanarFieldOverlay; passes: LayerPasses }[] = [];
  for (let index = profiles.length - 1; index >= 0; index -= 1) {
    const profile = profiles[index]!;
    if (!layerVisible(profile)) continue;
    const passes = planarLayerPasses(profile, viewMasks);
    if (DRAWN_PASSES.some((pass) => passes[pass])) drawn.push({ profile, passes });
  }
  return drawn;
}

/** One surface and one bounded atomic frame for independently requested fields. */
export function PlanarCompositionSurface({
  active, baseMeta, baseQuery, source, profiles, renderBaseLegend, vectorBudget = 2000, targetLabels,
  viewMasks = ALL_MASKS_ON, ...surface
}: Props) {
  const store = useMemo(() => createPlanarCompositionFrameStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const { resourceKey: sessionKey } = useSessionScopedResourceKey("planar-composition");
  const terminal = useSessionStatusSelector((status) => status.data?.lifecycle.solver === "completed", { enabled: active });
  const drawn = useMemo(() => planarCompositionLayers(profiles, viewMasks), [profiles, viewMasks]);
  const enabledProfiles = useMemo(() => drawn.map(({ profile }) => profile), [drawn]);
  const key = useMemo(() => JSON.stringify([
    sessionKey, source, baseQuery.snapshot_id, baseQuery.stage_id, baseMeta.scene_revision,
    baseMeta.generation_id, baseMeta.quantity_id, baseMeta.component,
    baseMeta.frame, baseMeta.operator,
    enabledProfiles.map((profile) => [profile.id, profile.quantity_id, profile.component, profile.view_scope]),
  ]), [sessionKey, source, baseQuery.snapshot_id, baseQuery.stage_id, baseMeta, enabledProfiles]);
  const base = useMemo(() => ({ meta: baseMeta, model: surface.model }), [baseMeta, surface.model]);
  useLayoutEffect(() => {
    store.configure(key, base, enabledProfiles.map((profile) => profile.id), terminal || Boolean(baseQuery.snapshot_id));
  }, [store, key, base, enabledProfiles, terminal, baseQuery.snapshot_id]);
  useEffect(() => () => store.dispose(), [store]);
  const frame = snapshot.key === key ? snapshot.frame : null;
  const pending = !frame || snapshot.pending;
  const status = snapshot.key === key ? snapshot.reason : "Loading the requested field layers.";
  return <>
    {drawn.map(({ profile, passes }) => <PlanarOverlayLoader
      active={active}
      baseMeta={baseMeta}
      baseQuery={baseQuery}
      key={profile.id}
      passes={passes}
      profile={profile}
      requestKey={key}
      source={source}
      store={store}
      vectorBudget={vectorBudget}
    />)}
    <PlanarCompositionBuffers
      frame={frame}
      scopeKey={JSON.stringify([sessionKey, baseMeta.generation_id, baseMeta.scene_revision])}
      payloadPending={pending}
      surfaceProps={surface}
      renderBaseLegend={renderBaseLegend}
      statusReason={status}
      targetLabels={targetLabels}
    />
  </>;
}

function PlanarOverlayLoader({ active, baseMeta, baseQuery, source, passes, profile, requestKey, store, vectorBudget }: {
  active: boolean; baseMeta: PlanarFieldMetaResource; baseQuery: PlanarFieldQuery; passes: LayerPasses;
  source: PlanarFieldSource; profile: PlanarFieldOverlay; requestKey: string; store: PlanarCompositionFrameStore; vectorBudget: number;
}) {
  const needsVectors = passes.vectors || passes.streamlines || (passes.raster && isDirectionColormap(profile.colormap));
  // The crop window is sampled at crop resolution for every layer, in the
  // layer's own frame. Until that frame's offset to the base is known, the
  // layer is requested without a window to learn it (the frame origin does
  // not depend on the window).
  const baseWindow = useMemo(() => planarWindowFromQuery(baseQuery), [baseQuery]);
  const windowed = baseWindow.window_u_min_m !== undefined;
  const shiftIdentity = JSON.stringify([
    source, profile.quantity_id, profile.view_scope,
    baseMeta.frame.origin_m, baseMeta.frame.u_axis, baseMeta.frame.v_axis,
  ]);
  const [learnedShift, setLearnedShift] = useState<{ identity: string; shift: readonly [number, number] } | null>(null);
  const shift = learnedShift?.identity === shiftIdentity ? learnedShift.shift : null;
  const overlayWindow = useMemo(
    () => (windowed && shift ? overlayPlanarWindow(baseWindow, shift) : {}),
    [baseWindow, shift, windowed],
  );
  const learning = windowed && shift === null;
  const query = useMemo<PlanarFieldQuery>(() => ({
    component: profile.component,
    ...planarScopeQuery(profile.view_scope),
    ...(source.kind === "default" ? { position_m: planarPhysicalPosition(baseMeta) } : {}),
    quality: baseQuery.quality, resolution_x: baseQuery.resolution_x, resolution_y: baseQuery.resolution_y,
    snapshot_id: baseQuery.snapshot_id, stage_id: baseQuery.stage_id,
    include_mesh: false, vector_budget: needsVectors ? Math.max(1, vectorBudget) : 0,
    ...overlayWindow,
  }), [profile.component, profile.view_scope, source.kind, baseMeta, baseQuery, needsVectors, vectorBudget, overlayWindow]);
  const meta = usePlanarFieldMetaResource(profile.quantity_id, source, query, { enabled: active });
  // The layer frame offset is learned from the layer's own metadata (render-
  // time state adjustment: the next query depends on it, no effect needed).
  const alignedShift = useMemo(() => {
    if (!meta.data) return null;
    const alignment = alignPlanarFieldFrames(baseMeta, meta.data);
    return alignment.ok ? alignment.shift : null;
  }, [baseMeta, meta.data]);
  if (alignedShift && (shift?.[0] !== alignedShift[0] || shift?.[1] !== alignedShift[1])) {
    setLearnedShift({ identity: shiftIdentity, shift: alignedShift });
  }
  const parsed = useMemo(() => meta.status === "ready" && meta.data
    ? planarFieldQueryFromMeta(profile.quantity_id, source, meta.data) : null,
  [meta.data, meta.status, profile.quantity_id, source]);
  const canonical = parsed?.ok ? parsed.query : null;
  const payloadEnabled = active && canonical !== null && !learning;
  const scalar = usePlanarScalarResource(profile.quantity_id, source, canonical ?? query, { enabled: payloadEnabled });
  const mask = usePlanarMaskResource(profile.quantity_id, source, canonical ?? query, { enabled: payloadEnabled });
  const vectors = usePlanarVectorResource(profile.quantity_id, source, canonical ?? query, { enabled: payloadEnabled && needsVectors });
  const candidate = useMemo<{ frame: PlanarLayerFrame | null; error: string | null; empty?: true }>(() => {
    if (parsed && !parsed.ok) return { frame: null, error: parsed.error.message };
    const failure = meta.error ?? scalar.error ?? mask.error ?? (needsVectors ? vectors.error : null);
    if (windowed && isPlanarWindowMissError(failure)) return { frame: null, error: null, empty: true };
    if (failure) return { frame: null, error: `Field layer ${profile.quantity_id}: ${failure.message}` };
    // The full-frame sample only teaches the frame offset; it is not drawn.
    if (learning) return { frame: null, error: null };
    if (!meta.data || meta.status !== "ready" || scalar.status !== "ready" || !scalar.data ||
        mask.status !== "ready" || !mask.data || (needsVectors && (vectors.status !== "ready" || !vectors.data))) {
      return { frame: null, error: null };
    }
    try {
      const values = decodeFieldVector(scalar.data.data).values;
      const occupancy = new Uint8Array(mask.data);
      const worldVectors = needsVectors && vectors.data ? decodeFieldVector(vectors.data).values : null;
      const count = meta.data.resolution[0]! * meta.data.resolution[1]!;
      if (values.length !== count || occupancy.length !== count || (worldVectors && worldVectors.length !== count * 3)) {
        return { frame: null, error: "Field layer payload does not match its canonical sample resolution." };
      }
      const frame = planarMetaFrame(meta.data);
      const model = buildFieldMapRenderModel({
        bounds: meta.data.frame.bounds_uv_m as [number, number, number, number],
        canonicalUnit: meta.data.canonical_unit, colormap: profile.colormap, component: profile.component,
        frame, layers: {
          contours: passes.contours, mesh: false, points: passes.points, probes: false,
          raster: passes.raster, streamlines: passes.streamlines, vectors: passes.vectors,
        },
        mask: occupancy, range: normalizePlanarColorRange(profile.range), rasterOpacity: profile.raster_opacity,
        resolution: meta.data.resolution as [number, number], sampleIdentity: meta.data.etag, scalar: values,
        vectors: worldVectors ? projectPlanarVectors(worldVectors, frame) : null, worldVectors,
        vectorBudget, vectorScale: profile.vector_style.scale,
        vectorStyle: { color: profile.vector_style.monochrome_color, colorMode: profile.vector_style.color_mode,
          lengthMode: profile.vector_style.length_mode, opacity: profile.vector_style.opacity, thickness: profile.vector_style.thickness },
      });
      return { frame: model ? { meta: meta.data, model } : null, error: model ? null : "Field layer cannot be rendered." };
    } catch (error) {
      return { frame: null, error: error instanceof Error ? error.message : "Field layer payload is invalid." };
    }
  }, [parsed, meta.data, meta.status, meta.error, scalar.data, scalar.status, scalar.error,
    mask.data, mask.status, mask.error, vectors.data, vectors.status, vectors.error,
    needsVectors, passes, profile, vectorBudget, windowed, learning]);
  const publish = useCallback(() => candidate.empty
    ? store.acceptEmpty(requestKey, profile.id)
    : store.accept(requestKey, profile.id, candidate.frame, candidate.error),
  [store, requestKey, profile.id, candidate]);
  useEffect(publish, [publish]);
  return null;
}

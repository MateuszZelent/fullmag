"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type { PlanarFieldMetaResource, PlanarFieldQuery, PlanarFieldSource } from "@/kernel/api/apiTypes";
import { decodeFieldVector } from "@/kernel/api/codecs";
import {
  planarFieldQueryFromMeta, usePlanarFieldMetaResource, usePlanarMaskResource,
  usePlanarScalarResource, usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { isDirectionColormap } from "@/shared/visualization/directionColor";
import { buildFieldMapRenderModel, normalizePlanarColorRange, projectPlanarVectors, type FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { createPlanarCompositionFrameStore, type PlanarCompositionFrameStore, type PlanarLayerFrame } from "../model/planarCompositionFrame";
import { planarMetaFrame, planarPhysicalPosition, type PlanarFieldOverlay } from "../model/planarFieldComposition";
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
};

/** One surface and one bounded atomic frame for independently requested fields. */
export function PlanarCompositionSurface({
  active, baseMeta, baseQuery, source, profiles, renderBaseLegend, vectorBudget = 2000, targetLabels, ...surface
}: Props) {
  const store = useMemo(() => createPlanarCompositionFrameStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const { resourceKey: sessionKey } = useSessionScopedResourceKey("planar-composition");
  const terminal = useSessionStatusSelector((status) => status.data?.lifecycle.solver === "completed", { enabled: active });
  const enabledProfiles = useMemo(() => profiles.filter((profile) => profile.raster_visible || profile.vectors_visible), [profiles]);
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
    {enabledProfiles.map((profile) => <PlanarOverlayLoader
      active={active}
      baseMeta={baseMeta}
      baseQuery={baseQuery}
      key={profile.id}
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

function PlanarOverlayLoader({ active, baseMeta, baseQuery, source, profile, requestKey, store, vectorBudget }: {
  active: boolean; baseMeta: PlanarFieldMetaResource; baseQuery: PlanarFieldQuery;
  source: PlanarFieldSource; profile: PlanarFieldOverlay; requestKey: string; store: PlanarCompositionFrameStore; vectorBudget: number;
}) {
  const needsVectors = profile.vectors_visible || isDirectionColormap(profile.colormap);
  const query = useMemo<PlanarFieldQuery>(() => ({
    component: profile.component,
    ...planarScopeQuery(profile.view_scope),
    ...(source.kind === "default" ? { position_m: planarPhysicalPosition(baseMeta) } : {}),
    quality: baseQuery.quality, resolution_x: baseQuery.resolution_x, resolution_y: baseQuery.resolution_y,
    snapshot_id: baseQuery.snapshot_id, stage_id: baseQuery.stage_id,
    include_mesh: false, vector_budget: needsVectors ? Math.max(1, vectorBudget) : 0,
  }), [profile.component, profile.view_scope, source.kind, baseMeta, baseQuery, needsVectors, vectorBudget]);
  const meta = usePlanarFieldMetaResource(profile.quantity_id, source, query, { enabled: active });
  const parsed = useMemo(() => meta.status === "ready" && meta.data
    ? planarFieldQueryFromMeta(profile.quantity_id, source, meta.data) : null,
  [meta.data, meta.status, profile.quantity_id, source]);
  const canonical = parsed?.ok ? parsed.query : null;
  const scalar = usePlanarScalarResource(profile.quantity_id, source, canonical ?? query, { enabled: active && canonical !== null });
  const mask = usePlanarMaskResource(profile.quantity_id, source, canonical ?? query, { enabled: active && canonical !== null });
  const vectors = usePlanarVectorResource(profile.quantity_id, source, canonical ?? query, { enabled: active && canonical !== null && needsVectors });
  const candidate = useMemo<{ frame: PlanarLayerFrame | null; error: string | null }>(() => {
    if (parsed && !parsed.ok) return { frame: null, error: parsed.error.message };
    const failure = meta.error ?? scalar.error ?? mask.error ?? (needsVectors ? vectors.error : null);
    if (failure) return { frame: null, error: `Field layer ${profile.quantity_id}: ${failure.message}` };
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
        frame, layers: { contours: false, mesh: false, probes: false, raster: profile.raster_visible, vectors: profile.vectors_visible },
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
    needsVectors, profile, vectorBudget]);
  const publish = useCallback(() => store.accept(requestKey, profile.id, candidate.frame, candidate.error),
    [store, requestKey, profile.id, candidate]);
  useEffect(publish, [publish]);
  return null;
}

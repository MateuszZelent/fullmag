"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import type { PlanarRenderEvidence } from "../model/fieldMapEvidence";
import type { PlanarCompositionFrame } from "../model/planarCompositionFrame";
import {
  createPlanarCompositionBufferStore, PLANAR_COMPOSITION_BASE_LAYER, planarCompositionOverlayLayer,
  type PlanarCompositionBufferSlot, type PlanarCompositionSlotId,
} from "../model/planarCompositionBuffers";
import { PlanarSurface } from "../renderer/PlanarSurface";
import { PlanarOverlaySurface } from "../renderer/PlanarOverlaySurface";
import { PlanarLayerLegendList, type PlanarLayerLegendEntry } from "./PlanarColorLegend";

type SurfaceProps = Omit<ComponentProps<typeof PlanarSurface>, "model" | "fieldOverlayContent">;
export interface PlanarCompositionBuffersProps {
  frame: PlanarCompositionFrame | null;
  scopeKey: string;
  payloadPending: boolean;
  surfaceProps: SurfaceProps;
  renderBaseLegend?: (model: FieldMapRenderModel, meta: PlanarFieldMetaResource) => ReactNode;
  statusReason?: string | null;
  targetLabels?: Readonly<Record<string, string>>;
}

/** Two persistent renderer stacks: only a completely acknowledged stack is visible. */
export function PlanarCompositionBuffers({ frame, scopeKey, payloadPending, surfaceProps, renderBaseLegend, statusReason, targetLabels }: PlanarCompositionBuffersProps) {
  const store = useMemo(() => createPlanarCompositionBufferStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useLayoutEffect(() => { store.prepare(scopeKey, frame); }, [store, scopeKey, frame]);
  const inScope = snapshot.scopeKey === scopeKey;
  const visibleId = inScope ? snapshot.visibleSlot : null;
  const visible = visibleId ? snapshot.slots[visibleId] : null;
  const pending = payloadPending || snapshot.preparingSlot !== null || !visible;
  const callbackRef = useRef(surfaceProps.onRenderEvidence);
  useLayoutEffect(() => { callbackRef.current = surfaceProps.onRenderEvidence; }, [surfaceProps.onRenderEvidence]);
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible?.baseEvidence || !visibleId) return;
    const identity = `${scopeKey}:${visibleId}:${visible.generation}`;
    if (reportedRef.current === identity) return;
    reportedRef.current = identity;
    callbackRef.current?.(visible.baseEvidence);
  }, [scopeKey, visibleId, visible]);
  // The node inspector probes the layers on screen, so it follows the visible stack.
  const frameCallbackRef = useRef(surfaceProps.onCompositionFrame);
  useLayoutEffect(() => { frameCallbackRef.current = surfaceProps.onCompositionFrame; }, [surfaceProps.onCompositionFrame]);
  const visibleFrame = visible?.frame ?? null;
  // The frame holds overlays bottom-first; legends follow list order (top first).
  const legendEntries = useMemo((): PlanarLayerLegendEntry[] => (visibleFrame?.overlays ?? [])
    .map((layer) => ({
      colormap: layer.model.colormap,
      component: layer.model.component,
      id: layer.id,
      legendUnit: layer.model.display.legendUnit,
      probeScale: layer.model.display.probeScale,
      quantityId: layer.meta.quantity_id,
      range: layer.model.range,
      targetLabel: targetLabels?.[layer.id] ?? (layer.meta.scope_kind === "airbox" ? "Airbox" : layer.meta.scope_id ?? layer.id),
    }))
    .reverse(), [targetLabels, visibleFrame]);
  useEffect(() => {
    if (visibleFrame) frameCallbackRef.current?.(visibleFrame);
  }, [visibleFrame]);
  return <><div className="fm-field-map__composition-buffers"
    data-planar-composition-state={pending ? "pending" : visible?.frame.coherence ?? "unavailable"}
    data-planar-composition-visible-slot={visibleId ?? "none"}
    style={{ position: "relative", width: "100%", height: "100%", minHeight: 0 }}>
    {(["A", "B"] as const).map((id) => {
      const slot = inScope ? snapshot.slots[id] : null;
      return <div key={id} data-planar-composition-slot={id}
        aria-hidden={visibleId !== id} inert={visibleId !== id ? true : undefined}
        style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", position: "absolute", inset: 0, visibility: visibleId === id ? "visible" : "hidden", pointerEvents: visibleId === id ? undefined : "none" }}>
        {slot ? <BufferedSlot id={id} slot={slot} store={store} surfaceProps={surfaceProps}
          interactive={visibleId === id} payloadPending={pending} /> : null}
      </div>;
    })}
    {!visible ? <div role="status" className="fm-field-map__diagnostic">{statusReason ?? "Loading the requested field layers."}</div> : null}
  </div>
    {visible ? <div className="fm-field-map__composition-legends" style={{ pointerEvents: "none" }}>
      {renderBaseLegend?.(visible.frame.base.model, visible.frame.base.meta)}
      <PlanarLayerLegendList
        layers={legendEntries}
        rangeState={pending ? "stale-compatible" : "current"}
        visible={surfaceProps.legendsVisible !== false}
      />
      {pending || statusReason ? <span role="status" className="fm-field-map__diagnostic">
        {statusReason ?? "Preparing the requested field layers."}
      </span> : null}
    </div> : null}
  </>;
}

function BufferedSlot({ id, slot, store, surfaceProps, interactive, payloadPending }: {
  id: PlanarCompositionSlotId; slot: PlanarCompositionBufferSlot;
  store: ReturnType<typeof createPlanarCompositionBufferStore>; surfaceProps: SurfaceProps;
  interactive: boolean; payloadPending: boolean;
}) {
  const reportBase = useCallback((evidence: PlanarRenderEvidence) => {
    store.acknowledge(id, slot.generation, PLANAR_COMPOSITION_BASE_LAYER, evidence);
  }, [store, id, slot.generation]);
  return <PlanarSurface {...surfaceProps} model={slot.frame.base.model}
    onInteraction={interactive ? surfaceProps.onInteraction : undefined}
    onPin={interactive && !payloadPending ? surfaceProps.onPin : undefined}
    onProfileSegment={interactive && !payloadPending ? surfaceProps.onProfileSegment : undefined}
    profileSegment={interactive && !payloadPending ? surfaceProps.profileSegment : null}
    probeOverlay={interactive && !payloadPending ? surfaceProps.probeOverlay : null}
    onRenderEvidence={reportBase}
    fieldOverlayContent={slot.frame.overlays.map((layer) => <BufferedOverlay
      key={layer.id} layerId={layer.id} quantityId={layer.meta.quantity_id} model={layer.model}
      slotId={id} generation={slot.generation} store={store} />)} />;
}

/**
 * The overlay replays its completed evidence whenever its callback identity
 * changes, so the callback is stable per slot generation: a re-render of the
 * slot must not trigger another evidence replay (and state update) cycle.
 */
function BufferedOverlay({ layerId, quantityId, model, slotId, generation, store }: {
  layerId: string; quantityId: string; model: FieldMapRenderModel;
  slotId: PlanarCompositionSlotId; generation: number;
  store: ReturnType<typeof createPlanarCompositionBufferStore>;
}) {
  const acknowledge = useCallback((evidence: PlanarRenderEvidence) => {
    store.acknowledge(slotId, generation, planarCompositionOverlayLayer(layerId), evidence);
  }, [store, slotId, generation, layerId]);
  return <PlanarOverlaySurface id={layerId} quantityId={quantityId} model={model} onRenderEvidence={acknowledge} />;
}

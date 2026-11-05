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
import { PlanarColorLegend } from "./PlanarColorLegend";

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
    {visible ? <div className="fm-field-map__composition-legends" style={{ position: "relative", pointerEvents: "none" }}>
      {renderBaseLegend?.(visible.frame.base.model, visible.frame.base.meta)}
      {visible.frame.overlays.map((layer) => <PlanarColorLegend key={layer.id}
        colormap={layer.model.colormap} component={layer.model.component}
        legendUnit={layer.model.display.legendUnit} probeScale={layer.model.display.probeScale}
        targetLabel={targetLabels?.[layer.id] ?? layer.meta.scope_id ?? layer.id}
        quantityId={layer.meta.quantity_id} range={layer.model.range}
        rangeState={pending ? "stale-compatible" : "current"} />)}
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
    fieldOverlayContent={slot.frame.overlays.map((layer) => <PlanarOverlaySurface
      key={layer.id} id={layer.id} quantityId={layer.meta.quantity_id} model={layer.model}
      onRenderEvidence={(evidence) => store.acknowledge(id, slot.generation, planarCompositionOverlayLayer(layer.id), evidence)} />)} />;
}

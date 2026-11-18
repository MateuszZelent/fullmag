"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { planarModelRenderKey, type PlanarRenderEvidence } from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { usePlanarSurfaceRenderer } from "./usePlanarSurfaceRenderer";

export interface PlanarOverlaySurfaceProps {
  id: string;
  quantityId: string;
  model: FieldMapRenderModel;
  onRenderEvidence?: (evidence: PlanarRenderEvidence) => void;
}

/** One transparent planar field layer aligned to its owning PlanarSurface. */
export function PlanarOverlaySurface({
  id,
  quantityId,
  model,
  onRenderEvidence,
}: PlanarOverlaySurfaceProps) {
  const [renderedEvidence, setRenderedEvidence] = useState<PlanarRenderEvidence | null>(null);
  const onRenderEvidenceRef = useRef(onRenderEvidence);
  useLayoutEffect(() => { onRenderEvidenceRef.current = onRenderEvidence; }, [onRenderEvidence]);

  const reportRenderEvidence = useCallback((evidence: PlanarRenderEvidence) => {
    setRenderedEvidence(evidence);
    onRenderEvidenceRef.current?.(evidence);
  }, []);
  const { canvasRef, overlayRef, replayCompletedEvidence } = usePlanarSurfaceRenderer(model, reportRenderEvidence);
  // A reused buffer generation needs an ACK even when this layer's pixels
  // are unchanged. Replay only the renderer's current completed evidence.
  useLayoutEffect(() => {
    replayCompletedEvidence();
  }, [onRenderEvidence, replayCompletedEvidence]);
  const renderedEvidenceJson = renderedEvidence ? JSON.stringify(renderedEvidence) : undefined;
  const renderedSampleIdentity = renderedEvidence?.sampleIdentity;
  const renderedCurrent = renderedEvidence?.renderKey === planarModelRenderKey(model);

  const evidenceAttributes = {
    "data-planar-overlay-id": id,
    "data-planar-overlay-quantity": quantityId,
    "data-planar-overlay-sample": model.sampleIdentity,
    "data-planar-overlay-rendered-sample": renderedSampleIdentity,
    "data-planar-overlay-rendered-current": String(renderedCurrent),
    "data-planar-overlay-rendered-evidence": renderedEvidenceJson,
  };

  return (
    <>
      <canvas
        {...evidenceAttributes}
        ref={canvasRef}
        aria-hidden="true"
        className="fm-field-map__canvas fm-field-map__canvas--overlay"
        data-planar-overlay-layer="raster"
      />
      <canvas
        {...evidenceAttributes}
        ref={overlayRef}
        aria-hidden="true"
        className="fm-field-map__canvas fm-field-map__canvas--overlay"
        data-planar-overlay-layer="vectors"
      />
    </>
  );
}

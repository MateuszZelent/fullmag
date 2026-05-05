"use client";

import { useEffect, useMemo, useRef } from "react";

import {
  buildViewport3DUpdateSignature,
  resolveViewport3DUpdateClass,
  type Viewport3DUpdateClass,
  type Viewport3DUpdateSignature,
} from "@/features/viewport-unified/model/viewport3dUpdateClass";

export function useViewport3DUpdateClassification(args: Parameters<typeof buildViewport3DUpdateSignature>[0]): {
  updateClass: Viewport3DUpdateClass;
  updateSignature: Viewport3DUpdateSignature;
} {
  const updateSignature = useMemo(
    () => buildViewport3DUpdateSignature(args),
    [
      args.dataFieldRevision,
      args.effectiveVectorComponent,
      args.effectiveViewMode,
      args.femFerromagnetVisibilityMode,
      args.femVectorDomainFilter,
      args.meshClipAxis,
      args.meshClipEnabled,
      args.meshClipPos,
      args.meshFieldRevision,
      args.meshRenderMode,
      args.selectedQuantity,
      args.topologyRevision,
    ],
  );
  const previousSignatureRef = useRef<Viewport3DUpdateSignature | null>(null);
  const updateClass = resolveViewport3DUpdateClass(
    previousSignatureRef.current,
    updateSignature,
  );

  useEffect(() => {
    previousSignatureRef.current = updateSignature;
  }, [updateSignature]);

  return {
    updateClass,
    updateSignature,
  };
}

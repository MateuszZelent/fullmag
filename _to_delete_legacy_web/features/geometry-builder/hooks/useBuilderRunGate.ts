/**
 * P6 — Builder Run Gate Hook
 *
 * Composes the existing run gate from DirtyGraphStore
 * with geometry builder state to produce a unified RunGateState.
 */

import { useMemo } from "react";
import { useDirtyGraphStore } from "@/features/interaction/store/useDirtyGraphStore";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import { extendRunGateWithBuilder } from "@/features/interaction/model/runGate";

export function useBuilderRunGate() {
  const baseRunGate = useDirtyGraphStore((s) => s.runGate);
  const builderActive = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const validateAll = useGeometryBuilderStore((s) => s.validateAll);

  return useMemo(() => {
    if (!builderActive) return baseRunGate;

    const validations = validateAll();
    const hasValidationErrors = validations.some(
      (v) => !v.withinUniverse || v.selfInvalid,
    );

    return extendRunGateWithBuilder(baseRunGate, {
      active: true,
      geometryDraftDirty: dirty.geometryDraftDirty,
      geometryRealizationDirty: dirty.geometryRealizationDirty,
      meshDirty: dirty.meshDirty,
      hasValidationErrors,
    });
  }, [baseRunGate, builderActive, dirty, validateAll]);
}

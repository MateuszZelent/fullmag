"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createPlanarFrameRetention } from "../model/planarFrameRetention";

export function useRetainedPlanarFrame<TModel>(
  identityKey: string | null,
  freshModel: TModel | null,
  sourceDefinitionKey: string | null = null,
): TModel | null {
  const retention = useMemo(() => createPlanarFrameRetention<TModel>(), []);
  // A fresh frame already renders from resource inputs. Publishing its fallback
  // must not trigger another render (or loop when a producer changes identity).
  const getRetainedSnapshot = useCallback(() => {
    if (freshModel !== null || identityKey === null) return null;
    const frame = retention.getSnapshot();
    return frame?.identityKey === identityKey &&
      (sourceDefinitionKey === null || frame.sourceDefinitionKey === sourceDefinitionKey) ? frame : null;
  }, [freshModel, identityKey, retention, sourceDefinitionKey]);
  const retained = useSyncExternalStore(
    retention.subscribe,
    getRetainedSnapshot,
    retention.getServerSnapshot,
  );
  useEffect(() => {
    retention.retain(identityKey, freshModel, sourceDefinitionKey);
  }, [freshModel, identityKey, retention, sourceDefinitionKey]);
  if (identityKey === null) return null;
  return freshModel ?? (retained?.identityKey === identityKey ? retained.model : null);
}

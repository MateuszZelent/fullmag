/**
 * Unified viewport hook.
 *
 * Consumes a SpatialDomainAdapter (FDM or FEM) and a CapabilityMap,
 * returning a discretization-agnostic model plus a set of boolean
 * flags that control which UI controls are available.
 */

import { useMemo, useState } from "react";
import type { SpatialDomainAdapter } from "../../../src/domain/adapters/SpatialDomainAdapter";
import type { CapabilityMap } from "../../../src/api/types";
import {
  DEFAULT_UNIFIED_RENDER_STATE,
  type UnifiedRenderState,
} from "../model/unifiedViewportTypes";
import type {
  Viewport3DCapabilities,
  Viewport3DModel,
} from "../model/viewport3dContracts";
import { resolveViewport3DCapabilities } from "../model/viewport3dCapabilities";
import {
  buildToolbarStateFromLegacy,
  buildViewport3DModelFromAdapter,
} from "../model/viewport3dAdapters";

interface UseUnifiedViewportOptions {
  authoringEnabled?: boolean;
  diagnosticsEnabled?: boolean;
}

export function useUnifiedViewport(
  adapter: SpatialDomainAdapter | null,
  capabilities: CapabilityMap | null,
  options: UseUnifiedViewportOptions = {},
) {
  const [renderState, setRenderState] = useState<UnifiedRenderState>(
    DEFAULT_UNIFIED_RENDER_STATE,
  );

  const resolvedCapabilities: Viewport3DCapabilities = useMemo(() => {
    return resolveViewport3DCapabilities({
      capabilities,
      authoringEnabled: options.authoringEnabled,
      diagnosticsEnabled: options.diagnosticsEnabled,
    });
  }, [capabilities, options.authoringEnabled, options.diagnosticsEnabled]);

  const toolbarState = useMemo(
    () =>
      buildToolbarStateFromLegacy({
        renderState,
        quantityId: "m",
        clipFlip: false,
        interactionMode: "camera",
        snapEnabled: false,
        objectViewMode: "context",
        vectorsVisible: true,
        legendVisible: true,
        partExplorerVisible: false,
        projection: "perspective",
        navProfile: "trackball",
      }),
    [renderState],
  );

  const model: Viewport3DModel | null = useMemo(() => {
    if (!adapter) return null;
    const bounds = adapter.getBounds();
    const extent: [number, number, number] = [
      Math.max(bounds.max[0] - bounds.min[0], 0),
      Math.max(bounds.max[1] - bounds.min[1], 0),
      Math.max(bounds.max[2] - bounds.min[2], 0),
    ];
    const center: [number, number, number] = [
      (bounds.max[0] + bounds.min[0]) * 0.5,
      (bounds.max[1] + bounds.min[1]) * 0.5,
      (bounds.max[2] + bounds.min[2]) * 0.5,
    ];
    return {
      ...buildViewport3DModelFromAdapter({
        discretization: adapter.kind,
        renderState,
        toolbarState,
        capabilities: resolvedCapabilities,
        worldExtent: extent,
        worldCenter: center,
        quantityId: toolbarState.rowA.quantity,
      }),
    };
  }, [adapter, renderState, resolvedCapabilities, toolbarState]);

  return {
    model,
    renderState,
    setRenderState,
    capabilities: resolvedCapabilities,
  };
}

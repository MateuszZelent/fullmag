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
  type UnifiedViewportModel,
} from "../model/unifiedViewportTypes";

export interface AvailableControls {
  layers: boolean;
  wireframe: boolean;
  clip: boolean;
  gridInfo: boolean;
  topology: boolean;
}

const EMPTY_CONTROLS: AvailableControls = {
  layers: false,
  wireframe: false,
  clip: false,
  gridInfo: false,
  topology: false,
};

export function useUnifiedViewport(
  adapter: SpatialDomainAdapter | null,
  capabilities: CapabilityMap | null,
) {
  const [renderState, setRenderState] = useState<UnifiedRenderState>(
    DEFAULT_UNIFIED_RENDER_STATE,
  );

  const model: UnifiedViewportModel | null = useMemo(() => {
    if (!adapter) return null;
    return {
      adapter,
      renderState,
      domainInfo: adapter.getDomainInfo(),
      geometry: adapter.getRenderGeometry(),
    };
  }, [adapter, renderState]);

  const availableControls: AvailableControls = useMemo(() => {
    if (!capabilities) return EMPTY_CONTROLS;
    return {
      layers: capabilities.structured_grid,
      wireframe: capabilities.explicit_topology,
      clip: capabilities.explicit_topology,
      gridInfo: capabilities.structured_grid,
      topology: capabilities.explicit_topology,
    };
  }, [capabilities]);

  return { model, renderState, setRenderState, availableControls };
}

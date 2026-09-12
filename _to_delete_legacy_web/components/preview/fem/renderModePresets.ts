/**
 * Per-render-mode display presets for the FEM viewport.
 *
 * Defines the default display-state values that are applied when
 * switching render mode with `resetDisplayState` enabled.
 */

import type {
  RenderMode,
  ClipAxis,
  FemVectorDomainFilter,
  FemFerromagnetVisibilityMode,
} from "./femMeshTypes";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";

export interface RenderModeDisplayPreset {
  opacity: number;
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipPos: number;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  shrinkFactor: number;
  qualityProfile: ViewportQualityProfileId;
}

export const RENDER_MODE_DISPLAY_PRESETS: Record<RenderMode, RenderModeDisplayPreset> = {
  surface: {
    opacity: 85,
    clipEnabled: false,
    clipAxis: "x",
    clipPos: 50,
    vectorDomainFilter: "auto",
    ferromagnetVisibilityMode: "hide",
    shrinkFactor: 1,
    qualityProfile: "interactive",
  },
  "surface+edges": {
    opacity: 72,
    clipEnabled: false,
    clipAxis: "x",
    clipPos: 50,
    vectorDomainFilter: "auto",
    ferromagnetVisibilityMode: "hide",
    shrinkFactor: 1,
    qualityProfile: "interactive",
  },
  wireframe: {
    opacity: 65,
    clipEnabled: false,
    clipAxis: "x",
    clipPos: 50,
    vectorDomainFilter: "auto",
    ferromagnetVisibilityMode: "hide",
    shrinkFactor: 1,
    qualityProfile: "interactive",
  },
  mesh: {
    opacity: 35,
    clipEnabled: false,
    clipAxis: "x",
    clipPos: 50,
    vectorDomainFilter: "auto",
    ferromagnetVisibilityMode: "hide",
    shrinkFactor: 1,
    qualityProfile: "interactive",
  },
  points: {
    opacity: 100,
    clipEnabled: false,
    clipAxis: "x",
    clipPos: 50,
    vectorDomainFilter: "auto",
    ferromagnetVisibilityMode: "hide",
    shrinkFactor: 1,
    qualityProfile: "interactive",
  },
};

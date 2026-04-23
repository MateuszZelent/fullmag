export type VectorSurfaceViewportQualityLevel = "low" | "high" | "ultra";
export type VectorSurfaceViewportRenderMode = "glyph" | "voxel";
export type VectorSurfaceViewportVoxelColorMode = "orientation" | "x" | "y" | "z";
export type VectorSurfaceViewportVoxelSampling = 1 | 2 | 4;
export type VectorSurfaceViewportTopoComponent = "x" | "y" | "z";

export interface VectorSurfaceViewportSettings {
  quality: VectorSurfaceViewportQualityLevel;
  renderMode: VectorSurfaceViewportRenderMode;
  voxelColorMode: VectorSurfaceViewportVoxelColorMode;
  sampling: VectorSurfaceViewportVoxelSampling;
  brightness: number;
  voxelOpacity: number;
  voxelGap: number;
  voxelThreshold: number;
  topoEnabled: boolean;
  topoComponent: VectorSurfaceViewportTopoComponent;
  topoMultiplier: number;
}

export interface VectorSurfaceViewportSettingsPreset {
  quality: VectorSurfaceViewportQualityLevel;
  render_mode: VectorSurfaceViewportRenderMode;
  voxel_color_mode: VectorSurfaceViewportVoxelColorMode;
  sampling: VectorSurfaceViewportVoxelSampling;
  brightness: number;
  voxel_opacity: number;
  voxel_gap: number;
  voxel_threshold: number;
  topo_enabled: boolean;
  topo_component: VectorSurfaceViewportTopoComponent;
  topo_multiplier: number;
}

export function settingsFromPreset(
  state: VectorSurfaceViewportSettingsPreset,
): VectorSurfaceViewportSettings {
  return {
    quality: state.quality,
    renderMode: state.render_mode,
    voxelColorMode: state.voxel_color_mode,
    sampling: state.sampling,
    brightness: state.brightness,
    voxelOpacity: state.voxel_opacity,
    voxelGap: state.voxel_gap,
    voxelThreshold: state.voxel_threshold,
    topoEnabled: state.topo_enabled,
    topoComponent: state.topo_component,
    topoMultiplier: state.topo_multiplier,
  };
}

export function settingsToPreset(
  state: VectorSurfaceViewportSettings,
): VectorSurfaceViewportSettingsPreset {
  return {
    quality: state.quality,
    render_mode: state.renderMode,
    voxel_color_mode: state.voxelColorMode,
    sampling: state.sampling,
    brightness: state.brightness,
    voxel_opacity: state.voxelOpacity,
    voxel_gap: state.voxelGap,
    voxel_threshold: state.voxelThreshold,
    topo_enabled: state.topoEnabled,
    topo_component: state.topoComponent,
    topo_multiplier: state.topoMultiplier,
  };
}

// Backward-compatible aliases for transitional call-sites.
export type FdmViewportQualityLevel = VectorSurfaceViewportQualityLevel;
export type FdmViewportRenderMode = VectorSurfaceViewportRenderMode;
export type FdmViewportVoxelColorMode = VectorSurfaceViewportVoxelColorMode;
export type FdmViewportVoxelSampling = VectorSurfaceViewportVoxelSampling;
export type FdmViewportTopoComponent = VectorSurfaceViewportTopoComponent;
export type FdmViewportSettings = VectorSurfaceViewportSettings;
export type FdmViewportSettingsPreset = VectorSurfaceViewportSettingsPreset;

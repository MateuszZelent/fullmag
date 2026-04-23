export type FdmViewportQualityLevel = "low" | "high" | "ultra";
export type FdmViewportRenderMode = "glyph" | "voxel";
export type FdmViewportVoxelColorMode = "orientation" | "x" | "y" | "z";
export type FdmViewportVoxelSampling = 1 | 2 | 4;
export type FdmViewportTopoComponent = "x" | "y" | "z";

export interface FdmViewportSettings {
  quality: FdmViewportQualityLevel;
  renderMode: FdmViewportRenderMode;
  voxelColorMode: FdmViewportVoxelColorMode;
  sampling: FdmViewportVoxelSampling;
  brightness: number;
  voxelOpacity: number;
  voxelGap: number;
  voxelThreshold: number;
  topoEnabled: boolean;
  topoComponent: FdmViewportTopoComponent;
  topoMultiplier: number;
}

export interface FdmViewportSettingsPreset {
  quality: FdmViewportQualityLevel;
  render_mode: FdmViewportRenderMode;
  voxel_color_mode: FdmViewportVoxelColorMode;
  sampling: FdmViewportVoxelSampling;
  brightness: number;
  voxel_opacity: number;
  voxel_gap: number;
  voxel_threshold: number;
  topo_enabled: boolean;
  topo_component: FdmViewportTopoComponent;
  topo_multiplier: number;
}

export function settingsFromPreset(state: FdmViewportSettingsPreset): FdmViewportSettings {
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

export function settingsToPreset(state: FdmViewportSettings): FdmViewportSettingsPreset {
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

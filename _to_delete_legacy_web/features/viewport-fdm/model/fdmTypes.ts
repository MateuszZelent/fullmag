/**
 * Viewport-FDM – model types for FDM (finite-difference) viewport engine.
 *
 * Manages the FDM grid visualization model including cell coloring,
 * layer selection, and vector field rendering.
 */

export interface FdmGridModel {
  gridSize: [number, number, number];
  cellSize: [number, number, number];
  totalCells: number;
  activeCells: number;
  activeMask: boolean[] | null;
}

export interface FdmRenderState {
  selectedLayer: number;
  allLayersVisible: boolean;
  vectorComponent: "3D" | "x" | "y" | "z";
  colorScale: "viridis" | "coolwarm" | "jet" | "magma";
  autoScale: boolean;
  maxPoints: number;
  everyN: number;
}

export const DEFAULT_FDM_RENDER_STATE: FdmRenderState = {
  selectedLayer: 0,
  allLayersVisible: false,
  vectorComponent: "3D",
  colorScale: "viridis",
  autoScale: true,
  maxPoints: 50000,
  everyN: 1,
};

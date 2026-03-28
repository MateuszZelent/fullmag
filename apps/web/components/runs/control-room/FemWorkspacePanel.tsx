"use client";

import type { ReactNode } from "react";
import { Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import MeshSettingsPanel from "../../panels/MeshSettingsPanel";
import type { MeshOptionsState, MeshQualityData } from "../../panels/MeshSettingsPanel";
import type { ClipAxis, MeshSelectionSnapshot, RenderMode } from "../../preview/FemMeshView3D";
import type { FemLiveMesh } from "../../../lib/useSessionStream";
import type { ViewportBarProps, ViewportCanvasAreaProps } from "./ViewportPanels";
import { ViewportBar, ViewportCanvasArea } from "./ViewportPanels";
import {
  type FemDockTab,
  type MeshFaceDetail,
  type PreviewComponent,
  type VectorComponent,
  type ViewportMode,
  DockTabButton,
  PANEL_SIZES,
  fmtExp,
  fmtPreviewEveryN,
  fmtSI,
} from "./shared";
import s from "../RunControlRoom.module.css";

interface MesherSettings {
  order?: number;
  hmax?: number;
}

interface MeshQualitySummary {
  min: number;
  max: number;
  mean: number;
  good: number;
  fair: number;
  poor: number;
  count: number;
}

interface PreviewOption {
  value: string;
  label: string;
  disabled: boolean;
}

interface FemWorkspacePanelProps {
  workspaceStatus: string;
  femDockTab: FemDockTab;
  setFemDockTab: React.Dispatch<React.SetStateAction<FemDockTab>>;
  openFemMeshWorkspace: (tab?: "mesh" | "quality") => void;
  effectiveFemMesh: FemLiveMesh | null;
  meshFeOrder: number | null;
  meshHmax: number | null;
  isMeshWorkspaceView: boolean;
  effectiveViewMode: ViewportMode;
  handleViewModeChange: (mode: ViewportMode) => void;
  meshRenderMode: RenderMode;
  setMeshRenderMode: React.Dispatch<React.SetStateAction<RenderMode>>;
  meshFaceDetail: MeshFaceDetail | null;
  meshSelection: MeshSelectionSnapshot;
  setMeshSelection: React.Dispatch<React.SetStateAction<MeshSelectionSnapshot>>;
  meshName: string | null;
  meshSource: string | null;
  meshExtent: [number, number, number] | null;
  meshBoundsMin: [number, number, number] | null;
  meshBoundsMax: [number, number, number] | null;
  mesherBackend: string | null;
  mesherSourceKind: string | null;
  mesherCurrentSettings: MesherSettings | null;
  meshOptions: MeshOptionsState;
  setMeshOptions: React.Dispatch<React.SetStateAction<MeshOptionsState>>;
  meshQualityData: MeshQualityData | null;
  meshGenerating: boolean;
  handleMeshGenerate: () => Promise<void>;
  previewControlsActive: boolean;
  requestedPreviewQuantity: string;
  previewQuantityOptions: PreviewOption[];
  previewBusy: boolean;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  setSelectedQuantity: (value: string) => void;
  requestedPreviewComponent: string;
  component: VectorComponent;
  setComponent: (value: VectorComponent) => void;
  requestedPreviewEveryN: number;
  previewEveryNOptions: number[];
  meshOpacity: number;
  setMeshOpacity: React.Dispatch<React.SetStateAction<number>>;
  meshShowArrows: boolean;
  setMeshShowArrows: React.Dispatch<React.SetStateAction<boolean>>;
  meshClipEnabled: boolean;
  setMeshClipEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  meshClipAxis: ClipAxis;
  setMeshClipAxis: React.Dispatch<React.SetStateAction<ClipAxis>>;
  meshClipPos: number;
  setMeshClipPos: React.Dispatch<React.SetStateAction<number>>;
  meshQualitySummary: MeshQualitySummary | null;
  viewportBarProps: ViewportBarProps;
  viewportCanvasProps: ViewportCanvasAreaProps;
  previewNotices: ReactNode;
}

export default function FemWorkspacePanel(props: FemWorkspacePanelProps) {
  const {
    workspaceStatus,
    femDockTab,
    setFemDockTab,
    openFemMeshWorkspace,
    effectiveFemMesh,
    meshFeOrder,
    meshHmax,
    isMeshWorkspaceView,
    effectiveViewMode,
    handleViewModeChange,
    meshRenderMode,
    setMeshRenderMode,
    meshFaceDetail,
    meshSelection,
    setMeshSelection,
    meshName,
    meshSource,
    meshExtent,
    meshBoundsMin,
    meshBoundsMax,
    mesherBackend,
    mesherSourceKind,
    mesherCurrentSettings,
    meshOptions,
    setMeshOptions,
    meshQualityData,
    meshGenerating,
    handleMeshGenerate,
    previewControlsActive,
    requestedPreviewQuantity,
    previewQuantityOptions,
    previewBusy,
    updatePreview,
    setSelectedQuantity,
    requestedPreviewComponent,
    component,
    setComponent,
    requestedPreviewEveryN,
    previewEveryNOptions,
    meshOpacity,
    setMeshOpacity,
    meshShowArrows,
    setMeshShowArrows,
    meshClipEnabled,
    setMeshClipEnabled,
    meshClipAxis,
    setMeshClipAxis,
    meshClipPos,
    setMeshClipPos,
    meshQualitySummary,
    viewportBarProps,
    viewportCanvasProps,
    previewNotices,
  } = props;

  return (
    <>
      <Panel
        id="workspace-fem-dock"
        defaultSize={PANEL_SIZES.femDockDefault}
        minSize={PANEL_SIZES.femDockMin}
        maxSize={PANEL_SIZES.femDockMax}
      >
        <div className={s.meshDock}>
        <div className={s.meshDockHeader}>
          <div>
            <div className={s.meshDockEyebrow}>Mesh Workspace</div>
            <div className={s.meshDockTitle}>FEM Setup</div>
          </div>
          <span className={s.meshDockStatus} data-status={workspaceStatus}>
            {workspaceStatus}
          </span>
        </div>

        <div className={s.meshDockTabs}>
          <DockTabButton active={femDockTab === "mesh"} label="Mesh" onClick={() => openFemMeshWorkspace("mesh")} />
          <DockTabButton active={femDockTab === "mesher"} label="Mesher" onClick={() => setFemDockTab("mesher")} />
          <DockTabButton active={femDockTab === "view"} label="View" onClick={() => setFemDockTab("view")} />
          <DockTabButton active={femDockTab === "quality"} label="Quality" onClick={() => openFemMeshWorkspace("quality")} />
        </div>

        <div className={s.meshDockBody}>
          {femDockTab === "mesh" && (
            <>
              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Topology</span>
                  <span className={s.meshCardBadge}>
                    {effectiveFemMesh?.elements.length ? "volume mesh" : "surface preview"}
                  </span>
                </div>
                <div className={s.meshStatGrid}>
                  <div className={s.meshStatCard}>
                    <span className={s.meshStatLabel}>Nodes</span>
                    <span className={s.meshStatValue}>{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"}</span>
                  </div>
                  <div className={s.meshStatCard}>
                    <span className={s.meshStatLabel}>Elements</span>
                    <span className={s.meshStatValue}>{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"}</span>
                  </div>
                  <div className={s.meshStatCard}>
                    <span className={s.meshStatLabel}>Boundary faces</span>
                    <span className={s.meshStatValue}>{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"}</span>
                  </div>
                  <div className={s.meshStatCard}>
                    <span className={s.meshStatLabel}>Element type</span>
                    <span className={s.meshStatValue}>{effectiveFemMesh?.elements.length ? "tet4" : "surface"}</span>
                  </div>
                  <div className={s.meshStatCard}>
                    <span className={s.meshStatLabel}>FE order</span>
                    <span className={s.meshStatValue}>{meshFeOrder != null ? String(meshFeOrder) : "—"}</span>
                  </div>
                  <div className={s.meshStatCard}>
                    <span className={s.meshStatLabel}>hmax</span>
                    <span className={s.meshStatValue}>{meshHmax != null ? fmtSI(meshHmax, "m") : "—"}</span>
                  </div>
                </div>
              </div>

              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Inspect</span>
                  <span className={s.meshCardBadge}>
                    {isMeshWorkspaceView ? "mesh viewport active" : "mesh viewport hidden"}
                  </span>
                </div>
                <div className={s.meshSegmented}>
                  {(["Mesh", "3D", "2D"] as ViewportMode[]).map((mode) => (
                    <button
                      key={mode}
                      className={s.meshSegmentBtn}
                      data-active={effectiveViewMode === mode}
                      onClick={() => handleViewModeChange(mode)}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <div className={s.meshSegmented}>
                  {([
                    ["surface", "Surface"],
                    ["surface+edges", "Surface+Edges"],
                    ["wireframe", "Wireframe"],
                    ["points", "Points"],
                  ] as [RenderMode, string][]).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={s.meshSegmentBtn}
                      data-active={meshRenderMode === mode}
                      onClick={() => setMeshRenderMode(mode)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className={s.meshHintText}>
                  Hover a boundary face to preview quality. Click to inspect it, and use
                  Shift/Ctrl-click to build a multi-selection like a real mesh workspace.
                </div>
              </div>

              {meshFaceDetail && (
                <div className={s.meshCard}>
                  <div className={s.meshCardHeader}>
                    <span className={s.meshCardTitle}>Selection</span>
                    <span className={s.meshCardBadge}>
                      {meshSelection.selectedFaceIndices.length} face{meshSelection.selectedFaceIndices.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className={s.meshInfoList}>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Face</span>
                      <span className={s.meshInfoValue}>#{meshFaceDetail.faceIndex}</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Nodes</span>
                      <span className={s.meshInfoValue}>{meshFaceDetail.nodeIndices.join(", ")}</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Area</span>
                      <span className={s.meshInfoValue}>{fmtExp(meshFaceDetail.area)} m²</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Perimeter</span>
                      <span className={s.meshInfoValue}>{fmtSI(meshFaceDetail.perimeter, "m")}</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Aspect Ratio</span>
                      <span className={s.meshInfoValue}>{meshFaceDetail.aspectRatio.toFixed(2)}</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Edges</span>
                      <span className={s.meshInfoValue}>{meshFaceDetail.edgeLengths.map((value) => fmtSI(value, "m")).join(" · ")}</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Centroid</span>
                      <span className={s.meshInfoValue}>{meshFaceDetail.centroid.map((value) => fmtExp(value)).join(", ")}</span>
                    </div>
                    <div className={s.meshInfoRow}>
                      <span className={s.meshInfoKey}>Normal</span>
                      <span className={s.meshInfoValue}>{meshFaceDetail.normal.map((value) => value.toFixed(3)).join(", ")}</span>
                    </div>
                  </div>
                  <div className={s.meshSegmented}>
                    <button
                      className={s.meshSegmentBtn}
                      onClick={() => setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null })}
                      type="button"
                    >
                      Clear selection
                    </button>
                  </div>
                </div>
              )}

              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Geometry Bounds</span>
                </div>
                <div className={s.meshInfoList}>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Mesh name</span>
                    <span className={s.meshInfoValue}>{meshName ?? "—"}</span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Source</span>
                    <span className={s.meshInfoValue} title={meshSource ?? undefined}>
                      {meshSource ? meshSource.split("/").pop() : "generated"}
                    </span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Extent X</span>
                    <span className={s.meshInfoValue}>{meshExtent ? fmtSI(meshExtent[0], "m") : "—"}</span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Extent Y</span>
                    <span className={s.meshInfoValue}>{meshExtent ? fmtSI(meshExtent[1], "m") : "—"}</span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Extent Z</span>
                    <span className={s.meshInfoValue}>{meshExtent ? fmtSI(meshExtent[2], "m") : "—"}</span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Bounds min</span>
                    <span className={s.meshInfoValue}>
                      {meshBoundsMin
                        ? `${fmtExp(meshBoundsMin[0])}, ${fmtExp(meshBoundsMin[1])}, ${fmtExp(meshBoundsMin[2])}`
                        : "—"}
                    </span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Bounds max</span>
                    <span className={s.meshInfoValue}>
                      {meshBoundsMax
                        ? `${fmtExp(meshBoundsMax[0])}, ${fmtExp(meshBoundsMax[1])}, ${fmtExp(meshBoundsMax[2])}`
                        : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className={s.meshHintBox}>
                <div className={s.meshHintTitle}>Pipeline</div>
                <div className={s.meshHintText}>
                  {effectiveFemMesh?.elements.length
                    ? "Surface import completed and tetrahedral volume mesh is active."
                    : "Surface preview is shown before full tetrahedral meshing completes."}
                </div>
              </div>
            </>
          )}

          {femDockTab === "mesher" && (
            <>
              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Mesher Runtime</span>
                  <span className={s.meshCardBadge}>{mesherBackend ?? "—"}</span>
                </div>
                <div className={s.meshInfoList}>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Backend</span>
                    <span className={s.meshInfoValue}>{mesherBackend ?? "—"}</span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Source kind</span>
                    <span className={s.meshInfoValue}>{mesherSourceKind ?? "—"}</span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>Order</span>
                    <span className={s.meshInfoValue}>
                      {typeof mesherCurrentSettings?.order === "number" ? String(mesherCurrentSettings.order) : "—"}
                    </span>
                  </div>
                  <div className={s.meshInfoRow}>
                    <span className={s.meshInfoKey}>hmax</span>
                    <span className={s.meshInfoValue}>
                      {typeof mesherCurrentSettings?.hmax === "number" ? fmtSI(mesherCurrentSettings.hmax, "m") : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <MeshSettingsPanel
                options={meshOptions}
                onChange={setMeshOptions}
                quality={meshQualityData}
                generating={meshGenerating}
                onGenerate={handleMeshGenerate}
              />
            </>
          )}

          {femDockTab === "view" && (
            <>
              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Field</span>
                </div>
                <label className={s.meshControl}>
                  <span className={s.meshControlLabel}>Quantity</span>
                  <select
                    className={s.meshSelect}
                    value={requestedPreviewQuantity}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (previewControlsActive) void updatePreview("/quantity", { quantity: next });
                      else setSelectedQuantity(next);
                    }}
                    disabled={previewBusy}
                  >
                    {(previewQuantityOptions.length
                      ? previewQuantityOptions
                      : [{ value: "m", label: "Magnetization", disabled: false }]).map((option) => (
                      <option key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={s.meshControl}>
                  <span className={s.meshControlLabel}>Component</span>
                  {previewControlsActive ? (
                    <select
                      className={s.meshSelect}
                      value={requestedPreviewComponent}
                      onChange={(event) =>
                        void updatePreview("/component", { component: event.target.value as PreviewComponent })
                      }
                      disabled={previewBusy}
                    >
                      <option value="3D">3D</option>
                      <option value="x">x</option>
                      <option value="y">y</option>
                      <option value="z">z</option>
                    </select>
                  ) : (
                    <select
                      className={s.meshSelect}
                      value={component}
                      onChange={(event) => setComponent(event.target.value as VectorComponent)}
                    >
                      <option value="magnitude">Magnitude</option>
                      <option value="x">x</option>
                      <option value="y">y</option>
                      <option value="z">z</option>
                    </select>
                  )}
                </label>
                {previewControlsActive && (
                  <label className={s.meshControl}>
                    <span className={s.meshControlLabel}>Refresh</span>
                    <select
                      className={s.meshSelect}
                      value={requestedPreviewEveryN}
                      onChange={(event) => void updatePreview("/everyN", { everyN: Number(event.target.value) })}
                      disabled={previewBusy}
                    >
                      {previewEveryNOptions.map((value) => (
                        <option key={value} value={value}>
                          {fmtPreviewEveryN(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Rendering</span>
                </div>
                <div className={s.meshSegmented}>
                  {([
                    ["surface", "Surface"],
                    ["surface+edges", "Surface+Edges"],
                    ["wireframe", "Wireframe"],
                    ["points", "Points"],
                  ] as [RenderMode, string][]).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={s.meshSegmentBtn}
                      data-active={meshRenderMode === mode}
                      onClick={() => setMeshRenderMode(mode)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className={s.meshControl}>
                  <span className={s.meshControlLabel}>Opacity</span>
                  <div className={s.meshRangeRow}>
                    <input
                      className={s.meshRange}
                      type="range"
                      min={10}
                      max={100}
                      value={meshOpacity}
                      onChange={(event) => setMeshOpacity(Number(event.target.value))}
                    />
                    <span className={s.meshRangeValue}>{meshOpacity}%</span>
                  </div>
                </label>
                <label className={s.meshCheckbox}>
                  <input
                    type="checkbox"
                    checked={meshShowArrows}
                    onChange={(event) => setMeshShowArrows(event.target.checked)}
                  />
                  <span>Show vector arrows on the surface</span>
                </label>
              </div>

              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Clipping</span>
                </div>
                <label className={s.meshCheckbox}>
                  <input
                    type="checkbox"
                    checked={meshClipEnabled}
                    onChange={(event) => setMeshClipEnabled(event.target.checked)}
                  />
                  <span>Enable clip plane</span>
                </label>
                <div className={s.meshSegmented}>
                  {(["x", "y", "z"] as ClipAxis[]).map((axis) => (
                    <button
                      key={axis}
                      className={s.meshSegmentBtn}
                      data-active={meshClipAxis === axis}
                      onClick={() => setMeshClipAxis(axis)}
                      type="button"
                      disabled={!meshClipEnabled}
                    >
                      {axis.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className={s.meshRangeRow}>
                  <input
                    className={s.meshRange}
                    type="range"
                    min={0}
                    max={100}
                    value={meshClipPos}
                    onChange={(event) => setMeshClipPos(Number(event.target.value))}
                    disabled={!meshClipEnabled}
                  />
                  <span className={s.meshRangeValue}>{meshClipPos}%</span>
                </div>
              </div>
            </>
          )}

          {femDockTab === "quality" && (
            <>
              <div className={s.meshCard}>
                <div className={s.meshCardHeader}>
                  <span className={s.meshCardTitle}>Boundary Triangle Quality</span>
                  <span className={s.meshCardBadge}>
                    {meshQualitySummary
                      ? (meshQualitySummary.mean < 3 ? "good" : meshQualitySummary.mean < 6 ? "fair" : "poor")
                      : "pending"}
                  </span>
                </div>
                {meshQualitySummary ? (
                  <>
                    <div className={s.meshStatGrid}>
                      <div className={s.meshStatCard}>
                        <span className={s.meshStatLabel}>Mean AR</span>
                        <span className={s.meshStatValue}>{meshQualitySummary.mean.toFixed(2)}</span>
                      </div>
                      <div className={s.meshStatCard}>
                        <span className={s.meshStatLabel}>Min AR</span>
                        <span className={s.meshStatValue}>{meshQualitySummary.min.toFixed(2)}</span>
                      </div>
                      <div className={s.meshStatCard}>
                        <span className={s.meshStatLabel}>Max AR</span>
                        <span className={s.meshStatValue}>{meshQualitySummary.max.toFixed(2)}</span>
                      </div>
                      <div className={s.meshStatCard}>
                        <span className={s.meshStatLabel}>Faces analysed</span>
                        <span className={s.meshStatValue}>{meshQualitySummary.count.toLocaleString()}</span>
                      </div>
                    </div>
                    {([
                      ["Good", meshQualitySummary.good, "success"],
                      ["Fair", meshQualitySummary.fair, "warn"],
                      ["Poor", meshQualitySummary.poor, "danger"],
                    ] as [string, number, "success" | "warn" | "danger"][]).map(([label, count, tone]) => {
                      const pct = meshQualitySummary.count > 0 ? (count / meshQualitySummary.count) * 100 : 0;
                      return (
                        <div key={label} className={s.meshQualityRow}>
                          <span className={s.meshQualityLabel}>{label}</span>
                          <div className={s.meshQualityTrack}>
                            <progress className={s.meshQualityFill} value={pct} max={100} data-tone={tone} />
                          </div>
                          <span className={s.meshQualityValue}>{pct.toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div className={s.meshHintText}>
                    Quality statistics will appear once the FEM boundary surface is available.
                  </div>
                )}
              </div>

              <div className={s.meshHintBox}>
                <div className={s.meshHintTitle}>Interpretation</div>
                <div className={s.meshHintText}>
                  Good meshes cluster near AR≈1-3. If the poor fraction stays high, lower
                  `hmax` or clean the imported surface before tetrahedralization.
                </div>
              </div>
            </>
          )}
        </div>
        </div>
      </Panel>

      <PanelResizeHandle className={s.meshDockResizeHandle} />

      <Panel
        id="workspace-fem-viewport"
        defaultSize={PANEL_SIZES.femViewportDefault}
        minSize={PANEL_SIZES.femViewportMin}
      >
        <div className={s.viewport}>
          <ViewportBar {...viewportBarProps} />
          {previewNotices}
          <ViewportCanvasArea {...viewportCanvasProps} />
        </div>
      </Panel>
    </>
  );
}

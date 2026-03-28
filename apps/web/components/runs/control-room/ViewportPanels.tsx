"use client";

import { cn } from "@/lib/utils";
import type { FemLiveMesh, PreviewState } from "../../../lib/useSessionStream";
import MagnetizationSlice2D from "../../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../../preview/MagnetizationView3D";
import FemMeshView3D from "../../preview/FemMeshView3D";
import FemMeshSlice2D from "../../preview/FemMeshSlice2D";
import PreviewScalarField2D from "../../preview/PreviewScalarField2D";
import type {
  ClipAxis,
  FemColorField,
  FemMeshData,
  MeshSelectionSnapshot,
  RenderMode,
} from "../../preview/FemMeshView3D";
import EmptyState from "../../ui/EmptyState";
import DimensionOverlay from "../../preview/DimensionOverlay";
import s from "../RunControlRoom.module.css";
import type {
  PreviewComponent,
  SlicePlane,
  VectorComponent,
  ViewportMode,
} from "./shared";
import { fmtExp, fmtPreviewMaxPoints, fmtSI } from "./shared";

export interface ViewportBarProps {
  isMeshWorkspaceView: boolean;
  meshName: string | null;
  effectiveFemMesh: FemLiveMesh | null;
  meshRenderMode: RenderMode;
  meshSelection: MeshSelectionSnapshot;
  previewControlsActive: boolean;
  requestedPreviewQuantity: string;
  requestedPreviewComponent: string;
  requestedPreviewEveryN: number;
  requestedPreviewMaxPoints: number;
  requestedPreviewXChosenSize: number;
  requestedPreviewYChosenSize: number;
  requestedPreviewAutoScale: boolean;
  requestedPreviewLayer: number;
  requestedPreviewAllLayers: boolean;
  previewBusy: boolean;
  previewQuantityOptions: { value: string; label: string; disabled: boolean }[];
  quantityOptions: { value: string; label: string; disabled: boolean }[];
  previewEveryNOptions: number[];
  previewMaxPointOptions: number[];
  preview: PreviewState | null;
  effectiveViewMode: ViewportMode;
  solverGrid: [number, number, number];
  plane: SlicePlane;
  sliceIndex: number;
  maxSliceCount: number;
  component: VectorComponent;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  setSelectedQuantity: (q: string) => void;
  setComponent: (c: VectorComponent) => void;
  setPlane: (p: SlicePlane) => void;
  setSliceIndex: (i: number) => void;
  isFemBackend: boolean;
  totalCells: number | null;
  activeCells: number | null;
  activeMaskPresent: boolean;
}

export function ViewportBar(props: ViewportBarProps) {
  const {
    isMeshWorkspaceView, meshName, effectiveFemMesh, meshRenderMode, meshSelection,
    previewControlsActive, requestedPreviewQuantity, requestedPreviewComponent,
    requestedPreviewEveryN, requestedPreviewMaxPoints, requestedPreviewXChosenSize, requestedPreviewYChosenSize,
    requestedPreviewAutoScale, requestedPreviewLayer, requestedPreviewAllLayers,
    previewBusy, previewQuantityOptions, quantityOptions, previewEveryNOptions, previewMaxPointOptions,
    preview, effectiveViewMode, solverGrid, plane, sliceIndex, maxSliceCount, component,
    updatePreview, setSelectedQuantity, setComponent, setPlane, setSliceIndex,
    isFemBackend, totalCells, activeCells, activeMaskPresent,
  } = props;

  return (
    <div className={s.viewportBar}>
      {isMeshWorkspaceView ? (
        <>
          <span className={s.viewportBarLabel}>Mesh</span>
          <span className={s.viewportBarMetric}>{meshName ?? "boundary surface"}</span>
          <span className={s.viewportBarSep} />
          <span className={s.viewportBarMetric}>{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"} nodes</span>
          <span className={s.viewportBarMetric}>{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"} tets</span>
          <span className={s.viewportBarMetric}>{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"} faces</span>
          <span className={s.viewportBarSep} />
          <span className={s.viewportBarLabel}>Render</span>
          <span className={s.viewportBarMetric}>
            {meshRenderMode === "surface+edges" ? "surface+edges" : meshRenderMode}
          </span>
          {meshSelection.primaryFaceIndex != null && (
            <>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Face</span>
              <span className={s.viewportBarMetric}>#{meshSelection.primaryFaceIndex}</span>
            </>
          )}
        </>
      ) : isMeshWorkspaceView && !isFemBackend ? (
        /* FDM geometry bar */
        <>
          <span className={s.viewportBarLabel}>Geometry</span>
          <span className={s.viewportBarMetric}>
            {solverGrid[0]}×{solverGrid[1]}×{solverGrid[2]}
          </span>
          <span className={s.viewportBarSep} />
          <span className={s.viewportBarLabel}>Cells</span>
          <span className={s.viewportBarMetric}>
            {totalCells?.toLocaleString() ?? "—"}
          </span>
          {activeMaskPresent && (
            <>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Active</span>
              <span className={s.viewportBarMetric}>
                {activeCells?.toLocaleString() ?? "—"}
              </span>
            </>
          )}
        </>
      ) : (
        <>
          <span className={s.viewportBarLabel}>Qty</span>
          <select
            className={s.viewportBarSelect}
            value={requestedPreviewQuantity}
            onChange={(e) => {
              const next = e.target.value;
              if (previewControlsActive) {
                void updatePreview("/quantity", { quantity: next });
              } else {
                setSelectedQuantity(next);
              }
            }}
            disabled={previewBusy}
          >
            {((previewControlsActive ? previewQuantityOptions : quantityOptions).length
              ? (previewControlsActive ? previewQuantityOptions : quantityOptions)
              : [{ value: "m", label: "Magnetization", disabled: false }]).map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>

          <span className={s.viewportBarSep} />
          <span className={s.viewportBarLabel}>Comp</span>
          {previewControlsActive ? (
            <select
              className={s.viewportBarSelect}
              value={requestedPreviewComponent}
              onChange={(e) => void updatePreview("/component", { component: e.target.value as PreviewComponent })}
              disabled={previewBusy}
            >
              <option value="3D">3D</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          ) : (
            <select
              className={s.viewportBarSelect}
              value={component}
              onChange={(e) => setComponent(e.target.value as VectorComponent)}
            >
              <option value="magnitude">|v|</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          )}

          {previewControlsActive && (
            <>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Every</span>
              <select
                className={s.viewportBarSelect}
                value={requestedPreviewEveryN}
                onChange={(e) =>
                  void updatePreview("/everyN", { everyN: Number(e.target.value) })
                }
                disabled={previewBusy}
              >
                {previewEveryNOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span className={s.viewportBarLabel}>Pts</span>
              <select
                className={s.viewportBarSelect}
                value={requestedPreviewMaxPoints}
                onChange={(e) =>
                  void updatePreview("/maxPoints", { maxPoints: Number(e.target.value) })
                }
                disabled={previewBusy}
              >
                {previewMaxPointOptions.map((value) => (
                  <option key={value} value={value}>
                    {fmtPreviewMaxPoints(value)}
                  </option>
                ))}
              </select>
            </>
          )}

          {preview ? (
            <>
              {preview.x_possible_sizes.length > 0 && preview.y_possible_sizes.length > 0 && (
                <>
                  <span className={s.viewportBarSep} />
                  <span className={s.viewportBarLabel}>X</span>
                  <select
                    className={s.viewportBarSelect}
                    value={requestedPreviewXChosenSize}
                    onChange={(e) =>
                      void updatePreview("/XChosenSize", { xChosenSize: Number(e.target.value) })
                    }
                    disabled={previewBusy}
                  >
                    {preview.x_possible_sizes.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  <span className={s.viewportBarLabel}>Y</span>
                  <select
                    className={s.viewportBarSelect}
                    value={requestedPreviewYChosenSize}
                    onChange={(e) =>
                      void updatePreview("/YChosenSize", { yChosenSize: Number(e.target.value) })
                    }
                    disabled={previewBusy}
                  >
                    {preview.y_possible_sizes.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </>
              )}
              <label className={s.viewportToggle}>
                <input
                  type="checkbox"
                  checked={requestedPreviewAutoScale}
                  onChange={(e) =>
                    void updatePreview("/autoScaleEnabled", {
                      autoScaleEnabled: e.target.checked,
                    })
                  }
                  disabled={previewBusy}
                />
                <span>Auto-fit</span>
              </label>
              {preview.spatial_kind === "grid" && solverGrid[2] > 1 && (
                <>
                  <span className={s.viewportBarLabel}>Layer</span>
                  <select
                    className={s.viewportBarSelect}
                    value={requestedPreviewLayer}
                    onChange={(e) => void updatePreview("/layer", { layer: Number(e.target.value) })}
                    disabled={previewBusy || requestedPreviewAllLayers}
                  >
                    {Array.from({ length: solverGrid[2] }, (_, i) => (
                      <option key={i} value={i}>{i}</option>
                    ))}
                  </select>
                  <label className={s.viewportToggle}>
                    <input
                      type="checkbox"
                      checked={requestedPreviewAllLayers}
                      onChange={(e) =>
                        void updatePreview("/allLayers", { allLayers: e.target.checked })
                      }
                      disabled={previewBusy}
                    />
                    <span>All layers</span>
                  </label>
                </>
              )}
              {preview.spatial_kind === "mesh" && effectiveViewMode === "2D" && (
                <>
                  <span className={s.viewportBarSep} />
                  <span className={s.viewportBarLabel}>Plane</span>
                  <select
                    className={s.viewportBarSelect}
                    value={plane}
                    onChange={(e) => setPlane(e.target.value as SlicePlane)}
                  >
                    <option value="xy">XY</option>
                    <option value="xz">XZ</option>
                    <option value="yz">YZ</option>
                  </select>
                  <span className={s.viewportBarLabel}>Slice</span>
                  <select
                    className={s.viewportBarSelect}
                    value={sliceIndex}
                    onChange={(e) => setSliceIndex(Number(e.target.value))}
                  >
                    {Array.from({ length: maxSliceCount }, (_, i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          ) : effectiveViewMode === "2D" && (
            <>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Plane</span>
              <select
                className={s.viewportBarSelect}
                value={plane}
                onChange={(e) => setPlane(e.target.value as SlicePlane)}
              >
                <option value="xy">XY</option>
                <option value="xz">XZ</option>
                <option value="yz">YZ</option>
              </select>
              <span className={s.viewportBarLabel}>Slice</span>
              <select
                className={s.viewportBarSelect}
                value={sliceIndex}
                onChange={(e) => setSliceIndex(Number(e.target.value))}
              >
                {Array.from({ length: maxSliceCount }, (_, i) => (
                  <option key={i} value={i}>{i + 1}</option>
                ))}
              </select>
            </>
          )}
        </>
      )}
    </div>
  );
}

export interface ViewportCanvasAreaProps {
  effectiveStep: number;
  effectiveTime: number;
  effectiveDmDt: number;
  isVectorQuantity: boolean;
  quantityDescriptor: { label?: string; unit?: string } | null;
  selectedScalarValue: number | null;
  preview: PreviewState | null;
  effectiveViewMode: ViewportMode;
  isFemBackend: boolean;
  femMeshData: FemMeshData | null;
  femTopologyKey: string | null;
  femColorField: FemColorField;
  femMagnetization3DActive: boolean;
  femShouldShowArrows: boolean;
  meshRenderMode: RenderMode;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: ClipAxis;
  meshClipPos: number;
  selectedQuantity: string;
  effectiveVectorComponent: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  maxSliceCount: number;
  selectedVectors: Float64Array | null;
  previewGrid: [number, number, number];
  component: VectorComponent;
  emptyStateMessage: { title: string; description: string };
  activeMask: boolean[] | null;
  setMeshRenderMode: (m: RenderMode) => void;
  setMeshOpacity: (o: number) => void;
  setMeshClipEnabled: (e: boolean) => void;
  setMeshClipAxis: (a: ClipAxis) => void;
  setMeshClipPos: (p: number) => void;
  setMeshShowArrows: (a: boolean) => void;
  setMeshSelection: (s: MeshSelectionSnapshot) => void;
  worldExtent?: [number, number, number] | null;
  gridCells?: [number, number, number] | null;
}

export function ViewportCanvasArea(props: ViewportCanvasAreaProps) {
  const {
    effectiveStep, effectiveTime, effectiveDmDt, isVectorQuantity, quantityDescriptor,
    selectedScalarValue, preview, effectiveViewMode, isFemBackend, femMeshData,
    femTopologyKey, femColorField, femMagnetization3DActive, femShouldShowArrows,
    meshRenderMode, meshOpacity, meshClipEnabled, meshClipAxis, meshClipPos,
    selectedQuantity, effectiveVectorComponent, plane, sliceIndex, maxSliceCount,
    selectedVectors, previewGrid, component, emptyStateMessage, activeMask,
    setMeshRenderMode, setMeshOpacity, setMeshClipEnabled, setMeshClipAxis,
    setMeshClipPos, setMeshShowArrows, setMeshSelection,
  } = props;

  const show3DOverlay = (effectiveViewMode === "3D" || effectiveViewMode === "Mesh") && !!props.worldExtent;

  return (
    <div className={s.viewportCanvas}>
      <div className={s.viewportOverlay}>
        <span>Step {effectiveStep.toLocaleString()}</span>
        <span>{fmtSI(effectiveTime, "s")}</span>
        {effectiveDmDt > 0 && (
          <span className={cn(effectiveDmDt < 1e-5 ? s.viewportOverlayMetricConverged : undefined)}>
            dm/dt {fmtExp(effectiveDmDt)}
          </span>
        )}
      </div>
      {show3DOverlay && (
        <DimensionOverlay
          worldExtent={props.worldExtent!}
          gridCells={props.gridCells}
          visible
        />
      )}
      {!isVectorQuantity ? (
        <div className={s.viewportEmptyState}>
          <EmptyState
            title={quantityDescriptor?.label ?? "Scalar quantity"}
            description={
              selectedScalarValue !== null
                ? `Latest: ${selectedScalarValue.toExponential(4)} ${quantityDescriptor?.unit ?? ""}`
                : "Scalar — see Scalars in sidebar."
            }
            tone="info"
            compact
          />
        </div>
      ) : preview && preview.spatial_kind === "grid" && preview.type === "2D" && preview.scalar_field.length > 0 ? (
        <PreviewScalarField2D
          data={preview.scalar_field}
          grid={preview.preview_grid}
          quantityLabel={quantityDescriptor?.label ?? preview.quantity}
          quantityUnit={preview.unit}
          component={preview.component}
          min={preview.min}
          max={preview.max}
        />
      ) : effectiveViewMode === "Mesh" && isFemBackend && femMeshData ? (
        <FemMeshView3D
          topologyKey={femTopologyKey ?? undefined}
          meshData={femMeshData}
          colorField="none"
          toolbarMode="hidden"
          renderMode={meshRenderMode}
          opacity={meshOpacity}
          clipEnabled={meshClipEnabled}
          clipAxis={meshClipAxis}
          clipPos={meshClipPos}
          showArrows={false}
          onRenderModeChange={setMeshRenderMode}
          onOpacityChange={setMeshOpacity}
          onClipEnabledChange={setMeshClipEnabled}
          onClipAxisChange={setMeshClipAxis}
          onClipPosChange={setMeshClipPos}
          onShowArrowsChange={setMeshShowArrows}
          onSelectionChange={setMeshSelection}
        />
      ) : effectiveViewMode === "Mesh" && !isFemBackend ? (
        <MagnetizationView3D
          grid={previewGrid}
          vectors={null}
          fieldLabel="Geometry"
          geometryMode
          activeMask={activeMask}
        />
      ) : effectiveViewMode === "3D" && isFemBackend && femMeshData ? (
        <FemMeshView3D
          topologyKey={femTopologyKey ?? undefined}
          meshData={femMeshData}
          fieldLabel={quantityDescriptor?.label ?? selectedQuantity}
          colorField={femColorField}
          showOrientationLegend={femMagnetization3DActive}
          toolbarMode="hidden"
          renderMode={meshRenderMode}
          opacity={meshOpacity}
          clipEnabled={meshClipEnabled}
          clipAxis={meshClipAxis}
          clipPos={meshClipPos}
          showArrows={femShouldShowArrows}
          onRenderModeChange={setMeshRenderMode}
          onOpacityChange={setMeshOpacity}
          onClipEnabledChange={setMeshClipEnabled}
          onClipAxisChange={setMeshClipAxis}
          onClipPosChange={setMeshClipPos}
          onShowArrowsChange={setMeshShowArrows}
          onSelectionChange={setMeshSelection}
        />
      ) : effectiveViewMode === "2D" && isFemBackend && femMeshData ? (
        <FemMeshSlice2D
          meshData={femMeshData}
          quantityLabel={quantityDescriptor?.label ?? selectedQuantity}
          quantityId={selectedQuantity}
          component={effectiveVectorComponent}
          plane={plane}
          sliceIndex={sliceIndex}
          sliceCount={maxSliceCount}
        />
      ) : effectiveViewMode === "3D" ? (
        <MagnetizationView3D
          grid={previewGrid}
          vectors={selectedVectors}
          fieldLabel={quantityDescriptor?.label ?? preview?.quantity ?? selectedQuantity}
        />
      ) : effectiveViewMode === "2D" ? (
        <MagnetizationSlice2D
          grid={previewGrid}
          vectors={selectedVectors}
          quantityLabel={quantityDescriptor?.label ?? preview?.quantity ?? selectedQuantity}
          quantityId={preview?.quantity ?? selectedQuantity}
          component={component}
          plane={plane}
          sliceIndex={sliceIndex}
        />
      ) : (
        <div className={s.viewportEmptyState}>
          <EmptyState
            title={emptyStateMessage.title}
            description={emptyStateMessage.description}
            tone="info"
          />
        </div>
      )}
    </div>
  );
}

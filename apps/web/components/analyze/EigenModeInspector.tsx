"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import EmptyState from "@/components/ui/EmptyState";
import FemMeshSlice2D from "@/components/preview/FemMeshSlice2DPlotly";
import FemMeshView3D from "@/components/preview/FemMeshView3D";
import { ViewportOverlayLayout } from "@/components/preview/ViewportOverlayLayout";

import type { EigenModeArtifact, FemMeshPayload } from "./eigenTypes";
import { fmtSI, fmtExp } from "@/lib/format";

type ModeFieldView = "real" | "imag" | "amplitude" | "phase";
type VectorComponent = "x" | "y" | "z" | "magnitude";
type SlicePlane = "xy" | "xz" | "yz";

interface EigenModeInspectorProps {
  mesh: FemMeshPayload | null;
  mode: EigenModeArtifact | null;
  loading?: boolean;
  /** When true the component fills its flex parent instead of using fixed rem heights. */
  compact?: boolean;
}

function modeFieldLabel(view: ModeFieldView, component: VectorComponent): string {
  if (view === "amplitude") return "Mode amplitude";
  if (view === "phase") return "Mode phase";
  const prefix = view === "real" ? "Re" : "Im";
  if (component === "magnitude") return `${prefix}(|m|)`;
  return `${prefix}(m_${component})`;
}

function flattenNodes(mesh: FemMeshPayload): number[] {
  return mesh.nodes.flatMap((node) => node);
}

function flattenBoundaryFaces(mesh: FemMeshPayload): number[] {
  return mesh.boundary_faces.flatMap((face) => face);
}

function zeroArray(length: number): number[] {
  return Array.from({ length }, () => 0);
}

function formatGHz(valueHz: number): string {
  return fmtSI(valueHz, "Hz");
}

function formatVec3(value: [number, number, number] | null): string {
  if (!value) return "Γ";
  return `(${value.map((v) => fmtExp(v)).join(", ")})`;
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border/30 bg-secondary/10 px-2.5 py-1.5 min-w-[80px]">
      <span className="text-[0.58rem] font-bold uppercase tracking-widest text-muted-foreground/70">{label}</span>
      <span className="font-mono text-[0.72rem] text-foreground/90 truncate">{value}</span>
    </div>
  );
}

export default function EigenModeInspector({
  mesh,
  mode,
  loading = false,
  compact = false,
}: EigenModeInspectorProps) {
  const [fieldView, setFieldView] = useState<ModeFieldView>("amplitude");
  const [vectorComponent, setVectorComponent] = useState<VectorComponent>("magnitude");
  const [slicePlane, setSlicePlane] = useState<SlicePlane>("xy");
  const [sliceIndex, setSliceIndex] = useState(12);

  // Derive index and frequency_hz from either legacy or V2 mode format
  const modeIndex = mode ? ("index" in mode ? mode.index : mode.raw_mode_index) : undefined;
  const modeFrequencyHz = mode ? ("frequency_hz" in mode ? mode.frequency_hz : mode.frequency_real_hz) : 0;

  // Sync view state with mode index during render (React 19 recommended pattern for resets)
  const [prevModeIndex, setPrevModeIndex] = useState(modeIndex);
  if (modeIndex !== prevModeIndex) {
    setPrevModeIndex(modeIndex);
    setFieldView("amplitude");
    setVectorComponent("magnitude");
  }

  const meshData = useMemo(() => {
    if (!mesh || !mode) return null;
    const nodeCount = mesh.nodes.length;
    const elements = mesh.elements.flatMap((element) => element);
    const zero = zeroArray(nodeCount);

    if (fieldView === "amplitude") {
      return {
        nodes: flattenNodes(mesh),
        elements,
        boundaryFaces: flattenBoundaryFaces(mesh),
        nNodes: nodeCount,
        nElements: mesh.elements.length,
        fieldData: { x: mode.amplitude, y: zero, z: zero },
      };
    }
    if (fieldView === "phase") {
      return {
        nodes: flattenNodes(mesh),
        elements,
        boundaryFaces: flattenBoundaryFaces(mesh),
        nNodes: nodeCount,
        nElements: mesh.elements.length,
        fieldData: { x: mode.phase, y: zero, z: zero },
      };
    }
    const source = fieldView === "real" ? mode.real : mode.imag;
    return {
      nodes: flattenNodes(mesh),
      elements,
      boundaryFaces: flattenBoundaryFaces(mesh),
      nNodes: nodeCount,
      nElements: mesh.elements.length,
      fieldData: {
        x: source.map((entry) => entry[0]),
        y: source.map((entry) => entry[1]),
        z: source.map((entry) => entry[2]),
      },
    };
  }, [fieldView, mesh, mode]);

  const maxAmplitude = useMemo(() => {
    if (!mode) return 0;
    return mode.amplitude.reduce((cur, v) => Math.max(cur, Math.abs(v)), 0);
  }, [mode]);

  const sliceComponent = fieldView === "amplitude" || fieldView === "phase" ? "x" : vectorComponent;
  const colorField = fieldView === "amplitude" || fieldView === "phase" ? "x" : vectorComponent;

  if (loading) {
    return (
      <EmptyState
        title="Loading mode field"
        description="Reading the eigenmode artifact from the active session."
        compact
      />
    );
  }

  if (!meshData || !mode) {
    return (
      <EmptyState
        title="Mode artifact unavailable"
        description="The spectrum is present but this mode was not exported as a field artifact."
        compact
      />
    );
  }

  const render3DControls = () => (
    <div className="flex flex-wrap items-center gap-2 rounded-full border border-border/40 bg-card/60 backdrop-blur-md px-3 py-1.5 shadow-lg pointer-events-auto">
      <div className="flex rounded-full border border-border/50 bg-background/50 p-1 overflow-hidden">
        {(["real", "imag", "amplitude", "phase"] as const).map((view) => (
          <button
            key={view}
            className={`px-3 py-1 rounded-full text-[0.65rem] font-bold uppercase tracking-wider transition-all ${
              fieldView === view 
                ? "bg-primary text-primary-foreground shadow-sm" 
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/20"
            }`}
            onClick={() => setFieldView(view)}
          >
            {view === "amplitude" ? "AMP" : view === "phase" ? "PHASE" : view.toUpperCase()}
          </button>
        ))}
      </div>
      {(fieldView === "real" || fieldView === "imag") && (
        <>
          <div className="w-[1px] h-4 bg-border/50 mx-1" />
          <div className="flex rounded-full border border-border/50 bg-background/50 p-1 overflow-hidden">
            {(["magnitude", "x", "y", "z"] as const).map((comp) => (
              <button
                key={comp}
                className={`px-3 py-1 rounded-full text-[0.65rem] font-bold uppercase tracking-wider transition-all ${
                  vectorComponent === comp 
                    ? "bg-primary/20 text-primary shadow-sm" 
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/20"
                }`}
                onClick={() => setVectorComponent(comp)}
              >
                {comp === "magnitude" ? "|M|" : comp.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  const containerClass = compact
    ? "flex flex-col h-full min-h-0 gap-3"
    : "flex flex-col space-y-4 h-[44rem]";

  const headerBgClass = compact
    ? "px-1"
    : "rounded-[16px] border border-border/30 bg-card/40 p-3.5 shadow-sm";

  return (
    <div className={containerClass}>
      <div className={`flex flex-wrap items-start justify-between gap-4 shrink-0 ${headerBgClass}`}>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Mode {modeIndex}</Badge>
            <span className="font-mono text-sm font-semibold text-foreground/90">{formatGHz(modeFrequencyHz)}</span>
            <Badge variant="outline">{mode.dominant_polarization}</Badge>
            <Badge variant="outline">{mode.normalization}</Badge>
            {!compact && <Badge variant="outline">{mode.damping_policy}</Badge>}
          </div>
          {!compact && (
            <p className="max-w-2xl text-[0.68rem] text-muted-foreground/80 leading-relaxed font-medium">
              Field view stays locked to explicit modal data. The 2D slice and 3D mesh share the same representation.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatChip label="omega" value={fmtExp(mode.angular_frequency_rad_per_s)} />
          <StatChip label="max amp" value={fmtExp(maxAmplitude)} />
          <StatChip label="k-vector" value={formatVec3(mode.k_vector)} />
          {!compact && <StatChip label="nodes" value={meshData.nNodes.toLocaleString()} />}
        </div>
      </div>

      <div className="flex gap-3 flex-1 min-h-0">
        <div className="relative flex-[1.4] h-full w-full overflow-hidden rounded-[14px] border border-border/30 bg-background shadow-lg">
          <FemMeshView3D
            meshData={meshData}
            colorField={colorField}
            fieldLabel={modeFieldLabel(fieldView, vectorComponent)}
            topologyKey={`mode:${modeIndex}:${meshData.nNodes}`}
            showOrientationLegend={false}
            toolbarMode="visible"
          />
          <ViewportOverlayLayout>
            <ViewportOverlayLayout.BottomCenter>
              {render3DControls()}
            </ViewportOverlayLayout.BottomCenter>
          </ViewportOverlayLayout>
        </div>

        <div className="relative flex-[1] h-full w-full overflow-hidden rounded-[14px] border border-border/30 shadow-lg p-0.5">
          <FemMeshSlice2D
            meshData={meshData}
            quantityLabel={modeFieldLabel(fieldView, vectorComponent)}
            quantityId={fieldView === "phase" ? "phase" : "mode"}
            component={sliceComponent}
            plane={slicePlane}
            clipAxis={slicePlane === "yz" ? "x" : slicePlane === "xz" ? "y" : "z"}
            clipPos={(sliceIndex / 24) * 100}
            onPlaneChange={setSlicePlane}
            onClipPosChange={(value) => setSliceIndex(Math.max(0, Math.min(24, Math.round((value / 100) * 24))))}
          />
        </div>
      </div>
    </div>
  );
}

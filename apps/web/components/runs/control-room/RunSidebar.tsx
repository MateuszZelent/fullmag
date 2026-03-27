"use client";

import { useCallback, useMemo } from "react";
import ModelTree, { buildFullmagModelTree } from "../../panels/ModelTree";
import MeshQualityHistogram from "../../panels/MeshQualityHistogram";
import SolverSettingsPanel from "../../panels/SolverSettingsPanel";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import ScalarPlot from "../../plots/ScalarPlot";
import type { FemMeshData, RenderMode } from "../../preview/FemMeshView3D";
import Sparkline from "../../ui/Sparkline";
import Button from "../../ui/Button";
import type { FemLiveMesh, PreviewState, ScalarRow } from "../../../lib/useSessionStream";
import {
  type FemDockTab,
  type ViewportMode,
  Section,
  findTreeNodeById,
  fmtExp,
  fmtExpOrDash,
  fmtPreviewEveryN,
  fmtSI,
  fmtSIOrDash,
  fmtStepValue,
  parseOptionalNumber,
  previewQuantityForTreeNode,
} from "./shared";
import SidebarSelectionInspector from "./SidebarSelectionInspector";
import s from "../RunControlRoom.module.css";

interface MaterialSummary {
  msat: number | null;
  aex: number | null;
  alpha: number | null;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  zeemanField: number[] | null;
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

interface FieldStats {
  meanX: number;
  meanY: number;
  meanZ: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface QuickPreviewTarget {
  id: string;
  shortLabel: string;
  available: boolean;
}

interface SessionFooterData {
  requestedBackend: string | null;
  scriptPath: string | null;
  artifactDir: string | null;
}

interface MesherSettings {
  order?: number;
  hmax?: number;
}

interface PreviewOption {
  value: string;
  label: string;
  disabled: boolean;
}

interface RunSidebarProps {
  isFemBackend: boolean;
  workspaceStatus: string;
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  effectiveHEff: number;
  effectiveHDemag: number;
  effectiveEEx: number;
  effectiveEDemag: number;
  effectiveEExt: number;
  effectiveETotal: number;
  hasSolverTelemetry: boolean;
  solverNotStartedMessage: string;
  solverSetupOpen: boolean;
  interactiveControlsEnabled: boolean;
  awaitingCommand: boolean;
  commandBusy: boolean;
  commandMessage: string | null;
  runUntilInput: string;
  setRunUntilInput: (value: string) => void;
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  solverSettings: SolverSettingsState;
  setSolverSettings: React.Dispatch<React.SetStateAction<SolverSettingsState>>;
  runtimeEngineLabel: string | null;
  sessionFooter: SessionFooterData;
  selectedSidebarNodeId: string | null;
  setSelectedSidebarNodeId: (value: string | null) => void;
  femDockTab: FemDockTab;
  previewControlsActive: boolean;
  requestedPreviewQuantity: string;
  requestedPreviewComponent: string;
  requestedPreviewEveryN: number;
  requestedPreviewAutoScale: boolean;
  previewBusy: boolean;
  preview: PreviewState | null;
  previewQuantityOptions: PreviewOption[];
  previewEveryNOptions: number[];
  quickPreviewTargets: QuickPreviewTarget[];
  requestPreviewQuantity: (quantity: string) => void;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  material: MaterialSummary | null;
  effectiveFemMesh: FemLiveMesh | null;
  femMesh: FemLiveMesh | null;
  femMeshData: FemMeshData | null;
  effectiveViewMode: ViewportMode;
  solverGrid: [number, number, number];
  totalCells: number | null;
  activeCells: number | null;
  inactiveCells: number | null;
  activeMaskPresent: boolean;
  scalarRows: ScalarRow[];
  fieldStats: FieldStats | null;
  meshQualitySummary: MeshQualitySummary | null;
  meshName: string | null;
  meshSource: string | null;
  meshExtent: [number, number, number] | null;
  meshBoundsMin: [number, number, number] | null;
  meshBoundsMax: [number, number, number] | null;
  meshFeOrder: number | null;
  meshHmax: number | null;
  mesherBackend: string | null;
  mesherSourceKind: string | null;
  mesherCurrentSettings: MesherSettings | null;
  meshGenerating: boolean;
  handleMeshGenerate: () => Promise<void>;
  openFemMeshWorkspace: (tab?: "mesh" | "quality") => void;
  setViewMode: (mode: ViewportMode) => void;
  setFemDockTab: React.Dispatch<React.SetStateAction<FemDockTab>>;
  setMeshRenderMode: React.Dispatch<React.SetStateAction<RenderMode>>;
  dmDtSpark: number[];
  dtSpark: number[];
  eTotalSpark: number[];
}

export default function RunSidebar(props: RunSidebarProps) {
  const {
    isFemBackend,
    workspaceStatus,
    effectiveStep,
    effectiveTime,
    effectiveDt,
    effectiveDmDt,
    effectiveHEff,
    effectiveHDemag,
    effectiveEEx,
    effectiveEDemag,
    effectiveEExt,
    effectiveETotal,
    hasSolverTelemetry,
    solverNotStartedMessage,
    solverSetupOpen,
    interactiveControlsEnabled,
    awaitingCommand,
    commandBusy,
    commandMessage,
    runUntilInput,
    setRunUntilInput,
    enqueueCommand,
    solverSettings,
    setSolverSettings,
    runtimeEngineLabel,
    sessionFooter,
    selectedSidebarNodeId,
    setSelectedSidebarNodeId,
    femDockTab,
    previewControlsActive,
    requestedPreviewQuantity,
    requestedPreviewComponent,
    requestedPreviewEveryN,
    requestedPreviewAutoScale,
    previewBusy,
    preview,
    previewQuantityOptions,
    previewEveryNOptions,
    quickPreviewTargets,
    requestPreviewQuantity,
    updatePreview,
    material,
    effectiveFemMesh,
    femMesh,
    femMeshData,
    effectiveViewMode,
    solverGrid,
    totalCells,
    activeCells,
    inactiveCells,
    activeMaskPresent,
    scalarRows,
    fieldStats,
    meshQualitySummary,
    meshName,
    meshSource,
    meshExtent,
    meshBoundsMin,
    meshBoundsMax,
    meshFeOrder,
    meshHmax,
    mesherBackend,
    mesherSourceKind,
    mesherCurrentSettings,
    meshGenerating,
    handleMeshGenerate,
    openFemMeshWorkspace,
    setViewMode,
    setFemDockTab,
    setMeshRenderMode,
    dmDtSpark,
    dtSpark,
    eTotalSpark,
  } = props;

  const modelTreeNodes = useMemo(
    () =>
      buildFullmagModelTree({
        backend: isFemBackend ? "FEM" : "FDM",
        geometryKind: mesherSourceKind ?? undefined,
        materialName:
          material?.msat != null ? `Msat=${(material.msat / 1e3).toFixed(0)} kA/m` : undefined,
        meshStatus: effectiveFemMesh ? "ready" : "pending",
        meshElements: effectiveFemMesh?.elements.length,
        solverStatus: hasSolverTelemetry ? "active" : "pending",
        demagMethod: "transfer-grid",
      }),
    [effectiveFemMesh, hasSolverTelemetry, isFemBackend, material?.msat, mesherSourceKind],
  );

  const fallbackSidebarNodeId = useMemo(() => {
    const isMeshWorkspaceView = isFemBackend && effectiveViewMode === "Mesh";
    if (isMeshWorkspaceView) {
      if (femDockTab === "quality") return "mesh-quality";
      if (femDockTab === "mesher") return "mesh-size";
      return "mesh";
    }
    if (previewControlsActive) return "res-fields";
    if (interactiveControlsEnabled) return "study-solver";
    if (material) return "materials";
    return "geometry";
  }, [effectiveViewMode, femDockTab, interactiveControlsEnabled, isFemBackend, material, previewControlsActive]);

  const activeSidebarNodeId = selectedSidebarNodeId ?? fallbackSidebarNodeId;
  const activeSidebarNode = useMemo(
    () => findTreeNodeById(modelTreeNodes, activeSidebarNodeId),
    [activeSidebarNodeId, modelTreeNodes],
  );

  const handleModelTreeClick = useCallback((id: string) => {
    setSelectedSidebarNodeId(id);
    switch (id) {
      case "geometry":
      case "geo-body":
      case "regions":
      case "reg-domain":
      case "reg-boundary":
        if (isFemBackend) openFemMeshWorkspace("mesh");
        else setViewMode("3D");
        return;
      case "mesh":
        if (isFemBackend) openFemMeshWorkspace("mesh");
        return;
      case "mesh-size":
      case "mesh-algorithm":
        if (isFemBackend) {
          setViewMode("Mesh");
          setFemDockTab("mesher");
          setMeshRenderMode((current) => (current === "surface" ? "surface+edges" : current));
        }
        return;
      case "mesh-quality":
        if (isFemBackend) openFemMeshWorkspace("quality");
        return;
      case "results":
      case "res-fields":
        if (isFemBackend && effectiveViewMode === "Mesh") {
          setViewMode("3D");
        }
        return;
      default: {
        const previewTarget = previewQuantityForTreeNode(id);
        if (
          previewTarget &&
          quickPreviewTargets.some((target) => target.id === previewTarget && target.available)
        ) {
          requestPreviewQuantity(previewTarget);
        }
      }
    }
  }, [
    effectiveViewMode,
    isFemBackend,
    openFemMeshWorkspace,
    quickPreviewTargets,
    requestPreviewQuantity,
    setFemDockTab,
    setMeshRenderMode,
    setSelectedSidebarNodeId,
    setViewMode,
  ]);

  return (
    <div className={s.sidebar}>
      <ModelTree nodes={modelTreeNodes} activeId={activeSidebarNodeId} onNodeClick={handleModelTreeClick} />

      <Section title="Selection" badge={activeSidebarNode?.label ?? "Workspace"}>
        <SidebarSelectionInspector
          nodeId={activeSidebarNodeId}
          runtimeEngineLabel={runtimeEngineLabel}
          sessionFooter={sessionFooter}
          workspaceStatus={workspaceStatus}
          runUntilInput={runUntilInput}
          setRunUntilInput={setRunUntilInput}
          commandBusy={commandBusy}
          awaitingCommand={awaitingCommand}
          enqueueCommand={enqueueCommand}
          solverSettings={solverSettings}
          setSolverSettings={setSolverSettings}
          mesherBackend={mesherBackend}
          mesherSourceKind={mesherSourceKind}
          meshSource={meshSource}
          meshFeOrder={meshFeOrder}
          meshHmax={meshHmax}
          openFemMeshWorkspace={openFemMeshWorkspace}
          isFemBackend={isFemBackend}
          setViewMode={setViewMode}
          setFemDockTab={setFemDockTab}
          meshGenerating={meshGenerating}
          handleMeshGenerate={handleMeshGenerate}
          requestedPreviewQuantity={requestedPreviewQuantity}
          requestedPreviewComponent={requestedPreviewComponent}
          quickPreviewTargets={quickPreviewTargets}
          previewBusy={previewBusy}
          requestPreviewQuantity={requestPreviewQuantity}
          previewControlsActive={previewControlsActive}
          updatePreview={updatePreview}
          previewQuantityOptions={previewQuantityOptions}
          requestedPreviewEveryN={requestedPreviewEveryN}
          previewEveryNOptions={previewEveryNOptions}
          requestedPreviewAutoScale={requestedPreviewAutoScale}
          material={material}
          meshName={meshName}
          meshExtent={meshExtent}
          meshBoundsMin={meshBoundsMin}
          meshBoundsMax={meshBoundsMax}
        />
      </Section>

      <Section title="Solver" badge={workspaceStatus}>
        <div className={s.fieldGrid2}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Current integration step number">Step</span>
            <span className={s.fieldValue}>{fmtStepValue(effectiveStep, hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Simulated physical time">Time</span>
            <span className={s.fieldValue}>{fmtSIOrDash(effectiveTime, "s", hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Current time-step size (adaptive solvers adjust this automatically)">Δt</span>
            <span className={s.fieldValue}>{fmtSIOrDash(effectiveDt, "s", hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Maximum magnetisation rate of change – approaches zero near equilibrium">max dm/dt</span>
            <span className={s.fieldValue} style={{ color: hasSolverTelemetry && effectiveDmDt > 0 && effectiveDmDt < 1e-5 ? "var(--status-running)" : undefined }}>
              {fmtExpOrDash(effectiveDmDt, hasSolverTelemetry)}
            </span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Maximum effective field magnitude – sum of all field contributions">max |H_eff|</span>
            <span className={s.fieldValue}>{fmtExpOrDash(effectiveHEff, hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Maximum demagnetising field magnitude – shape-dependent stray field">max |H_demag|</span>
            <span className={s.fieldValue}>{fmtExpOrDash(effectiveHDemag, hasSolverTelemetry)}</span>
          </div>
        </div>
        {!hasSolverTelemetry && (
          <div className={s.meshHintText} style={{ paddingTop: "0.5rem" }}>
            {solverNotStartedMessage}
          </div>
        )}
        {dmDtSpark.length > 1 && (
          <Sparkline data={dmDtSpark} width={140} height={20} color="var(--status-running)" label="dm/dt" />
        )}
        {dtSpark.length > 1 && (
          <Sparkline data={dtSpark} width={140} height={20} color="var(--ide-accent)" label="Δt" />
        )}
      </Section>

      <Section title="Solver Setup" defaultOpen={solverSetupOpen}>
        <SolverSettingsPanel
          settings={solverSettings}
          onChange={setSolverSettings}
          solverRunning={workspaceStatus === "running"}
          awaitingCommand={awaitingCommand}
        />
      </Section>

      {interactiveControlsEnabled && (
        <Section title="Interactive" badge={awaitingCommand ? "awaiting" : "running"}>
          <div className={s.interactiveBlock}>
            <label className={s.interactiveLabel}>
              Run until [s]
              <input
                className={s.interactiveInput}
                value={runUntilInput}
                onChange={(event) => setRunUntilInput(event.target.value)}
                disabled={commandBusy || !awaitingCommand}
              />
            </label>
            <Button
              size="sm"
              tone="accent"
              variant="solid"
              disabled={commandBusy || !awaitingCommand}
              onClick={() => enqueueCommand({ kind: "run", until_seconds: Number(runUntilInput) })}
            >
              Run
            </Button>
          </div>
          <div className={s.interactiveBlock}>
            <label className={s.interactiveLabel}>
              Relax steps
              <input
                className={s.interactiveInput}
                value={solverSettings.maxRelaxSteps}
                onChange={(event) =>
                  setSolverSettings((current) => ({ ...current, maxRelaxSteps: event.target.value }))
                }
                disabled={commandBusy || !awaitingCommand}
              />
            </label>
            <Button
              size="sm"
              tone="success"
              variant="solid"
              disabled={commandBusy || !awaitingCommand}
              onClick={() =>
                enqueueCommand({
                  kind: "relax",
                  max_steps: parseOptionalNumber(solverSettings.maxRelaxSteps),
                  torque_tolerance: parseOptionalNumber(solverSettings.torqueTolerance),
                  energy_tolerance: parseOptionalNumber(solverSettings.energyTolerance),
                })
              }
            >
              Relax
            </Button>
          </div>
          <div className={s.fieldGrid2} style={{ marginBottom: "0.6rem" }}>
            <label className={s.interactiveLabel}>
              Torque tol.
              <input
                className={s.interactiveInput}
                value={solverSettings.torqueTolerance}
                onChange={(event) =>
                  setSolverSettings((current) => ({ ...current, torqueTolerance: event.target.value }))
                }
                disabled={commandBusy || !awaitingCommand}
              />
            </label>
            <label className={s.interactiveLabel}>
              Energy tol.
              <input
                className={s.interactiveInput}
                value={solverSettings.energyTolerance}
                onChange={(event) =>
                  setSolverSettings((current) => ({ ...current, energyTolerance: event.target.value }))
                }
                placeholder="disabled"
                disabled={commandBusy || !awaitingCommand}
              />
            </label>
          </div>
          <div className={s.interactiveActions}>
            <Button size="sm" tone="warn" variant="outline" disabled={commandBusy} onClick={() => enqueueCommand({ kind: "close" })}>
              Close Workspace
            </Button>
          </div>
          {commandMessage && <div className={s.interactiveMessage}>{commandMessage}</div>}
        </Section>
      )}

      {preview && (
        <Section
          title="Preview"
          badge={
            preview.spatial_kind === "mesh"
              ? `${preview.data_points_count.toLocaleString()} nodes`
              : `${preview.applied_x_chosen_size}×${preview.applied_y_chosen_size}`
          }
        >
          {preview.spatial_kind === "mesh" ? (
            <div className={s.fieldGrid2}>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Quantity</span>
                <span className={s.fieldValue}>{preview.quantity}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Mode</span>
                <span className={s.fieldValue}>{preview.type}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Preview nodes</span>
                <span className={s.fieldValue}>{preview.data_points_count.toLocaleString()}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Preview faces</span>
                <span className={s.fieldValue}>{preview.fem_mesh?.boundary_faces.length.toLocaleString() ?? "0"}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Refresh</span>
                <span className={s.fieldValue}>{fmtPreviewEveryN(requestedPreviewEveryN)}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Original nodes</span>
                <span className={s.fieldValue}>{preview.original_node_count?.toLocaleString() ?? "—"}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Original faces</span>
                <span className={s.fieldValue}>{preview.original_face_count?.toLocaleString() ?? "—"}</span>
              </div>
            </div>
          ) : (
            <div className={s.fieldGrid2}>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Quantity</span>
                <span className={s.fieldValue}>{preview.quantity}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Mode</span>
                <span className={s.fieldValue}>{preview.type}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Requested XY</span>
                <span className={s.fieldValue}>{preview.x_chosen_size}×{preview.y_chosen_size}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Applied XY</span>
                <span className={s.fieldValue}>{preview.applied_x_chosen_size}×{preview.applied_y_chosen_size}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Points</span>
                <span className={s.fieldValue}>{preview.data_points_count.toLocaleString()}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Refresh</span>
                <span className={s.fieldValue}>{fmtPreviewEveryN(requestedPreviewEveryN)}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Layer stride</span>
                <span className={s.fieldValue}>{preview.applied_layer_stride}</span>
              </div>
            </div>
          )}
        </Section>
      )}

      {material && (
        <Section title="Material">
          <p className={s.meshHintText} style={{ margin: "0 0 0.4rem" }}>Magnetic material parameters used by the solver.</p>
          <div className={s.fieldGrid3}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel} title="Saturation magnetisation – maximum magnetic moment density">M_sat</span>
              <span className={s.fieldValue}>{material.msat != null ? fmtSI(material.msat, "A/m") : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel} title="Exchange stiffness constant – strength of nearest-neighbour coupling">A_ex</span>
              <span className={s.fieldValue}>{material.aex != null ? fmtSI(material.aex, "J/m") : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel} title="Gilbert damping parameter – controls energy dissipation rate">α</span>
              <span className={s.fieldValue}>{material.alpha?.toPrecision(3) ?? "—"}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
            {material.exchangeEnabled && <span className={s.termPill}>Exchange</span>}
            {material.demagEnabled && <span className={s.termPill}>Demag</span>}
            {material.zeemanField?.some((value) => value !== 0) && <span className={s.termPill}>Zeeman</span>}
          </div>
        </Section>
      )}

      <Section title="Energy" badge={fmtSIOrDash(effectiveETotal, "J", hasSolverTelemetry)}>
        <div className={s.fieldGrid2}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Exchange energy – penalty for non-uniform magnetisation">E_exchange</span>
            <span className={s.fieldValue}>{fmtSIOrDash(effectiveEEx, "J", hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Demagnetisation energy – self-interaction via stray fields">E_demag</span>
            <span className={s.fieldValue}>{fmtSIOrDash(effectiveEDemag, "J", hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="External (Zeeman) energy – coupling to applied field">E_ext</span>
            <span className={s.fieldValue}>{fmtSIOrDash(effectiveEExt, "J", hasSolverTelemetry)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel} title="Total micromagnetic energy – sum of all contributions">E_total</span>
            <span className={s.fieldValue} style={{ color: "hsl(210, 70%, 65%)" }}>
              {fmtSIOrDash(effectiveETotal, "J", hasSolverTelemetry)}
            </span>
          </div>
        </div>
        {eTotalSpark.length > 1 && (
          <Sparkline data={eTotalSpark} width={140} height={22} color="hsl(210, 70%, 55%)" label="E_tot" />
        )}
      </Section>

      {fieldStats && (
        <Section title="Derived Values" defaultOpen={false}>
          <div className={s.statsTable}>
            <span className={s.statsHeader} />
            <span className={s.statsHeader}>Mean</span>
            <span className={s.statsHeader}>Min</span>
            <span className={s.statsHeader}>Max</span>
            <span className={s.statsHeader} />

            <span className={s.statsLabel}>v.x</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.meanX)}</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.minX)}</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.maxX)}</span>
            <span />

            <span className={s.statsLabel}>v.y</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.meanY)}</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.minY)}</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.maxY)}</span>
            <span />

            <span className={s.statsLabel}>v.z</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.meanZ)}</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.minZ)}</span>
            <span className={s.statsValue}>{fmtExp(fieldStats.maxZ)}</span>
            <span />
          </div>
        </Section>
      )}

      {isFemBackend && femMeshData && effectiveViewMode === "Mesh" && (
        <Section title="Mesh Quality">
          <MeshQualityHistogram femMesh={femMeshData} />
        </Section>
      )}

      <Section title="Scalars" badge={`${scalarRows.length} pts`} defaultOpen={scalarRows.length > 0}>
        {scalarRows.length > 0 ? (
          <div style={{ height: 120 }}>
            <ScalarPlot rows={scalarRows} />
          </div>
        ) : (
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", padding: "0.3rem 0" }}>
            No scalar data yet
          </div>
        )}
      </Section>

      <Section title="Mesh" defaultOpen={false}>
        <div className={s.fieldGrid2}>
          {isFemBackend && femMesh ? (
            <>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Nodes</span>
                <span className={s.fieldValue}>{femMesh.nodes.length.toLocaleString()}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Elements</span>
                <span className={s.fieldValue}>{femMesh.elements.length.toLocaleString()}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Faces</span>
                <span className={s.fieldValue}>{femMesh.boundary_faces.length.toLocaleString()}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Type</span>
                <span className={s.fieldValue}>tet4</span>
              </div>
            </>
          ) : (
            <>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Grid</span>
                <span className={s.fieldValue}>{solverGrid[0]}×{solverGrid[1]}×{solverGrid[2]}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>Cells</span>
                <span className={s.fieldValue}>{totalCells?.toLocaleString() ?? "—"}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>{activeMaskPresent ? "Active cells" : "Magnetic cells"}</span>
                <span className={s.fieldValue}>{activeCells?.toLocaleString() ?? "—"}</span>
              </div>
              {activeMaskPresent && (
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Inactive cells</span>
                  <span className={s.fieldValue}>{inactiveCells?.toLocaleString() ?? "—"}</span>
                </div>
              )}
            </>
          )}
        </div>
      </Section>

      <div className={s.sidebarFooter}>
        {sessionFooter.scriptPath && (
          <div className={s.footerRow}>
            <span className={s.fieldLabel}>Script</span>
            <span className={s.footerValue} title={sessionFooter.scriptPath}>
              {sessionFooter.scriptPath.split("/").pop()}
            </span>
          </div>
        )}
        {sessionFooter.artifactDir && (
          <div className={s.footerRow}>
            <span className={s.fieldLabel}>Output</span>
            <span className={s.footerValue} title={sessionFooter.artifactDir}>
              {sessionFooter.artifactDir.split("/").pop()}
            </span>
          </div>
        )}
        <div className={s.footerRow}>
          <span className={s.fieldLabel}>Workspace</span>
          <span className={s.footerValue}>local</span>
        </div>
      </div>
    </div>
  );
}

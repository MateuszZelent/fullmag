"use client";

import type { Dispatch, SetStateAction } from "react";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import Button from "../../ui/Button";
import { type FemDockTab, type PreviewComponent, type ViewportMode, fmtPreviewEveryN, fmtPreviewMaxPoints, fmtSI, parseOptionalNumber } from "./shared";
import s from "../RunControlRoom.module.css";

interface MaterialSummary {
  msat: number | null;
  aex: number | null;
  alpha: number | null;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  zeemanField: number[] | null;
}

interface PreviewOption {
  value: string;
  label: string;
  disabled: boolean;
}

interface QuickPreviewTarget {
  id: string;
  shortLabel: string;
  available: boolean;
}

interface SessionFooterData {
  requestedBackend: string | null;
}

interface SidebarSelectionInspectorProps {
  nodeId: string;
  runtimeEngineLabel: string | null;
  sessionFooter: SessionFooterData;
  workspaceStatus: string;
  runUntilInput: string;
  setRunUntilInput: (value: string) => void;
  commandBusy: boolean;
  awaitingCommand: boolean;
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  solverSettings: SolverSettingsState;
  setSolverSettings: Dispatch<SetStateAction<SolverSettingsState>>;
  mesherBackend: string | null;
  mesherSourceKind: string | null;
  meshSource: string | null;
  meshFeOrder: number | null;
  meshHmax: number | null;
  openFemMeshWorkspace: (tab?: "mesh" | "quality") => void;
  isFemBackend: boolean;
  setViewMode: (mode: ViewportMode) => void;
  setFemDockTab: Dispatch<SetStateAction<FemDockTab>>;
  meshGenerating: boolean;
  handleMeshGenerate: () => Promise<void>;
  requestedPreviewQuantity: string;
  requestedPreviewComponent: string;
  quickPreviewTargets: QuickPreviewTarget[];
  previewBusy: boolean;
  requestPreviewQuantity: (quantity: string) => void;
  previewControlsActive: boolean;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  previewQuantityOptions: PreviewOption[];
  requestedPreviewEveryN: number;
  previewEveryNOptions: number[];
  requestedPreviewMaxPoints: number;
  previewMaxPointOptions: number[];
  requestedPreviewAutoScale: boolean;
  material: MaterialSummary | null;
  meshName: string | null;
  meshExtent: [number, number, number] | null;
  meshBoundsMin: [number, number, number] | null;
  meshBoundsMax: [number, number, number] | null;
}

export default function SidebarSelectionInspector(props: SidebarSelectionInspectorProps) {
  const {
    nodeId,
    runtimeEngineLabel,
    sessionFooter,
    workspaceStatus,
    runUntilInput,
    setRunUntilInput,
    commandBusy,
    awaitingCommand,
    enqueueCommand,
    solverSettings,
    setSolverSettings,
    mesherBackend,
    mesherSourceKind,
    meshSource,
    meshFeOrder,
    meshHmax,
    openFemMeshWorkspace,
    isFemBackend,
    setViewMode,
    setFemDockTab,
    meshGenerating,
    handleMeshGenerate,
    requestedPreviewQuantity,
    requestedPreviewComponent,
    quickPreviewTargets,
    previewBusy,
    requestPreviewQuantity,
    previewControlsActive,
    updatePreview,
    previewQuantityOptions,
    requestedPreviewEveryN,
    previewEveryNOptions,
    requestedPreviewMaxPoints,
    previewMaxPointOptions,
    requestedPreviewAutoScale,
    material,
    meshName,
    meshExtent,
    meshBoundsMin,
    meshBoundsMax,
  } = props;

  if (nodeId === "study" || nodeId.startsWith("study-")) {
    return (
      <>
        <div className={s.fieldGrid2}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Runtime</span>
            <span className={s.fieldValue}>{runtimeEngineLabel ?? sessionFooter.requestedBackend ?? "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Status</span>
            <span className={s.fieldValue}>{workspaceStatus}</span>
          </div>
        </div>
        <div className={s.interactiveBlock} style={{ marginTop: "0.65rem" }}>
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
        <div className={s.fieldGrid2} style={{ marginTop: "0.35rem" }}>
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
          <label className={s.interactiveLabel} style={{ gridColumn: "1 / -1" }}>
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
        <div className={s.interactiveActions} style={{ gap: "0.4rem", justifyContent: "space-between", marginTop: "0.7rem" }}>
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
          <Button
            size="sm"
            tone="warn"
            variant="outline"
            disabled={commandBusy}
            onClick={() => enqueueCommand({ kind: "close" })}
          >
            Close
          </Button>
        </div>
      </>
    );
  }

  if (nodeId === "mesh" || nodeId.startsWith("mesh-")) {
    return (
      <>
        <div className={s.fieldGrid2}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Backend</span>
            <span className={s.fieldValue}>{mesherBackend ?? "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Source</span>
            <span className={s.fieldValue}>{mesherSourceKind ?? meshSource ?? "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Order</span>
            <span className={s.fieldValue}>{meshFeOrder != null ? String(meshFeOrder) : "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>hmax</span>
            <span className={s.fieldValue}>{meshHmax != null ? fmtSI(meshHmax, "m") : "—"}</span>
          </div>
        </div>
        <div className={s.interactiveActions} style={{ gap: "0.4rem", flexWrap: "wrap", justifyContent: "flex-start", marginTop: "0.75rem" }}>
          <Button size="sm" variant="outline" onClick={() => openFemMeshWorkspace("mesh")} disabled={!isFemBackend}>
            Mesh
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setViewMode("Mesh");
              setFemDockTab("mesher");
            }}
            disabled={!isFemBackend}
          >
            Mesher
          </Button>
          <Button size="sm" variant="outline" onClick={() => openFemMeshWorkspace("quality")} disabled={!isFemBackend}>
            Quality
          </Button>
          <Button
            size="sm"
            tone="accent"
            variant="solid"
            onClick={() => void handleMeshGenerate()}
            disabled={!isFemBackend || meshGenerating || !awaitingCommand}
          >
            {meshGenerating ? "Meshing..." : "Generate"}
          </Button>
        </div>
      </>
    );
  }

  if (nodeId === "results" || nodeId.startsWith("res-") || nodeId === "physics" || nodeId.startsWith("phys-")) {
    return (
      <>
        <div className={s.fieldGrid2}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Quantity</span>
            <span className={s.fieldValue}>{requestedPreviewQuantity}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Component</span>
            <span className={s.fieldValue}>{requestedPreviewComponent}</span>
          </div>
        </div>
        <div className={s.interactiveActions} style={{ gap: "0.35rem", flexWrap: "wrap", justifyContent: "flex-start", marginTop: "0.7rem" }}>
          {quickPreviewTargets.map((target) => (
            <Button
              key={target.id}
              size="sm"
              variant={requestedPreviewQuantity === target.id ? "solid" : "outline"}
              tone={requestedPreviewQuantity === target.id ? "accent" : "default"}
              disabled={!target.available || previewBusy}
              onClick={() => requestPreviewQuantity(target.id)}
            >
              {target.shortLabel}
            </Button>
          ))}
        </div>
        {previewControlsActive && (
          <div className={s.fieldGrid2} style={{ marginTop: "0.7rem" }}>
            <label className={s.interactiveLabel}>
              Quantity
              <select
                className={s.interactiveInput}
                value={requestedPreviewQuantity}
                onChange={(event) => void updatePreview("/quantity", { quantity: event.target.value })}
                disabled={previewBusy}
              >
                {previewQuantityOptions.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.interactiveLabel}>
              Component
              <select
                className={s.interactiveInput}
                value={requestedPreviewComponent}
                onChange={(event) => void updatePreview("/component", { component: event.target.value as PreviewComponent })}
                disabled={previewBusy}
              >
                <option value="3D">3D</option>
                <option value="x">x</option>
                <option value="y">y</option>
                <option value="z">z</option>
              </select>
            </label>
            <label className={s.interactiveLabel}>
              Refresh
              <select
                className={s.interactiveInput}
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
            <label className={s.interactiveLabel}>
              Points
              <select
                className={s.interactiveInput}
                value={requestedPreviewMaxPoints}
                onChange={(event) => void updatePreview("/maxPoints", { maxPoints: Number(event.target.value) })}
                disabled={previewBusy}
              >
                {previewMaxPointOptions.map((value) => (
                  <option key={value} value={value}>
                    {fmtPreviewMaxPoints(value)}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.interactiveLabel} style={{ justifyContent: "end" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.45rem", minHeight: "36px" }}>
                <input
                  type="checkbox"
                  checked={requestedPreviewAutoScale}
                  onChange={(event) =>
                    void updatePreview("/autoScaleEnabled", { autoScaleEnabled: event.target.checked })
                  }
                  disabled={previewBusy}
                />
                Auto-fit
              </span>
            </label>
          </div>
        )}
      </>
    );
  }

  if (nodeId === "materials" || nodeId.startsWith("mat-")) {
    return material ? (
      <>
        <div className={s.fieldGrid3}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>M_sat</span>
            <span className={s.fieldValue}>{material.msat != null ? fmtSI(material.msat, "A/m") : "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>A_ex</span>
            <span className={s.fieldValue}>{material.aex != null ? fmtSI(material.aex, "J/m") : "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>α</span>
            <span className={s.fieldValue}>{material.alpha?.toPrecision(3) ?? "—"}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.55rem" }}>
          {material.exchangeEnabled && <span className={s.termPill}>Exchange</span>}
          {material.demagEnabled && <span className={s.termPill}>Demag</span>}
          {material.zeemanField?.some((value) => value !== 0) && <span className={s.termPill}>Zeeman</span>}
        </div>
      </>
    ) : (
      <div className={s.fieldValue}>Material metadata not available yet.</div>
    );
  }

  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Geometry</span>
          <span className={s.fieldValue}>{meshName ?? mesherSourceKind ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Source</span>
          <span className={s.fieldValue}>{meshSource ?? mesherSourceKind ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Extent</span>
          <span className={s.fieldValue}>
            {meshExtent
              ? `${fmtSI(meshExtent[0], "m")} · ${fmtSI(meshExtent[1], "m")} · ${fmtSI(meshExtent[2], "m")}`
              : "—"}
          </span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Bounds</span>
          <span className={s.fieldValue}>
            {meshBoundsMin && meshBoundsMax
              ? `${fmtSI(meshBoundsMin[0], "m")} → ${fmtSI(meshBoundsMax[0], "m")}`
              : "—"}
          </span>
        </div>
      </div>
      <div className={s.interactiveActions} style={{ gap: "0.4rem", justifyContent: "flex-start", marginTop: "0.75rem" }}>
        <Button size="sm" variant="outline" onClick={() => (isFemBackend ? openFemMeshWorkspace("mesh") : setViewMode("3D"))}>
          Open Geometry
        </Button>
        {isFemBackend && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setViewMode("Mesh");
              setFemDockTab("mesher");
            }}
          >
            Mesher
          </Button>
        )}
      </div>
    </>
  );
}

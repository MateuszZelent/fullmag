"use client";

import { useControlRoom } from "../runs/control-room/ControlRoomContext";
import Button from "../ui/Button";
import SolverSettingsPanel from "./SolverSettingsPanel";
import MeshQualityHistogram from "./MeshQualityHistogram";
import Sparkline from "../ui/Sparkline";
import ScalarPlot from "../plots/ScalarPlot";
import {
  type PreviewComponent,
  fmtExp,
  fmtExpOrDash,
  fmtPreviewEveryN,
  fmtPreviewMaxPoints,
  fmtSI,
  fmtSIOrDash,
  fmtStepValue,
  parseOptionalNumber,
} from "../runs/control-room/shared";
import s from "../runs/RunControlRoom.module.css";

/* ── Geometry Section ── */
function GeometryPanel() {
  const ctx = useControlRoom();
  return (
    <div className={s.fieldGrid2}>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Geometry</span>
        <span className={s.fieldValue}>{ctx.meshName ?? ctx.mesherSourceKind ?? "—"}</span>
      </div>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Source</span>
        <span className={s.fieldValue}>{ctx.meshSource ?? ctx.mesherSourceKind ?? "—"}</span>
      </div>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Extent</span>
        <span className={s.fieldValue}>
          {ctx.meshExtent
            ? `${fmtSI(ctx.meshExtent[0], "m")} · ${fmtSI(ctx.meshExtent[1], "m")} · ${fmtSI(ctx.meshExtent[2], "m")}`
            : "—"}
        </span>
      </div>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Bounds</span>
        <span className={s.fieldValue}>
          {ctx.meshBoundsMin && ctx.meshBoundsMax
            ? `${fmtSI(ctx.meshBoundsMin[0], "m")} → ${fmtSI(ctx.meshBoundsMax[0], "m")}`
            : "—"}
        </span>
      </div>
    </div>
  );
}

/* ── Material Section ── */
function MaterialPanel() {
  const ctx = useControlRoom();
  if (!ctx.material) return <div className={s.fieldValue}>Material metadata not available yet.</div>;
  return (
    <>
      <div className={s.fieldGrid3}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>M_sat</span>
          <span className={s.fieldValue}>{ctx.material.msat != null ? fmtSI(ctx.material.msat, "A/m") : "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>A_ex</span>
          <span className={s.fieldValue}>{ctx.material.aex != null ? fmtSI(ctx.material.aex, "J/m") : "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>α</span>
          <span className={s.fieldValue}>{ctx.material.alpha?.toPrecision(3) ?? "—"}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.55rem" }}>
        {ctx.material.exchangeEnabled && <span className={s.termPill}>Exchange</span>}
        {ctx.material.demagEnabled && <span className={s.termPill}>Demag</span>}
        {ctx.material.zeemanField?.some((v) => v !== 0) && <span className={s.termPill}>Zeeman</span>}
      </div>
    </>
  );
}

/* ── Mesh Section ── */
function MeshPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Backend</span>
          <span className={s.fieldValue}>{ctx.mesherBackend ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Source</span>
          <span className={s.fieldValue}>{ctx.mesherSourceKind ?? ctx.meshSource ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Order</span>
          <span className={s.fieldValue}>{ctx.meshFeOrder != null ? String(ctx.meshFeOrder) : "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>hmax</span>
          <span className={s.fieldValue}>{ctx.meshHmax != null ? fmtSI(ctx.meshHmax, "m") : "—"}</span>
        </div>
      </div>
      <div className={s.interactiveActions} style={{ gap: "0.4rem", flexWrap: "wrap", justifyContent: "flex-start", marginTop: "0.75rem" }}>
        <Button size="sm" variant="outline" onClick={() => ctx.openFemMeshWorkspace("mesh")} disabled={!ctx.isFemBackend}>
          Mesh
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { ctx.setViewMode("Mesh"); ctx.setFemDockTab("mesher"); }}
          disabled={!ctx.isFemBackend}
        >
          Mesher
        </Button>
        <Button size="sm" variant="outline" onClick={() => ctx.openFemMeshWorkspace("quality")} disabled={!ctx.isFemBackend}>
          Quality
        </Button>
        <Button
          size="sm" tone="accent" variant="solid"
          onClick={() => void ctx.handleMeshGenerate()}
          disabled={!ctx.isFemBackend || ctx.meshGenerating || !ctx.awaitingCommand}
        >
          {ctx.meshGenerating ? "Meshing..." : "Generate"}
        </Button>
      </div>
    </>
  );
}

/* ── Study / Solver Section ── */
function StudyPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Runtime</span>
          <span className={s.fieldValue}>{ctx.runtimeEngineLabel ?? ctx.sessionFooter.requestedBackend ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Status</span>
          <span className={s.fieldValue}>{ctx.workspaceStatus}</span>
        </div>
      </div>
      <div className={s.interactiveBlock} style={{ marginTop: "0.65rem" }}>
        <label className={s.interactiveLabel}>
          Run until [s]
          <input
            className={s.interactiveInput}
            value={ctx.runUntilInput}
            onChange={(e) => ctx.setRunUntilInput(e.target.value)}
            disabled={ctx.commandBusy || !ctx.awaitingCommand}
          />
        </label>
        <Button size="sm" tone="accent" variant="solid"
          disabled={ctx.commandBusy || !ctx.awaitingCommand}
          onClick={() => ctx.enqueueCommand({ kind: "run", until_seconds: Number(ctx.runUntilInput) })}
        >
          Run
        </Button>
      </div>
      <div className={s.fieldGrid2} style={{ marginTop: "0.35rem" }}>
        <label className={s.interactiveLabel}>
          Relax steps
          <input className={s.interactiveInput} value={ctx.solverSettings.maxRelaxSteps}
            onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, maxRelaxSteps: e.target.value }))}
            disabled={ctx.commandBusy || !ctx.awaitingCommand} />
        </label>
        <label className={s.interactiveLabel}>
          Torque tol.
          <input className={s.interactiveInput} value={ctx.solverSettings.torqueTolerance}
            onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, torqueTolerance: e.target.value }))}
            disabled={ctx.commandBusy || !ctx.awaitingCommand} />
        </label>
        <label className={s.interactiveLabel} style={{ gridColumn: "1 / -1" }}>
          Energy tol.
          <input className={s.interactiveInput} value={ctx.solverSettings.energyTolerance}
            onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, energyTolerance: e.target.value }))}
            placeholder="disabled" disabled={ctx.commandBusy || !ctx.awaitingCommand} />
        </label>
      </div>
      <div className={s.interactiveActions} style={{ gap: "0.4rem", justifyContent: "space-between", marginTop: "0.7rem" }}>
        <Button size="sm" tone="success" variant="solid"
          disabled={ctx.commandBusy || !ctx.awaitingCommand}
          onClick={() => ctx.enqueueCommand({
            kind: "relax",
            max_steps: parseOptionalNumber(ctx.solverSettings.maxRelaxSteps),
            torque_tolerance: parseOptionalNumber(ctx.solverSettings.torqueTolerance),
            energy_tolerance: parseOptionalNumber(ctx.solverSettings.energyTolerance),
          })}
        >
          Relax
        </Button>
        <Button size="sm" tone="warn" variant="outline"
          disabled={ctx.commandBusy}
          onClick={() => ctx.enqueueCommand({ kind: "close" })}
        >
          Close
        </Button>
      </div>
    </>
  );
}

/* ── Results / Preview Section ── */
function ResultsPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Quantity</span>
          <span className={s.fieldValue}>{ctx.requestedPreviewQuantity}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Component</span>
          <span className={s.fieldValue}>{ctx.requestedPreviewComponent}</span>
        </div>
      </div>
      <div className={s.interactiveActions} style={{ gap: "0.35rem", flexWrap: "wrap", justifyContent: "flex-start", marginTop: "0.7rem" }}>
        {ctx.quickPreviewTargets.map((target) => (
          <Button key={target.id} size="sm"
            variant={ctx.requestedPreviewQuantity === target.id ? "solid" : "outline"}
            tone={ctx.requestedPreviewQuantity === target.id ? "accent" : "default"}
            disabled={!target.available || ctx.previewBusy}
            onClick={() => ctx.requestPreviewQuantity(target.id)}
          >
            {target.shortLabel}
          </Button>
        ))}
      </div>
      {ctx.previewControlsActive && (
        <div className={s.fieldGrid2} style={{ marginTop: "0.7rem" }}>
          <label className={s.interactiveLabel}>
            Quantity
            <select className={s.interactiveInput} value={ctx.requestedPreviewQuantity}
              onChange={(e) => void ctx.updatePreview("/quantity", { quantity: e.target.value })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewQuantityOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
          </label>
          <label className={s.interactiveLabel}>
            Component
            <select className={s.interactiveInput} value={ctx.requestedPreviewComponent}
              onChange={(e) => void ctx.updatePreview("/component", { component: e.target.value as PreviewComponent })}
              disabled={ctx.previewBusy}
            >
              <option value="3D">3D</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          </label>
          <label className={s.interactiveLabel}>
            Refresh
            <select className={s.interactiveInput} value={ctx.requestedPreviewEveryN}
              onChange={(e) => void ctx.updatePreview("/everyN", { everyN: Number(e.target.value) })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewEveryNOptions.map((v) => <option key={v} value={v}>{fmtPreviewEveryN(v)}</option>)}
            </select>
          </label>
          <label className={s.interactiveLabel}>
            Points
            <select className={s.interactiveInput} value={ctx.requestedPreviewMaxPoints}
              onChange={(e) => void ctx.updatePreview("/maxPoints", { maxPoints: Number(e.target.value) })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewMaxPointOptions.map((v) => <option key={v} value={v}>{fmtPreviewMaxPoints(v)}</option>)}
            </select>
          </label>
          <label className={s.interactiveLabel} style={{ justifyContent: "end" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.45rem", minHeight: "36px" }}>
              <input type="checkbox" checked={ctx.requestedPreviewAutoScale}
                onChange={(e) => void ctx.updatePreview("/autoScaleEnabled", { autoScaleEnabled: e.target.checked })}
                disabled={ctx.previewBusy} />
              Auto-fit
            </span>
          </label>
        </div>
      )}
    </>
  );
}

/* ── Solver Telemetry Section ── */
function SolverTelemetryPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel} title="Current integration step number">Step</span>
          <span className={s.fieldValue}>{fmtStepValue(ctx.effectiveStep, ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel} title="Simulated physical time">Time</span>
          <span className={s.fieldValue}>{fmtSIOrDash(ctx.effectiveTime, "s", ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel} title="Current time-step size">Δt</span>
          <span className={s.fieldValue}>{fmtSIOrDash(ctx.effectiveDt, "s", ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel} title="Maximum magnetisation rate of change">max dm/dt</span>
          <span className={s.fieldValue} style={{
            color: ctx.hasSolverTelemetry && ctx.effectiveDmDt > 0 && ctx.effectiveDmDt < 1e-5
              ? "var(--status-running)" : undefined
          }}>
            {fmtExpOrDash(ctx.effectiveDmDt, ctx.hasSolverTelemetry)}
          </span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel} title="Maximum effective field magnitude">max |H_eff|</span>
          <span className={s.fieldValue}>{fmtExpOrDash(ctx.effectiveHEff, ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel} title="Maximum demagnetising field magnitude">max |H_demag|</span>
          <span className={s.fieldValue}>{fmtExpOrDash(ctx.effectiveHDemag, ctx.hasSolverTelemetry)}</span>
        </div>
      </div>
      {!ctx.hasSolverTelemetry && (
        <div className={s.meshHintText} style={{ paddingTop: "0.5rem" }}>{ctx.solverNotStartedMessage}</div>
      )}
      {ctx.dmDtSpark.length > 1 && (
        <Sparkline data={ctx.dmDtSpark} width={140} height={20} color="var(--status-running)" label="dm/dt" />
      )}
      {ctx.dtSpark.length > 1 && (
        <Sparkline data={ctx.dtSpark} width={140} height={20} color="var(--ide-accent)" label="Δt" />
      )}
    </>
  );
}

/* ── Energy Section ── */
function EnergyPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>E_exchange</span>
          <span className={s.fieldValue}>{fmtExpOrDash(ctx.effectiveEEx, ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>E_demag</span>
          <span className={s.fieldValue}>{fmtExpOrDash(ctx.effectiveEDemag, ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>E_ext</span>
          <span className={s.fieldValue}>{fmtExpOrDash(ctx.effectiveEExt, ctx.hasSolverTelemetry)}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>E_total</span>
          <span className={s.fieldValue}>{fmtExpOrDash(ctx.effectiveETotal, ctx.hasSolverTelemetry)}</span>
        </div>
      </div>
      {ctx.eTotalSpark.length > 1 && (
        <Sparkline data={ctx.eTotalSpark} width={140} height={20} color="var(--status-warn)" label="E_total" />
      )}
    </>
  );
}

/* ── Main SettingsPanel ── */
interface SettingsPanelProps {
  nodeId: string;
  nodeLabel: string | null;
}

export default function SettingsPanel({ nodeId, nodeLabel }: SettingsPanelProps) {
  const ctx = useControlRoom();

  const renderNodeContent = () => {
    if (nodeId === "study" || nodeId.startsWith("study-")) return <StudyPanel />;
    if (nodeId === "mesh" || nodeId.startsWith("mesh-")) return <MeshPanel />;
    if (nodeId === "results" || nodeId.startsWith("res-") || nodeId === "physics" || nodeId.startsWith("phys-")) return <ResultsPanel />;
    if (nodeId === "materials" || nodeId.startsWith("mat-")) return <MaterialPanel />;
    return <GeometryPanel />;
  };

  return (
    <div className={s.sidebar} style={{ minWidth: 240 }}>
      {/* Settings header */}
      <div className={s.sectionHeader} style={{ cursor: "default" }}>
        <span className={s.sectionTitle}>Settings</span>
        <span className={s.sectionBadge}>{nodeLabel ?? "Workspace"}</span>
      </div>
      <div className={s.sectionBody}>
        {renderNodeContent()}
      </div>

      {/* Solver telemetry — always visible when not in mesh workspace */}
      {ctx.effectiveViewMode !== "Mesh" && (
        <>
          <div className={s.sectionHeader} style={{ cursor: "default" }}>
            <span className={s.sectionTitle}>Solver</span>
            <span className={s.sectionBadge}>{ctx.workspaceStatus}</span>
          </div>
          <div className={s.sectionBody}>
            <SolverTelemetryPanel />
          </div>

          <div className={s.sectionHeader} style={{ cursor: "default" }}>
            <span className={s.sectionTitle}>Energy</span>
          </div>
          <div className={s.sectionBody}>
            <EnergyPanel />
          </div>
        </>
      )}

      {/* Footer */}
      <div className={s.sidebarFooter}>
        <div className={s.footerRow}>
          <span className={s.fieldLabel}>Backend</span>
          <span className={s.footerValue}>{ctx.sessionFooter.requestedBackend ?? "—"}</span>
        </div>
        {ctx.sessionFooter.scriptPath && (
          <div className={s.footerRow}>
            <span className={s.fieldLabel}>Script</span>
            <span className={s.footerValue} title={ctx.sessionFooter.scriptPath}>
              {ctx.sessionFooter.scriptPath.split("/").pop()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

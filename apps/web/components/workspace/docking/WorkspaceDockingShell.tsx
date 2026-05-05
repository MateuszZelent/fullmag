"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Layout as FlexLayout,
  Model,
  TabNode,
  type Action,
} from "flexlayout-react";

import { useCommand, useModel, useTransport } from "@/components/runs/control-room/context-hooks";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import RunSidebar from "@/components/runs/control-room/RunSidebar";
import BottomUtilityDock from "@/components/workspace/shell/BottomUtilityDock";
import ChartsDock from "@/components/workspace/docks/ChartsDock";
import EmptyState from "@/components/ui/EmptyState";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceRightToolbox } from "@/components/workspace/modes/WorkspaceModeInspectors";
import {
  useWorkspaceStore,
} from "@/lib/workspace/workspace-store";

import DockCenterTabs from "./DockCenterTabs";
import { resolveDockResponsivePreset } from "./dockLayoutDefaults";
import { useDockLayoutRuntime } from "./useDockLayoutRuntime";

function parsePositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveFiniteMin(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.min(...values);
}

function resolveFiniteMax(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

/**
 * RC-2 fix: Use a single stable component identity for the right inspector.
 * Previously three identical wrappers (AnalyzeRightInspector / BuildRightInspector /
 * StudyRightInspector) were conditionally switched based on effectiveViewMode,
 * causing React to treat them as different component types and unmount+remount
 * the entire inspector tree on every tab switch. Since all three rendered the
 * same <WorkspaceRightToolbox />, we now render it directly with a stable identity.
 */
const RightInspectorPanel = memo(function RightInspectorPanel() {
  return <WorkspaceRightToolbox />;
});

function BottomDockPanel() {
  const cmd = useCommand();
  const modelState = useModel();
  const tp = useTransport();

  /* Local elapsed / throughput – updated every second via setInterval so that
   * the status bar stays live without polluting transportValue with Date.now(). */
  const [_now, _setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tp.sessionStartedAt || tp.sessionFinishedAt > tp.sessionStartedAt) return;
    const id = setInterval(() => _setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tp.sessionStartedAt, tp.sessionFinishedAt]);
  const elapsed = tp.sessionStartedAt
    ? (tp.sessionFinishedAt > tp.sessionStartedAt
        ? tp.sessionFinishedAt - tp.sessionStartedAt
        : _now - tp.sessionStartedAt)
    : 0;
  const stepsPerSec = elapsed > 0 ? (tp.effectiveStep / elapsed) * 1000 : 0;

  const solverIntegrator =
    modelState.solverPlan?.integrator ?? modelState.solverSettings.integrator;
  const solverAdaptiveDtMin = modelState.solverPlan?.adaptive?.dtMin;
  const solverAdaptiveDtMax = modelState.solverPlan?.adaptive?.dtMax;
  const fixedDtFromPlan = modelState.solverPlan?.fixedTimestep;
  const fixedDtFromSettings = parsePositiveNumber(modelState.solverSettings.fixedTimestep);
  const fixedDt = useMemo(() => {
    if (typeof fixedDtFromPlan === "number" && Number.isFinite(fixedDtFromPlan) && fixedDtFromPlan > 0) {
      return fixedDtFromPlan;
    }
    return fixedDtFromSettings;
  }, [fixedDtFromPlan, fixedDtFromSettings]);
  const solverDtSamples = useMemo(
    () =>
      tp.scalarRows
        .slice(-128)
        .map((row) => row.solver_dt)
        .filter(isPositiveFinite),
    [tp.scalarRows],
  );
  const solverMinDt = useMemo(() => {
    if (!tp.hasSolverTelemetry) return null;
    return isPositiveFinite(solverAdaptiveDtMin)
      ? solverAdaptiveDtMin
      : resolveFiniteMin(solverDtSamples);
  }, [solverAdaptiveDtMin, tp.hasSolverTelemetry, solverDtSamples]);
  const solverMaxDt = useMemo(() => {
    if (!tp.hasSolverTelemetry) return null;
    return isPositiveFinite(solverAdaptiveDtMax)
      ? solverAdaptiveDtMax
      : resolveFiniteMax(solverDtSamples);
  }, [solverAdaptiveDtMax, tp.hasSolverTelemetry, solverDtSamples]);

  const solverMaxError = useMemo(() => {
    const planAtol = modelState.solverPlan?.adaptive?.atol;
    if (typeof planAtol === "number" && Number.isFinite(planAtol)) return planAtol;
    const parsed = Number.parseFloat(modelState.solverSettings.maxError);
    return Number.isFinite(parsed) ? parsed : null;
  }, [modelState.solverPlan?.adaptive?.atol, modelState.solverSettings.maxError]);

  return (
    <div className="flex h-full divide-x divide-border/20 overflow-hidden">
      <div className="flex-1 min-w-0 overflow-hidden">
        <BottomUtilityDock
          activity={cmd.activity}
          workspaceStatus={cmd.workspaceStatus}
          effectiveStep={tp.effectiveStep}
          effectiveTime={tp.effectiveTime}
          effectiveDt={tp.effectiveDt}
          effectiveDmDt={tp.effectiveDmDt}
          effectiveTorqueT={tp.effectiveTorqueT}
          effectiveHEff={tp.effectiveHEff}
          stepsPerSec={stepsPerSec}
          elapsed={elapsed}
          hasSolverTelemetry={tp.hasSolverTelemetry}
          eTotal={tp.effectiveETotal}
          activityDetail={cmd.activity?.detail ?? null}
          solverIntegrator={solverIntegrator}
          solverMaxError={solverMaxError}
          solverMinDt={solverMinDt}
          solverMaxDt={solverMaxDt}
          solverFixedDt={fixedDt}
        />
      </div>
      <div className="w-52 shrink-0 overflow-hidden">
        <ChartsDock />
      </div>
    </div>
  );
}

export default function WorkspaceDockingShell() {
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const stageLayouts = useWorkspaceStore((state) => state.dockLayoutByStage[state.currentStage]);
  const setDockLayout = useWorkspaceStore((state) => state.setDockLayout);
  const setDockLayoutToDefaultTemplate = useWorkspaceStore(
    (state) => state.setDockLayoutToDefaultTemplate,
  );
  const clearDockingLayoutStorage = useWorkspaceStore((state) => state.clearDockingLayoutStorage);

  const [viewportWidth, setViewportWidth] = useState(1920);
  const responsivePreset = resolveDockResponsivePreset(viewportWidth);
  const stageLayout = stageLayouts[responsivePreset];

  const runtime = useDockLayoutRuntime({
    stage: currentStage,
    preset: responsivePreset,
    layoutEnvelope: stageLayout,
    setDockLayout,
    setDockLayoutToDefaultTemplate,
    clearDockingLayoutStorage,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const onModelChange = useCallback(
    (nextModel: Model, action: Action) => {
      void action;
      runtime.onModelChange(nextModel);
    },
    [runtime],
  );

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent();
      if (component === "dock-left") {
        return (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <RunSidebar />
          </div>
        );
      }
      if (component === "dock-center") {
        const centerContent = (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            {FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableDockCenterTabs ? (
              <DockCenterTabs />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                Dock center tabs disabled:
                <code className="mx-1">workspace.enableDockCenterTabs = false</code>.
              </div>
            )}
          </div>
        );

        if (!FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableDockingTooltipProviders) {
          return centerContent;
        }

        return (
          <TooltipProvider delayDuration={250}>
            {centerContent}
          </TooltipProvider>
        );
      }
      if (component === "dock-right") {
        return (
          <div className="h-full min-h-0 min-w-0 overflow-hidden border-l border-border/20 bg-background/45">
            <RightInspectorPanel />
          </div>
        );
      }
      if (component === "dock-bottom") {
        return <BottomDockPanel />;
      }

      return (
        <div className="flex h-full items-center justify-center p-4">
          <EmptyState
            title="Unknown dock panel"
            description={`No factory handler for component: ${component ?? "undefined"}`}
            tone="warning"
            compact
          />
        </div>
      );
    },
    [],
  );

  const classNameMapper = useCallback((className: string) => `workspace-docking ${className}`, []);

  const currentPresetStats = runtime.metrics;
  const hasRecovery = currentPresetStats.wasRecovered;
  const recoveryLabel = hasRecovery
    ? `naprawiony: ${currentPresetStats.lastRepairReason ?? "układ zregenerowany"}`
    : "brak naprawy";
  const lastRepairLabel = currentPresetStats.lastRepairAtUnixMs
    ? new Date(currentPresetStats.lastRepairAtUnixMs).toLocaleTimeString("pl-PL")
    : "brak";

  if (!FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceDockingShell) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        WorkspaceDockingShell disabled by diagnostic flag:
        <code className="mx-1">workspace.enableWorkspaceDockingShell = false</code>.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showLayoutDebugHud && (
      <div className="absolute right-2 top-2 z-10 flex max-w-[72vw] flex-wrap items-center gap-2 rounded-md border border-border/40 bg-background/95 px-2 py-1 text-xs shadow">
        <span className="rounded-sm bg-muted/70 px-2 py-0.5">preset: {currentPresetStats.preset}</span>
        <span className="rounded-sm bg-muted/70 px-2 py-0.5">template: {currentPresetStats.templateId}</span>
        <span className="rounded-sm bg-muted/70 px-2 py-0.5">v{currentPresetStats.dockingLayoutSchemaVersion}</span>
        <span
          className={`rounded-sm px-2 py-0.5 ${hasRecovery ? "bg-amber-500/20 text-amber-200" : "bg-emerald-500/20 text-emerald-200"}`}
        >
          {recoveryLabel}
        </span>
        <span className="rounded-sm bg-muted/70 px-2 py-0.5">naprawa: {lastRepairLabel}</span>
        <button
          type="button"
          className="rounded-md border border-border/50 bg-background px-2 py-0.5 hover:bg-muted"
          onClick={runtime.restoreCurrentPresetTemplate}
        >
          Przywróć domyślny układ
        </button>
        <button
          type="button"
          className="rounded-md border border-border/50 bg-background px-2 py-0.5 hover:bg-muted"
          onClick={runtime.clearStorageAndReset}
        >
          Wyczyść zapis i reset
        </button>
      </div>
      )}
      {FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableDockingTooltipProviders ? (
        <TooltipProvider delayDuration={250}>
          <FlexLayout
            model={runtime.model}
            factory={factory}
            classNameMapper={classNameMapper}
            onModelChange={onModelChange}
          />
        </TooltipProvider>
      ) : (
        <FlexLayout
          model={runtime.model}
          factory={factory}
          classNameMapper={classNameMapper}
          onModelChange={onModelChange}
        />
      )}
    </div>
  );
}

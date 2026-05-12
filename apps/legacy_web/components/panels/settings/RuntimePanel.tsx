"use client";

import { useMemo } from "react";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { getFemElementCount, getFemNodeCount } from "@/lib/session/femTopology";

import {
  selectRequestedRuntimeSelection,
  selectSolverPlan,
  useDocumentStore,
} from "@/features/document/store/useDocumentStore";
import {
  selectFemMesh,
  useSessionRuntimeStore,
} from "@/features/session-runtime/store/useSessionRuntimeStore";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
import { useCommand, useViewport } from "../../runs/control-room/context-hooks";
import { extractFemCpuThreadSummary } from "../../runs/control-room/helpers";
import SolverSelector from "../../solver/SolverSelector";
import TextField from "../../ui/TextField";
import { humanizeToken } from "./helpers";
import { InfoRow, SidebarSection, StatusBadge } from "./primitives";

function parseOptionalPositiveInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  const resolved = Math.trunc(value);
  return resolved >= 1 ? resolved : null;
}

function formatCpuThreads(value: number | null): string {
  return value != null ? `${value}` : "auto";
}

export default function RuntimePanel({ nodeId }: { nodeId?: string }) {
  void nodeId;
  const cmd = useCommand();
  const sceneAuthoring = useSceneAuthoringActions();
  const solverPlan = useDocumentStore(selectSolverPlan);
  const requestedRuntimeSelection = useDocumentStore(selectRequestedRuntimeSelection);
  const setRequestedRuntimeSelection = useDocumentStore(
    (s) => s.setRequestedRuntimeSelection,
  );
  const femMesh = useSessionRuntimeStore(selectFemMesh);
  const viewport = useViewport();

  const femCpuThreadSummary = useMemo(
    () => extractFemCpuThreadSummary(cmd.engineLog),
    [cmd.engineLog],
  );
  const femDiscretization = resolveFemDiscretization(cmd.domainCapabilities, false);
  const femNodeCount = femMesh ? getFemNodeCount(femMesh) : 0;
  const femElementCount = femMesh ? getFemElementCount(femMesh) : 0;

  const workloadLabel = femDiscretization && femMesh
    ? `${femNodeCount.toLocaleString('en-US')} nodes · ${femElementCount.toLocaleString('en-US')} tets`
    : viewport.totalCells && viewport.totalCells > 0
      ? `${viewport.totalCells.toLocaleString('en-US')} cells`
      : "—";

  return (
    <>
      <SidebarSection title="Runtime & Backend" icon="⚙" defaultOpen={true}>
        <SolverSelector />
      </SidebarSection>

      <SidebarSection title="CPU Threads" icon="🧵" defaultOpen={true}>
        <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          CPU thread request is applied on the next compute start. Mid-run edits do not mutate the current active runtime.
        </div>
        <div className="mt-3 grid gap-3">
          <TextField
              label="Requested CPU threads"
              value={
              requestedRuntimeSelection.requested_cpu_threads != null
                ? String(requestedRuntimeSelection.requested_cpu_threads)
                : ""
            }
            onchange={(event) => {
              const nextValue = parseOptionalPositiveInteger(event.target.value);
              const nextSelection = setRequestedRuntimeSelection((current) => ({
                ...current,
                requested_cpu_threads: nextValue,
              }));
              void sceneAuthoring.patchStudyRuntime(nextSelection).catch((error) => {
                console.error("failed to patch authoring study runtime", error);
              });
            }}
            placeholder="auto"
            mono
          />
          <div className="grid gap-1">
            <InfoRow
              label="Current request"
              value={formatCpuThreads(requestedRuntimeSelection.requested_cpu_threads)}
            />
            <InfoRow
              label="Apply timing"
              value={cmd.workspaceStatus === "running" ? "next compute only" : "next runtime resolution"}
            />
            <InfoRow label="Can change mid-run" value="no — restart or start new compute" />
          </div>
        </div>
      </SidebarSection>

      <SidebarSection title="Resolved Runtime" icon="🧠" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow label="State" value={humanizeToken(cmd.workspaceStatus)} />
          <InfoRow label="Engine" value={cmd.runtimeEngineLabel ?? cmd.sessionFooter.requestedBackend ?? "—"} />
          <InfoRow
            label="Backend"
            value={humanizeToken(solverPlan?.resolvedBackend ?? solverPlan?.backendKind ?? cmd.sessionFooter.requestedBackend)}
          />
          <InfoRow label="Mode" value={humanizeToken(solverPlan?.executionMode ?? cmd.session?.execution_mode)} />
          <InfoRow label="Precision" value={humanizeToken(solverPlan?.precision ?? cmd.session?.precision)} />
          <InfoRow
            label="Requested CPU threads"
            value={formatCpuThreads(requestedRuntimeSelection.requested_cpu_threads)}
          />
          <InfoRow label="Resolved Rayon threads" value={formatCpuThreads(cmd.session?.resolved_cpu_threads ?? null)} />
          <InfoRow
            label="Requested FEM OpenMP threads"
            value={formatCpuThreads(femCpuThreadSummary?.requestedOmpThreads ?? null)}
          />
          <InfoRow
            label="Effective FEM OpenMP threads"
            value={formatCpuThreads(femCpuThreadSummary?.effectiveOmpThreads ?? null)}
          />
          <InfoRow label="Workload" value={workloadLabel} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {solverPlan?.demagEnabled && <StatusBadge label="Demag" />}
          {solverPlan?.exchangeEnabled && <StatusBadge label="Exchange" />}
          {femDiscretization && <StatusBadge label="FEM" tone="info" />}
        </div>
      </SidebarSection>
    </>
  );
}

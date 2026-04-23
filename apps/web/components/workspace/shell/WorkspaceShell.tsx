"use client";

import dynamic from "next/dynamic";
import type { WorkspaceMode } from "@/components/runs/control-room/context-hooks";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

interface WorkspaceShellProps {
  initialStage: WorkspaceMode;
}

function WorkspaceLoadingShell({ label }: { label: string }) {
  return (
    <div className="flex min-h-[40vh] w-full items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

const RunControlRoom = dynamic(() => import("@/components/runs/RunControlRoom"), {
  ssr: false,
  loading: () => <WorkspaceLoadingShell label="Loading control room..." />,
});

const StandaloneThreeDiagnosticViewport = dynamic(() => import("./StandaloneThreeDiagnosticViewport"), {
  ssr: false,
  loading: () => <WorkspaceLoadingShell label="Loading three.js diagnostic viewport..." />,
});

const StandaloneR3fDiagnosticViewport = dynamic(() => import("./StandaloneR3fDiagnosticViewport"), {
  ssr: false,
  loading: () => <WorkspaceLoadingShell label="Loading R3F diagnostic viewport..." />,
});

const StandaloneFemDiagnosticViewport = dynamic(() => import("./StandaloneFemDiagnosticViewport"), {
  ssr: false,
  loading: () => <WorkspaceLoadingShell label="Loading FEM diagnostic viewport..." />,
});

const StandaloneFemSceneDiagnosticViewport = dynamic(
  () => import("./StandaloneFemSceneDiagnosticViewport"),
  {
    ssr: false,
    loading: () => <WorkspaceLoadingShell label="Loading FEM scene diagnostic viewport..." />,
  },
);

export default function WorkspaceShell({ initialStage }: WorkspaceShellProps) {
  if (!FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceShell) {
    return <WorkspaceLoadingShell label="WorkspaceShell disabled (workspace.enableWorkspaceShell = false)." />;
  }

  const diagnosticMode = String(
    FRONTEND_DIAGNOSTIC_FLAGS.workspace.standaloneDiagnosticViewportMode,
  );
  if (diagnosticMode === "three") {
    return <StandaloneThreeDiagnosticViewport />;
  }
  if (diagnosticMode === "r3f") {
    return <StandaloneR3fDiagnosticViewport />;
  }
  if (diagnosticMode === "fem") {
    return <StandaloneFemDiagnosticViewport />;
  }
  if (diagnosticMode === "fem-scene") {
    return <StandaloneFemSceneDiagnosticViewport />;
  }
  if (!FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableRunControlRoom) {
    return <WorkspaceLoadingShell label="RunControlRoom disabled (workspace.enableRunControlRoom = false)." />;
  }
  return <RunControlRoom initialWorkspaceMode={initialStage} />;
}

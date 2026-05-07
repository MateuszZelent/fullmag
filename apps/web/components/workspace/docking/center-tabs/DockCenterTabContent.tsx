"use client";

import type { WorkspaceTab } from "@/lib/workspace/workspace-store";
import type { FrontendDiagnosticFlags } from "@/lib/debug/frontendDiagnosticFlags";
import { isAnalyzeLikeTab } from "./tabSelection";
import { AnalyzeTabPanel } from "./panels/AnalyzeTabPanel";
import { ChartsTabPanel } from "./panels/ChartsTabPanel";
import { ViewportTabPanel } from "./panels/ViewportTabPanel";

type DockCenterTabFlags = FrontendDiagnosticFlags["dockCenterTabs"];

interface DockCenterTabContentProps {
  tab: WorkspaceTab;
  flags: DockCenterTabFlags;
  chartsDisabled: boolean;
  preview3dDisabled: boolean;
  viewportVisible?: boolean;
}

function DisabledPanel({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
      {label}
    </div>
  );
}

export function DockCenterTabContent({
  tab,
  flags,
  chartsDisabled,
  preview3dDisabled,
  viewportVisible = true,
}: DockCenterTabContentProps) {
  if (!flags.enableTabContent) {
    return <DisabledPanel label="Tab content disabled by diagnostic flag" />;
  }

  if (tab.kind === "viewport-charts") {
    if (!flags.enableChartsViewport) {
      return <DisabledPanel label="2D Plots disabled by diagnostic flag" />;
    }
    return <ChartsTabPanel disabled={chartsDisabled} />;
  }

  if (isAnalyzeLikeTab(tab)) {
    if (!flags.enableAnalyzeViewport) {
      return <DisabledPanel label="AnalyzeViewport disabled by diagnostic flag" />;
    }
    return <AnalyzeTabPanel />;
  }

  if (preview3dDisabled) {
    return <DisabledPanel label="3D preview disabled via feature flags" />;
  }

  if (!flags.enableViewportCanvas) {
    return <DisabledPanel label="ViewportCanvasArea disabled by diagnostic flag" />;
  }

  return <ViewportTabPanel viewportVisible={viewportVisible} />;
}

"use client";

import {
  ArrowRight,
  CheckCircle2,
  Compass,
  Play,
  RefreshCw,
} from "lucide-react";
import { useMemo } from "react";

import { ScratchAuthoringGuide } from "@/kernel/authoring/ScratchAuthoringGuide";
import { resolveScratchAuthoringAction } from "@/kernel/authoring/scratchAuthoringGuideModel";
import { toChecklist } from "@/kernel/authoring/scratchAuthoringReadiness";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useModelReadinessResource } from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi } from "@/kernel/types";
import { FemMeshReadinessGuideCard } from "@/modules/inspector/public";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

export function ExplorerHelperPanel({
  kernel,
}: {
  readonly kernel: KernelApi;
}) {
  const readiness = useModelReadinessResource({ enabled: true });
  const commandContext = useMemo(
    () => createCommandContext("explorer", kernel),
    [kernel],
  );

  const checks = readiness.data ? toChecklist(readiness.data) : [];
  const totalCount = checks.length;
  const completedCount = checks.filter(
    (check) => check.state === "complete",
  ).length;
  const incompleteChecks = checks.filter(
    (check) => check.state !== "complete",
  );
  const incompleteCount = incompleteChecks.length;
  const firstIncomplete = incompleteChecks[0] ?? null;
  const nextAction = firstIncomplete
    ? resolveScratchAuthoringAction(firstIncomplete)
    : null;
  const isReady = Boolean(
    readiness.data?.ready_to_run && incompleteCount === 0,
  );
  const progressPct =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  function triggerNextStep(): void {
    if (!firstIncomplete) {
      kernel.layout.setPanelVisible("right", true);
      void kernel.commands.execute("study.run", commandContext);
      return;
    }
    const action = resolveScratchAuthoringAction(firstIncomplete);
    if (action.kind === "command") {
      kernel.layout.setPanelVisible("right", true);
      void kernel.commands.execute(action.commandId, commandContext);
      return;
    }
    if (action.kind === "selection") {
      kernel.layout.setPanelVisible("right", true);
      kernel.selection.set(action.selection, "ribbon");
      return;
    }
    kernel.layout.setPanelVisible("left", true);
  }

  return (
    <div
      className="fm-explorer-helper"
      data-testid="explorer-helper-panel"
    >
      <section
        aria-label="Compute readiness overview"
        className="fm-explorer-helper__summary"
      >
        <div className="fm-explorer-helper__summary-head">
          <div className="fm-explorer-helper__summary-title">
            {isReady ? (
              <CheckCircle2
                aria-hidden="true"
                className="fm-explorer-helper__icon--ready"
                size={15}
              />
            ) : (
              <Compass
                aria-hidden="true"
                className="fm-explorer-helper__icon--pending"
                size={15}
              />
            )}
            <span>Compute Readiness</span>
          </div>
          <Badge variant={isReady ? "success" : readiness.data ? "warning" : "secondary"}>
            {isReady
              ? "Ready"
              : readiness.data
                ? `${incompleteCount} missing`
                : "Checking…"}
          </Badge>
        </div>

        <p className="fm-explorer-helper__summary-copy">
          {isReady
            ? "All geometry, material, physics, discretization, and study checks passed. You can launch Compute."
            : firstIncomplete
              ? `Next blocker: ${firstIncomplete.label}${firstIncomplete.reason ? ` — ${firstIncomplete.reason}` : ""}`
              : readiness.status === "loading"
                ? "Inspecting current session readiness from backend…"
                : "Review the checklist below to prepare this session for Compute."}
        </p>

        {totalCount > 0 ? (
          <div className="fm-explorer-helper__progress-block">
            <div className="fm-explorer-helper__progress-meta">
              <span>Checklist progress</span>
              <span>
                {completedCount}/{totalCount}
              </span>
            </div>
            <div
              aria-label="Compute readiness progress"
              aria-valuemax={totalCount}
              aria-valuemin={0}
              aria-valuenow={completedCount}
              className="fm-explorer-helper__progress-track"
              role="progressbar"
            >
              <div
                className="fm-explorer-helper__progress-fill"
                data-ready={isReady ? "true" : "false"}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        ) : null}

        <div className="fm-explorer-helper__summary-actions">
          <Button
            className="fm-explorer-helper__primary-cta"
            disabled={!readiness.data}
            size="sm"
            type="button"
            variant="primary"
            onClick={triggerNextStep}
          >
            {isReady ? (
              <>
                <Play aria-hidden="true" size={13} />
                <span>Start Compute</span>
              </>
            ) : (
              <>
                <span>{nextAction ? nextAction.label : "Review next step"}</span>
                <ArrowRight aria-hidden="true" size={13} />
              </>
            )}
          </Button>
          <Button
            aria-label="Refresh readiness checks"
            size="icon"
            title="Refresh readiness checks"
            type="button"
            variant="secondary"
            onClick={readiness.refetch}
          >
            <RefreshCw aria-hidden="true" size={13} />
          </Button>
        </div>
      </section>

      <div className="fm-explorer-helper__sections">
        <ScratchAuthoringGuide
          commandContext={commandContext}
          kernel={kernel}
          readiness={readiness}
        />
        <FemMeshReadinessGuideCard />
      </div>
    </div>
  );
}

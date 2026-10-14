"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Play,
  Sparkles,
} from "lucide-react";
import { useCallback, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type {
  FemMeshGuideActionTarget,
  FemMeshGuideOverallStatus,
  FemMeshGuideStepStatus,
} from "./femMeshReadinessGuide";
import { useFemMeshReadinessGuide } from "./useFemMeshReadinessGuide";

export interface FemMeshReadinessGuideCardProps {
  compact?: boolean;
  selectedObjectId?: string | null;
  selectedObjectPolicy?: unknown;
  sharedDomainPolicy?: unknown;
  universePolicy?: unknown;
}

function stepBadgeVariant(
  status: FemMeshGuideStepStatus,
): "accent" | "danger" | "default" | "success" | "warning" {
  switch (status) {
    case "ready":
      return "success";
    case "recommended":
    case "in-progress":
      return "accent";
    case "stale":
    case "warning":
      return "warning";
    case "missing":
    case "failed":
    case "blocked":
      return "danger";
    default:
      return "default";
  }
}

function overallBadgeVariant(
  status: FemMeshGuideOverallStatus,
): "accent" | "danger" | "default" | "success" | "warning" {
  switch (status) {
    case "ready":
      return "success";
    case "needs-build":
    case "building":
      return "accent";
    case "stale":
    case "quality-warning":
      return "warning";
    case "blocked":
    case "failed":
      return "danger";
    default:
      return "default";
  }
}

export function FemMeshReadinessGuideCard(
  props: FemMeshReadinessGuideCardProps,
) {
  const kernel = useKernel();
  if (
    !kernel?.diagnosticRecorder ||
    typeof kernel?.resources?.getRevision !== "function" ||
    typeof kernel?.resources?.subscribe !== "function"
  ) {
    return null;
  }
  return <FemMeshReadinessGuideCardInner {...props} />;
}

function FemMeshReadinessGuideCardInner({
  compact = false,
  selectedObjectId = null,
  selectedObjectPolicy,
  sharedDomainPolicy,
  universePolicy,
}: FemMeshReadinessGuideCardProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const guide = useFemMeshReadinessGuide({
    enabled: true,
    selectedObjectId,
    selectedObjectPolicy,
    sharedDomainPolicy,
    universePolicy,
  });
  const [expanded, setExpanded] = useState(!compact);
  const [runningCommand, setRunningCommand] = useState(false);

  const executeGuideAction = useCallback(
    async (action: FemMeshGuideActionTarget) => {
      if (
        action.kind === "select-node" ||
        action.kind === "focus-inspector-section"
      ) {
        kernel.selection?.set?.(action.selection, "inspector");
        return;
      }

      if (action.kind === "execute-command") {
        if (runningCommand) return;
        setRunningCommand(true);
        try {
          const context = createCommandContext("inspector", kernel, {
            sessionScopeKey,
            sourceDetail: "fem-mesh-readiness-guide",
          });
          await kernel.commands.execute(action.commandId, context);
        } finally {
          setRunningCommand(false);
        }
      }
    },
    [kernel, runningCommand, sessionScopeKey],
  );

  if (!guide) {
    return null;
  }

  const progressPercent = Math.round(guide.progressRatio * 100);

  return (
    <section
      aria-label="FEM Mesh Readiness Guide"
      className="fm-mesh-guide"
      data-fem-mesh-guide-status={guide.overallStatus}
    >
      <div className="fm-mesh-guide__header">
        <div className="fm-mesh-guide__title-row">
          <Compass
            aria-hidden="true"
            className="fm-mesh-guide__icon"
            size={15}
          />
          <span className="fm-mesh-guide__title">FEM Mesh Readiness Guide</span>
          <Badge variant={overallBadgeVariant(guide.overallStatus)}>
            {guide.overallStatusLabel} ({guide.completedRequiredSteps}/
            {guide.totalRequiredSteps})
          </Badge>
        </div>
        <button
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse FEM Mesh Guide" : "Expand FEM Mesh Guide"
          }
          className="fm-mesh-guide__toggle"
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progressPercent}
        className="fm-mesh-guide__progress-track"
        role="progressbar"
      >
        <div
          className="fm-mesh-guide__progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="fm-mesh-guide__next-banner">
        <div className="fm-mesh-guide__next-text">
          <div className="fm-mesh-guide__headline">{guide.headline}</div>
          <div className="fm-mesh-guide__detail">{guide.subheadline}</div>
        </div>
        {guide.nextRecommendedStep ? (
          <Button
            disabled={runningCommand}
            size="sm"
            type="button"
            variant="primary"
            onClick={() =>
              void executeGuideAction(guide.nextRecommendedStep!.actionTarget)
            }
          >
            <Play aria-hidden="true" size={12} />
            <span>
              {runningCommand
                ? "Running…"
                : guide.nextRecommendedStep.actionLabel}
            </span>
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <ol className="fm-mesh-guide__quest-list">
          {guide.steps.map((step) => {
            const isRecommended =
              guide.nextRecommendedStep?.id === step.id;
            return (
              <li
                key={step.id}
                className="fm-mesh-guide__quest-item"
                data-quest-recommended={String(isRecommended)}
                data-quest-status={step.status}
              >
                <div className="fm-mesh-guide__quest-main">
                  <span className="fm-mesh-guide__quest-step">
                    {step.status === "ready" ? (
                      <CheckCircle2 aria-hidden="true" size={14} />
                    ) : step.status === "failed" ||
                      step.status === "missing" ||
                      step.status === "warning" ||
                      step.status === "stale" ? (
                      <AlertTriangle aria-hidden="true" size={14} />
                    ) : (
                      <Sparkles aria-hidden="true" size={14} />
                    )}
                  </span>
                  <div className="fm-mesh-guide__quest-copy">
                    <div className="fm-mesh-guide__quest-header">
                      <span className="fm-mesh-guide__quest-title">
                        {step.title}
                      </span>
                      <Badge variant={stepBadgeVariant(step.status)}>
                        {step.statusLabel}
                      </Badge>
                    </div>
                    <p className="fm-mesh-guide__quest-summary">
                      {step.summary}
                    </p>
                    <p className="fm-mesh-guide__detail">{step.detail}</p>
                    {step.parameterChips.length > 0 ? (
                      <ul className="fm-mesh-guide__hints">
                        {step.parameterChips.map((chip) => (
                          <li key={`${chip.label}:${chip.value}`}>
                            {chip.label}: {chip.value} ({chip.source})
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
                <div className="fm-mesh-guide__quest-actions">
                  <Button
                    disabled={runningCommand}
                    size="sm"
                    type="button"
                    variant={isRecommended ? "primary" : "secondary"}
                    onClick={() => void executeGuideAction(step.actionTarget)}
                  >
                    {step.actionLabel}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

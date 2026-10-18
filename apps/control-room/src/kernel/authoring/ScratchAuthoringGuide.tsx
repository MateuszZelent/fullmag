"use client";

import { useState } from "react";

import type { ModelReadinessResource } from "../api/apiTypes";
import type { CommandContext } from "../commands/commandTypes";
import type { KernelApi } from "../types";
import type { ResourceResult } from "../resources/resourceTypes";
import { Button } from "@/shared/ui/Button";

import { toChecklist } from "./scratchAuthoringReadiness";
import { resolveScratchAuthoringAction } from "./scratchAuthoringGuideModel";

export function ScratchAuthoringGuide({
  commandContext,
  kernel,
  onCloseModal,
  readiness,
}: {
  readonly commandContext: CommandContext;
  readonly kernel: KernelApi;
  readonly onCloseModal?: () => void;
  readonly readiness: ResourceResult<ModelReadinessResource>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const checks = readiness.data ? toChecklist(readiness.data) : [];
  const incompleteCount = checks.filter((check) => check.state !== "complete").length;
  const extraBlockers = readiness.data
    ? Array.from(new Set(readiness.data.blockers)).filter(
        (blocker) =>
          !checks.some(
            (check) =>
              check.state !== "complete" && check.reason === blocker,
          ),
      )
    : [];

  function openAction(check: (typeof checks)[number]): void {
    const action = resolveScratchAuthoringAction(check);

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
    <section
      aria-labelledby="fm-scratch-authoring-guide-title"
      className="fm-helper-guide"
      data-readiness-revision={readiness.data?.scene_revision ?? "unknown"}
      data-readiness-status={readiness.status}
      data-testid="scratch-authoring-guide"
    >
      <header className="fm-helper-guide__header">
        <div className="fm-helper-guide__title-group">
          <h2
            className="fm-helper-guide__title"
            id="fm-scratch-authoring-guide-title"
          >
            Next steps
          </h2>
          <span className="fm-helper-guide__status" role="status">
            {readiness.data
              ? `${readiness.status === "stale" ? "Cached result: server reported " : "Server reports "}${readiness.data.ready_to_run ? "ready" : "not ready"} to run.`
              : readiness.status === "loading"
                ? "Checking model readiness…"
                : "Model readiness is not available yet."}
          </span>
          {readiness.data && incompleteCount > 0 ? (
            <span className="fm-helper-guide__meta">
              {incompleteCount} {incompleteCount === 1 ? "check" : "checks"} need attention.
            </span>
          ) : null}
          {readiness.data ? (
            <span className="fm-helper-guide__meta">
              Scene revision {readiness.data.scene_revision}
            </span>
          ) : null}
        </div>
        <div className="fm-helper-guide__actions">
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={readiness.refetch}
          >
            Check readiness
          </Button>
          <Button
            aria-expanded={!collapsed}
            aria-controls="fm-scratch-authoring-checks"
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              const nextCollapsed = !collapsed;
              setCollapsed(nextCollapsed);
              if (nextCollapsed) {
                onCloseModal?.();
              }
            }}
          >
            {collapsed ? "Show steps" : "Hide steps"}
          </Button>
        </div>
      </header>

      {readiness.status === "error" && !readiness.data ? (
        <p className="fm-helper-guide__error" role="alert">
          {readiness.error?.message ?? "Could not load model readiness."}
        </p>
      ) : null}

      {!collapsed ? (
        <div className="fm-helper-guide__content" id="fm-scratch-authoring-checks">
          {checks.length > 0 ? (
            <ol
              aria-label="Model readiness checklist"
              className="fm-helper-guide__grid"
            >
              {checks.map((check) => {
                const resolvedAction = resolveScratchAuthoringAction(check);
                const canEditWhenComplete =
                  ["method", "domain", "study", "execution"].includes(check.id) ||
                  ((check.id === "material" ||
                    check.id === "texture" ||
                    check.id === "interactions") &&
                    resolvedAction.kind === "selection");
                const action =
                  check.state === "complete" && !canEditWhenComplete
                    ? null
                    : resolvedAction;
                const stateLabel =
                  check.state === "complete"
                    ? "Ready"
                    : check.state === "stale"
                      ? "Out of date"
                      : "Needs attention";

                return (
                  <li
                    className="fm-helper-guide__card"
                    data-check-id={check.id}
                    data-check-state={check.state}
                    key={check.id}
                  >
                    <div className="fm-helper-guide__card-copy">
                      <div className="fm-helper-guide__card-head">
                        <span className="fm-helper-guide__card-title">{check.label}</span>
                        <span
                          className="fm-helper-guide__card-badge"
                          data-state={check.state}
                        >
                          {stateLabel}
                        </span>
                      </div>
                      {check.reason ? (
                        <p className="fm-helper-guide__card-reason">
                          {check.reason}
                        </p>
                      ) : null}
                      {check.id === "domain" ? (
                        <p className="fm-helper-guide__card-hint">
                          Configure policy in the Universe Inspector now or later. Automatic bounds are derived after geometry is added.
                        </p>
                      ) : null}
                      {action?.kind === "explorer" && action.targetResource ? (
                        <p className="fm-helper-guide__card-hint">
                          Target: {action.targetResource}
                        </p>
                      ) : null}
                    </div>
                    {action ? (
                      <Button
                        size="sm"
                        type="button"
                        variant={check.state === "complete" ? "ghost" : "secondary"}
                        onClick={() => openAction(check)}
                      >
                        {action.label}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : readiness.data ? (
            <p className="fm-helper-guide__empty">
              The readiness resource did not report any checks.
            </p>
          ) : null}
          {extraBlockers.length > 0 ? (
            <section
              aria-label="Additional run blockers"
              className="fm-helper-guide__blockers"
            >
              <h3 className="fm-helper-guide__blockers-title">
                Additional server blockers
              </h3>
              <ul className="fm-helper-guide__blockers-list">
                {extraBlockers.map((blocker) => (
                  <li
                    className="fm-helper-guide__blockers-item"
                    key={blocker}
                  >
                    <span>{blocker}</span>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        kernel.layout.openBottomPanel("diagnostics");
                        onCloseModal?.();
                      }}
                    >
                      View diagnostics
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {readiness.data &&
          !readiness.data.ready_to_run &&
          incompleteCount === 0 &&
          extraBlockers.length === 0 ? (
            <p className="fm-helper-guide__empty">
              The server reports that this model is not ready to run, but did not report an incomplete check or additional blocker detail.
            </p>
          ) : null}
          {readiness.status === "stale" ? (
            <p className="fm-helper-guide__stale" role="status">
              Readiness data is out of date. Check readiness to refresh it.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

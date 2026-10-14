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
  readiness,
}: {
  readonly commandContext: CommandContext;
  readonly kernel: KernelApi;
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
      className="border-t border-fm-border bg-fm-surface px-4 py-3 text-fm-primary"
      data-readiness-revision={readiness.data?.scene_revision ?? "unknown"}
      data-readiness-status={readiness.status}
      data-testid="scratch-authoring-guide"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2
            className="m-0 font-fm-ui text-sm font-semibold"
            id="fm-scratch-authoring-guide-title"
          >
            Next steps
          </h2>
          <span className="text-xs text-fm-muted" role="status">
            {readiness.data
              ? `${readiness.status === "stale" ? "Cached result: server reported " : "Server reports "}${readiness.data.ready_to_run ? "ready" : "not ready"} to run.`
              : readiness.status === "loading"
                ? "Checking model readiness…"
                : "Model readiness is not available yet."}
          </span>
          {readiness.data && incompleteCount > 0 ? (
            <span className="text-xs text-fm-muted">
              {incompleteCount} {incompleteCount === 1 ? "check" : "checks"} need attention.
            </span>
          ) : null}
          {readiness.data ? (
            <span className="text-xs text-fm-muted">
              Scene revision {readiness.data.scene_revision}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? "Show steps" : "Hide steps"}
          </Button>
        </div>
      </header>

      {readiness.status === "error" && !readiness.data ? (
        <p className="mb-0 mt-2 text-sm text-fm-danger" role="alert">
          {readiness.error?.message ?? "Could not load model readiness."}
        </p>
      ) : null}

      {!collapsed ? (
        <div className="mt-3" id="fm-scratch-authoring-checks">
          {checks.length > 0 ? (
            <ol
              aria-label="Model readiness checklist"
              className="m-0 grid max-h-[36vh] list-none gap-2 overflow-y-auto overscroll-contain p-0 md:grid-cols-2 xl:grid-cols-3"
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
                    className="flex min-w-0 items-start justify-between gap-3 rounded-md border border-fm-border bg-fm-base px-3 py-2"
                    data-check-id={check.id}
                    data-check-state={check.state}
                    key={check.id}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">{check.label}</span>
                        <span
                          className={
                            check.state === "complete"
                              ? "text-xs text-fm-success"
                              : check.state === "stale"
                                ? "text-xs text-fm-warning"
                                : "text-xs text-fm-secondary"
                          }
                        >
                          {stateLabel}
                        </span>
                      </div>
                      {check.reason ? (
                        <p className="mb-0 mt-1 text-xs text-fm-secondary">
                          {check.reason}
                        </p>
                      ) : null}
                      {check.id === "domain" ? (
                        <p className="mb-0 mt-1 text-xs text-fm-muted">
                          Configure policy in the Universe Inspector now or later. Automatic bounds are derived after geometry is added.
                        </p>
                      ) : null}
                      {action?.kind === "explorer" && action.targetResource ? (
                        <p className="mb-0 mt-1 break-all text-xs text-fm-muted">
                          Target: {action.targetResource}
                        </p>
                      ) : null}
                    </div>
                    {action ? (
                      <Button
                        className="shrink-0"
                        size="sm"
                        type="button"
                        variant="ghost"
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
            <p className="mb-0 text-sm text-fm-secondary">
              The readiness resource did not report any checks.
            </p>
          ) : null}
          {extraBlockers.length > 0 ? (
            <section
              aria-label="Additional run blockers"
              className="mt-3 rounded-md border border-fm-border bg-fm-base px-3 py-2"
            >
              <h3 className="mb-2 mt-0 text-sm font-medium">
                Additional server blockers
              </h3>
              <ul className="m-0 grid list-none gap-2 p-0">
                {extraBlockers.map((blocker) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-2 text-sm text-fm-secondary"
                    key={blocker}
                  >
                    <span>{blocker}</span>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => kernel.layout.openBottomPanel("diagnostics")}
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
            <p className="mb-0 mt-2 text-sm text-fm-secondary">
              The server reports that this model is not ready to run, but did not report an incomplete check or additional blocker detail.
            </p>
          ) : null}
          {readiness.status === "stale" ? (
            <p className="mb-0 mt-2 text-xs text-fm-warning" role="status">
              Readiness data is out of date. Check readiness to refresh it.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

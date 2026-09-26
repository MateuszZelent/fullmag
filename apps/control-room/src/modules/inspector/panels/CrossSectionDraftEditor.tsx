"use client";

import { useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  discardCrossSectionDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  updateCrossSectionDraft,
  type CrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import { MeshResourceEmpty } from "./MeshResourceView";
import { CrossSectionSettingsEditor } from "./CrossSectionSettingsEditor";

function updateDraft(patch: Partial<CrossSectionDraft>): void {
  updateCrossSectionDraft(patch);
}

export function CrossSectionDraftEditor({
  draft,
}: {
  draft: CrossSectionDraft | null;
}) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const monitors = usePlanarMonitorsResource();
  const visualizationState = useVisualizationStateResource();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey;

  if (!draft) {
    return <MeshResourceEmpty label="No editable cross-section draft." />;
  }

  const commitDraft = async () => {
    if (!visualizationState.data?.planar) {
      setFeedback("Planar visualization state is unavailable.");
      return;
    }
    const operationSessionScopeKey = sessionScopeKey;
    if (!operationSessionScopeKey) {
      setFeedback("Session identity is not ready. Try again after it loads.");
      return;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const historyContext = createCommandContext("inspector", kernel, {
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: () =>
        kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
        (historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration),
      sourceDetail: "cross-section-draft",
    });
    const operationId = ++nextPendingOperationId.current;
    setPendingOperation({ id: operationId, sessionScopeKey: operationSessionScopeKey });
    setFeedback(null);
    setConflict(false);
    try {
      const domain = await kernel.api.data.domain.meta({
        sessionScopeKey: operationSessionScopeKey,
      });
      if (historyContext.isCurrentSessionScope?.() === false) return;
      const created = await runAuthoringMutationWithHistory(
        historyContext,
        `Create planar monitor ${draft.name}`,
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? monitors.data?.scene_revision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          const request = planarMonitorCreateRequestFromDraft(
            draft,
            commitRevision,
            {
              max: domain.bounds.max as [number, number, number],
              min: domain.bounds.min as [number, number, number],
            },
          );
          return kernel.api.model.planarMonitors.create(request, {
            sessionScopeKey: operationSessionScopeKey,
          });
        },
      );
      if (historyContext.isCurrentSessionScope?.() === false) return;
      const monitor = created.monitor;
      discardCrossSectionDraft();
      kernel.visualizationSync.queuePatch({
        planar: { source: { kind: "monitor", monitor_id: monitor.id } },
      });
      kernel.resources.invalidate(
        MODEL_PLANAR_MONITORS_PATH,
        created.scene_revision,
      );
      const nodeId = `model:definitions:planar-monitors:${monitor.id}`;
      kernel.selection.set(
        {
          kind: "model.planar.monitor",
          label: monitor.name,
          nodeId,
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: monitor.id,
            nodeId,
            type: "planar-monitor",
            visualizationTargetId: `planar-monitor:${monitor.id}`,
          },
        },
        "inspector",
      );
      kernel.layout.setActiveViewportMainModule("field-map");
      kernel.layout.setFocusedSlot("viewport-main");
      kernel.layout.setPanelVisible("right", true);
    } catch (error) {
      if (historyContext.isCurrentSessionScope?.() === false) return;
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor draft was open. Reload the current revision before applying again."
          : error instanceof Error
          ? error.message
          : "Planar monitor commit failed. Reload the scene and retry.",
      );
    } finally {
      setPendingOperation((current) =>
        current?.id === operationId ? null : current,
      );
    }
  };

  return (
    <div className="fm-cross-section-inspector">
      <CrossSectionSettingsEditor
        value={draft}
        onChange={updateDraft}
        action={
          <div className="fm-inspector-toolbar">
            <Button
              disabled={pending}
              size="sm"
              type="button"
              variant="ghost"
              onClick={discardCrossSectionDraft}
            >
              Discard
            </Button>
            <Button
              disabled={pending || !monitors.data || !visualizationState.data?.planar}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void commitDraft()}
            >
              Apply monitor
            </Button>
          </div>
        }
      />
      {feedback ? <p role="alert">{feedback}</p> : null}
      {conflict ? (
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={monitors.refetch}
        >
          Reload current monitors
        </Button>
      ) : null}
    </div>
  );
}

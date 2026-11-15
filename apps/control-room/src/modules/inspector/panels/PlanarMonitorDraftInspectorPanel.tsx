"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  crossSectionWorkspaceStore,
  discardPlanarMonitorDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  planarMonitorIdentityForCreate,
  planarMonitorValidationErrors,
  updatePlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { MeshResourceEmpty } from "./MeshResourceView";
import {
  PlanarMonitorDefinitionEditor,
  planarMonitorDefinitionAvailabilityErrors,
} from "./PlanarMonitorDefinitionEditor";
import { usePlanarMonitorDefinitionAvailability } from "./usePlanarMonitorDefinitionAvailability";

export function PlanarMonitorDraftInspectorPanel() {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const definitionAvailability = usePlanarMonitorDefinitionAvailability();
  const monitors = usePlanarMonitorsResource();
  const visualizationState = useVisualizationStateResource();
  const draft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const applyInFlight = useRef(false);
  const acknowledgeCommittedDraftRef = useRef<(() => boolean) | null>(null);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey;

  function createHistoryMutationContext() {
    const operationSessionScopeKey = sessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    return {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: () =>
        kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
        (historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }

  const validationErrors = draft
    ? [
        ...planarMonitorValidationErrors(draft.monitor),
        ...planarMonitorDefinitionAvailabilityErrors(draft.monitor, definitionAvailability),
      ]
    : [];

  const commitDraft = async (): Promise<boolean> => {
    const acknowledgeDraft = acknowledgeCommittedDraftRef.current;
    if (applyInFlight.current) return false;
    if (!draft) return false;
    if (!visualizationState.data?.planar) {
      setFeedback("Planar visualization state is unavailable.");
      return false;
    }
    const historyContext = createHistoryMutationContext();
    if (!historyContext.sessionScopeKey) {
      setFeedback("Session identity is not ready. Try again after it loads.");
      return false;
    }
    const operationId = ++nextPendingOperationId.current;
    const submittedDraft = draft;
    applyInFlight.current = true;
    setPendingOperation({
      id: operationId,
      sessionScopeKey: historyContext.sessionScopeKey,
    });
    setFeedback(null);
    setConflict(false);
    try {
      const existing = monitors.data?.monitors ?? [];
      const hasIdentityCollision = existing.some(
        (monitor) => monitor.id === draft.monitor.id || monitor.name === draft.monitor.name,
      );
      const identity = hasIdentityCollision
        ? planarMonitorIdentityForCreate(draft.monitor.name, existing)
        : { id: draft.monitor.id, name: draft.monitor.name };
      const draftWithIdentity = {
        ...draft,
        monitor: { ...draft.monitor, ...identity },
      };
      const created = await runAuthoringMutationWithHistory(
        historyContext,
        "Create planar monitor",
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? monitors.data?.scene_revision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          return kernel.api.model.planarMonitors.create(
            planarMonitorCreateRequestFromDraft(draftWithIdentity, commitRevision),
            { sessionScopeKey: historyContext.sessionScopeKey! },
          );
        },
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      const monitor = created.monitor;
      const currentDraft = crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft;
      if (currentDraft !== submittedDraft) {
        kernel.resources.invalidate(
          MODEL_PLANAR_MONITORS_PATH,
          created.scene_revision,
        );
        setFeedback("The monitor was created; newer monitor edits remain in the draft.");
        return true;
      }
      if (!acknowledgeDraft?.()) return false;
      discardPlanarMonitorDraft();
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
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor draft was open. Reload the current revision before applying again."
          : error instanceof Error
            ? error.message
            : "Planar monitor commit failed. Reload the scene and retry.",
      );
      return false;
    } finally {
      applyInFlight.current = false;
      setPendingOperation((current) =>
        current?.id === operationId ? null : current,
      );
    }
  };

  const resetDraft = () => {
    discardPlanarMonitorDraft();
    setFeedback(null);
    setConflict(false);
  };
  const resourcesReady = Boolean(monitors.data && visualizationState.data?.planar);
  const acknowledgeCommittedDraft = useRegisterInspectorEditSession(
    draft ? "staged" : null,
    pending,
    draft !== null,
    !draft || (resourcesReady && validationErrors.length === 0),
    undefined,
    commitDraft,
    resetDraft,
    {
      applyBlockReason:
        draft && !sessionScopeKey
          ? "Session identity is not ready."
          : draft && !resourcesReady
            ? "Monitor resources are still loading."
            : undefined,
      historyMode: "mutation-owned",
    },
  );
  useLayoutEffect(() => {
    acknowledgeCommittedDraftRef.current = acknowledgeCommittedDraft;
  }, [acknowledgeCommittedDraft]);

  if (!draft) {
    return <MeshResourceEmpty label="No editable planar monitor draft." />;
  }

  return (
    <div className="fm-cross-section-inspector">
      <PlanarMonitorDefinitionEditor
        availability={definitionAvailability}
        draft={draft}
        mode="create"
        onChange={(next) => updatePlanarMonitorDraft(next)}
      />
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={resetDraft}
        >
          Discard
        </Button>
        <Button
          disabled={pending || !monitors.data || !visualizationState.data?.planar || validationErrors.length > 0}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void commitDraft()}
        >
          Apply monitor
        </Button>
      </div>
      {validationErrors.length > 0 ? (
        <div className="fm-help-text" role="alert">
          {[...new Set(validationErrors)].map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}
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

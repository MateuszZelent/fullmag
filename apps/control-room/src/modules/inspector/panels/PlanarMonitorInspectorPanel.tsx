"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  MODEL_PLANAR_MONITORS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  usePlanarMonitorResource,
} from "@/kernel/resources/planarMonitorResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  isPlanarMonitorRevisionConflict,
  planarMonitorDraftFromMonitor,
  planarMonitorValidationErrors,
  type PlanarMonitor,
  type PlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorPickFaceArmed,
} from "@/kernel/workspace/planarMonitorFramePreview";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { VisualizationContextSwitch } from "../visualization/VisualizationContextSwitch";
import { PlanarVisualizationSection } from "../visualization/PlanarVisualizationSection";
import {
  PlanarMonitorDefinitionEditor,
  planarMonitorDefinitionAvailabilityErrors,
} from "./PlanarMonitorDefinitionEditor";
import { usePlanarMonitorDefinitionAvailability } from "./usePlanarMonitorDefinitionAvailability";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";

export function PlanarMonitorInspectorPanel({ selection }: InspectorPanelProps) {
  const definitionAvailability = usePlanarMonitorDefinitionAvailability();
  const monitorId = selection.ref?.type === "planar-monitor" ? selection.ref.monitorId : "";
  const resource = usePlanarMonitorResource(monitorId, { enabled: monitorId.length > 0 });
  const monitor = resource.data?.monitor;
  const sceneRevision = resource.data?.scene_revision;

  if (!monitor || sceneRevision === undefined) {
    return (
      <div className="fm-inspector-panel">
        <InspectorGroup title="Planar Monitor">
          <FieldRow label="Status" value={resource.status === "error" ? "Unavailable" : "Loading"} />
        </InspectorGroup>
      </div>
    );
  }

  return (
    <CommittedPlanarMonitorEditor
      key={monitor.id}
      monitor={monitor}
      sceneRevision={sceneRevision}
      selection={selection}
      refetch={resource.refetch}
      definitionAvailability={definitionAvailability}
    />
  );
}

function CommittedPlanarMonitorEditor({
  monitor,
  sceneRevision,
  selection,
  refetch,
  definitionAvailability,
}: {
  monitor: PlanarMonitor;
  sceneRevision: number;
  selection: InspectorPanelProps["selection"];
  refetch: () => void;
  definitionAvailability: ReturnType<typeof usePlanarMonitorDefinitionAvailability>;
}) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const visualizationState = useVisualizationStateResource();
  const [acknowledgedBaseline, setAcknowledgedBaseline] = useState<{
    monitor: PlanarMonitor;
    revision: number;
  }>({ monitor, revision: sceneRevision });
  const [baselineState, setBaselineState] = useState({ monitor, revision: sceneRevision });
  const baselineRef = useRef(baselineState);
  const baseline = acknowledgedBaseline.revision > sceneRevision
    ? acknowledgedBaseline
    : baselineState.revision > sceneRevision
      ? baselineState
      : { monitor, revision: sceneRevision };
  const [draft, setDraft] = useState<PlanarMonitorDraft>(() => planarMonitorDraftFromMonitor(monitor));
  const draftRef = useRef(draft);
  const acknowledgeCommittedDraftRef = useRef<(() => boolean) | null>(null);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const applyInFlight = useRef(false);
  const [commandPending, setCommandPending] = useState(false);
  const pending =
    commandPending || pendingOperation?.sessionScopeKey === sessionScopeKey;
  const draftApplying = pendingOperation?.sessionScopeKey === sessionScopeKey;
  const errors = [
    ...planarMonitorValidationErrors(draft.monitor),
    ...(draft.monitor.id === monitor.id ? [] : ["Committed monitor ID must match the resource path ID."]),
    ...planarMonitorDefinitionAvailabilityErrors(draft.monitor, definitionAvailability),
  ];
  const dirty = JSON.stringify(draft.monitor) !== JSON.stringify(baseline.monitor);
  const pickFaceArmed = usePlanarMonitorPickFaceArmed();
  const incomingDefinitionConflict =
    sceneRevision > acknowledgedBaseline.revision &&
    JSON.stringify(monitor) !== JSON.stringify(baselineState.monitor) &&
    JSON.stringify(draft.monitor) !== JSON.stringify(baselineState.monitor);
  const hasConflict = conflict || incomingDefinitionConflict;
  const updateDraft = (next: PlanarMonitorDraft) => {
    draftRef.current = next;
    setDraft(next);
  };
  useEffect(() => {
    if (sceneRevision <= acknowledgedBaseline.revision) return;
    const incoming = { monitor, revision: sceneRevision };
    const previous = baselineRef.current;
    if (
      incoming.revision === previous.revision &&
      JSON.stringify(incoming.monitor) === JSON.stringify(previous.monitor)
    ) {
      return;
    }
    const definitionChanged =
      JSON.stringify(incoming.monitor) !== JSON.stringify(previous.monitor);
    const wasClean = JSON.stringify(draftRef.current.monitor) === JSON.stringify(previous.monitor);
    baselineRef.current = incoming;
    setBaselineState(incoming);
    if (wasClean) {
      const nextDraft = planarMonitorDraftFromMonitor(
        monitor,
        draftRef.current.ui.displayLengthUnit,
      );
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    } else if (definitionChanged) {
      setConflict(true);
      setFeedback(
        "The monitor definition changed externally while this draft was open. Revert to the current monitor before applying.",
      );
    }
  }, [acknowledgedBaseline.revision, monitor, sceneRevision]);
  useEffect(() => {
    planarMonitorFramePreviewStore.setDraft(dirty ? draft : null);
    return () => planarMonitorFramePreviewStore.clearDraft();
  }, [dirty, draft]);
  // The 3D normal handle edits this draft through the same update as the fields.
  useEffect(() => planarMonitorFramePreviewStore.registerDraftEditor({
    monitorId: monitor.id,
    proposeFrame: (frame) => {
      const current = draftRef.current;
      const next = {
        ...current,
        monitor: {
          ...current.monitor,
          frame: {
            ...current.monitor.frame,
            ...Object.fromEntries(Object.entries(frame).map(([key, value]) => [key, [...value]])),
          },
        },
      };
      draftRef.current = next;
      setDraft(next);
    },
  }), [monitor.id]);
  const run = (commandId: string, input?: Record<string, unknown>) =>
    kernel.commands.execute(
      commandId,
      createCommandContext("inspector", kernel, {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
        sourceDetail: "planar-monitor-inspector",
      }),
      { monitorId: monitor.id, ...input },
    );

  const resetDraft = () => {
    const reset = planarMonitorDraftFromMonitor(
      baseline.monitor,
      draft.ui.displayLengthUnit,
    );
    draftRef.current = reset;
    setDraft(reset);
    setFeedback(null);
    setConflict(false);
  };

  const apply = async (): Promise<boolean> => {
    if (applyInFlight.current || hasConflict || !dirty || errors.length > 0) return false;
    const acknowledgeDraft = acknowledgeCommittedDraftRef.current;
    const submittedDraft = draft;
    const submittedMonitor = structuredClone(draft.monitor);
    const operationSessionScopeKey = sessionScopeKey;
    if (!operationSessionScopeKey) {
      setFeedback("Session identity is not ready. Try again after it loads.");
      return false;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const historyContext = createCommandContext("inspector", kernel, {
      resourceData: {
        [VISUALIZATION_STATE_PATH]: visualizationState.data,
      },
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: () =>
        kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
        (historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration),
      sourceDetail: "planar-monitor-inspector",
    });
    const operationId = ++nextPendingOperationId.current;
    applyInFlight.current = true;
    setPendingOperation({ id: operationId, sessionScopeKey: operationSessionScopeKey });
    setFeedback(null);
    setConflict(false);
    try {
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        "Update planar monitor",
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? baseline.revision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          const writeOptions = authoringWriteOptions(
            commitRevision,
            operationSessionScopeKey,
          );
          if (!writeOptions?.sessionScopeKey || writeOptions.baseRevision === undefined) {
            throw new Error(
              "The session-scoped scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          return kernel.api.model.planarMonitors.patch(
            monitor.id,
            {
              expected_scene_revision: writeOptions.baseRevision,
              monitor: submittedMonitor,
            },
            writeOptions,
          );
        },
      );
      if (historyContext.isCurrentSessionScope?.() === false) return false;
      const nextBaseline = {
        monitor: response.monitor,
        revision: response.scene_revision,
      };
      baselineRef.current = nextBaseline;
      setBaselineState(nextBaseline);
      setAcknowledgedBaseline(nextBaseline);
      if (draftRef.current === submittedDraft) {
        if (!acknowledgeDraft?.()) return false;
        const acknowledgedDraft = planarMonitorDraftFromMonitor(
          response.monitor,
          submittedDraft.ui.displayLengthUnit,
        );
        draftRef.current = acknowledgedDraft;
        setDraft(acknowledgedDraft);
      }
      kernel.resources.invalidate(MODEL_PLANAR_MONITORS_PATH, response.scene_revision);
      refetch();
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope?.() === false) return false;
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor was being edited. Reload the current revision before applying again."
          : error instanceof Error
            ? error.message
            : "Planar monitor update failed.",
      );
      return false;
    } finally {
      applyInFlight.current = false;
      setPendingOperation((current) =>
        current?.id === operationId ? null : current,
      );
    }
  };

  const duplicate = async () => {
    setCommandPending(true);
    setFeedback(null);
    try {
      const result = await run("planar-monitor.duplicate");
      if (result.status === "failed") {
        setFeedback(result.message ?? "Planar monitor duplication failed.");
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Planar monitor duplication failed.");
    } finally {
      setCommandPending(false);
    }
  };

  const acknowledgeCommittedDraft = useRegisterInspectorEditSession(
    "staged",
    draftApplying,
    dirty,
    errors.length === 0 && !hasConflict,
    undefined,
    apply,
    resetDraft,
    {
      applyBlockReason: hasConflict
        ? "The monitor definition changed externally. Revert this draft before applying."
        : sessionScopeKey
          ? undefined
          : "Session identity is not ready.",
      historyMode: "mutation-owned",
    },
  );
  useLayoutEffect(() => {
    acknowledgeCommittedDraftRef.current = acknowledgeCommittedDraft;
  }, [acknowledgeCommittedDraft]);

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="View">
        <VisualizationContextSwitch />
      </InspectorGroup>
      <PlanarMonitorDefinitionEditor availability={definitionAvailability} draft={draft} mode="committed" onChange={updateDraft} />
      <InspectorGroup title="Provenance">
        <FieldRow label="Scene revision" value={sceneRevision} />
        <FieldRow label="Source" value="SceneDocument / ProblemIR" />
      </InspectorGroup>
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending || !dirty}
          size="sm"
          type="button"
          variant="ghost"
          onClick={resetDraft}
        >
          Discard
        </Button>
        <Button
          disabled={pending || hasConflict || !dirty || errors.length > 0}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void apply()}
        >
          Apply
        </Button>
      </div>
      {errors.length > 0 ? (
        <div className="fm-help-text" role="alert">
          {errors.map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}
      {feedback ? <p role="alert">{feedback}</p> : null}
      {hasConflict ? (
        <Button size="sm" type="button" variant="secondary" onClick={refetch}>
          Reload current monitor
        </Button>
      ) : null}
      <PlanarVisualizationSection selection={selection} />
      <InspectorGroup title="Actions">
        <div className="fm-inspector-toolbar">
          <Button size="sm" type="button" variant="secondary" onClick={() => void run("field-map.select-monitor")}>
            Open in 2D
          </Button>
          <Button size="sm" type="button" variant="secondary" onClick={() => void run("planar-monitor.create", { intent: { source: "inspector" } })}>
            Create preset
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => void run("planar-monitor.show-frame-3d")}>
            Show frame in 3D
          </Button>
          <Button
            aria-pressed={pickFaceArmed}
            size="sm"
            title="Click an object face in the 3D view to place this monitor on it"
            type="button"
            variant={pickFaceArmed ? "primary" : "ghost"}
            onClick={() => planarMonitorFramePreviewStore.setPickFaceArmed(!pickFaceArmed)}
          >
            Pick face in 3D
          </Button>
          <Button disabled={pending || !visualizationState.data?.planar} size="sm" type="button" variant="ghost" onClick={() => void duplicate()}>
            Duplicate
          </Button>
          <Button disabled={pending} size="sm" type="button" variant="danger" onClick={() => void run("planar-monitor.delete")}>
            Delete
          </Button>
        </div>
      </InspectorGroup>
    </div>
  );
}

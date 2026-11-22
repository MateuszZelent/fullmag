"use client";

import {
  Box,
  Compass,
  Copy,
  Crosshair,
  Eye,
  Layers,
  Palette,
  Plus,
  Slice,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { MODEL_PLANAR_MONITORS_PATH, VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import { authoringWriteOptions, runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
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
import {
  formatInspectorSessionKey,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../../InspectorEditSession";
import { inspectorFitCommandId } from "../../inspectorFitCommand";
import {
  InspectorTemplate,
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import { defaultPlanarDisplayPatch } from "../../visualization/planarDisplayDefaults";
import { PlanarMonitorDefinitionEditor } from "../../panels/PlanarMonitorDefinitionEditor";
import {
  planarMonitorDefinitionAvailabilityErrors,
  type PlanarMonitorDefinitionAvailability,
} from "../../panels/PlanarMonitorDefinitionEditor.model";
import {
  toTemplateDraft,
  type PlanarMonitorTemplateDraft,
  formatMonitorOriginOffsetSummary,
  ConnectedPlanar2DDisplayBody,
  EMPTY_SET,
  CodePreviewDialog,
} from "./planarMonitorShared";

export function CommittedPlanarMonitorTemplateEditor({
  definitionAvailability,
  monitor,
  refetch,
  sceneRevision,
  selection,
}: {
  definitionAvailability: PlanarMonitorDefinitionAvailability;
  monitor: PlanarMonitor;
  refetch?: () => void;
  sceneRevision: number;
  selection: Selection;
}) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const visualizationState = useVisualizationStateResource();
  const pickFaceArmed = usePlanarMonitorPickFaceArmed();

  const [acknowledgedBaseline, setAcknowledgedBaseline] = useState<{
    monitor: PlanarMonitor;
    revision: number;
  }>({ monitor, revision: sceneRevision });
  const [baselineState, setBaselineState] = useState({
    monitor,
    revision: sceneRevision,
  });

  const baseline =
    acknowledgedBaseline.revision > sceneRevision
      ? acknowledgedBaseline
      : baselineState.revision > sceneRevision
        ? baselineState
        : { monitor, revision: sceneRevision };

  const [draft, setDraft] = useState<PlanarMonitorDraft>(() =>
    planarMonitorDraftFromMonitor(monitor),
  );

  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [applying, setApplying] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string>("definition");
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);

  // Reconcile external resource refreshes while preserving clean inputs or flagging conflicts.
  const previousDefinition = JSON.stringify(baselineState.monitor);
  const definitionChanged = JSON.stringify(monitor) !== previousDefinition;
  if (
    sceneRevision > acknowledgedBaseline.revision &&
    (sceneRevision !== baselineState.revision || definitionChanged)
  ) {
    setBaselineState({ monitor, revision: sceneRevision });
    if (JSON.stringify(draft.monitor) === previousDefinition) {
      setDraft(
        planarMonitorDraftFromMonitor(monitor, draft.ui.displayLengthUnit),
      );
    } else if (definitionChanged) {
      setConflict(true);
      setFeedback(
        "The monitor definition changed externally while this draft was open. Revert to the current monitor before applying.",
      );
    }
  }

  const errors = useMemo(
    () => [
      ...planarMonitorValidationErrors(draft.monitor),
      ...(draft.monitor.id === monitor.id
        ? []
        : ["Committed monitor ID must match the resource path ID."]),
      ...planarMonitorDefinitionAvailabilityErrors(
        draft.monitor,
        definitionAvailability,
      ),
    ],
    [definitionAvailability, draft.monitor, monitor.id],
  );

  const dirty =
    JSON.stringify(draft.monitor) !== JSON.stringify(baseline.monitor);
  const pending = applying || commandPending;

  const updateDraft = useCallback((next: PlanarMonitorDraft) => {
    setDraft(next);
    setAppliedFlash(false);
  }, []);

  // Publish live 3D frame preview when dirty and register 3D normal-handle gizmo editor.
  useEffect(() => {
    planarMonitorFramePreviewStore.setDraft(dirty ? draft : null);
    return () => planarMonitorFramePreviewStore.clearDraft();
  }, [dirty, draft]);

  useEffect(
    () =>
      planarMonitorFramePreviewStore.registerDraftEditor({
        monitorId: monitor.id,
        proposeFrame: (frame) => {
          setDraft((current) => ({
            ...current,
            monitor: {
              ...current.monitor,
              frame: {
                ...current.monitor.frame,
                ...Object.fromEntries(
                  Object.entries(frame).map(([key, value]) => [
                    key,
                    [...value],
                  ]),
                ),
                ...(frame.normal || frame.u_axis || frame.v_axis
                  ? { preset: null }
                  : {}),
              },
            },
          }));
        },
      }),
    [monitor.id],
  );

  const runMonitorCommand = useCallback(
    (commandId: CommandId, extraInput?: Record<string, unknown>) =>
      kernel.commands.execute(
        commandId,
        createCommandContext("inspector", kernel, {
          resourceData: {
            [VISUALIZATION_STATE_PATH]: visualizationState.data,
          },
          sourceDetail: "planar-monitor-inspector",
        }),
        { monitorId: monitor.id, ...extraInput },
      ),
    [kernel, monitor.id, visualizationState.data],
  );

  const resetDraft = useCallback(() => {
    setDraft((current) =>
      planarMonitorDraftFromMonitor(
        baseline.monitor,
        current.ui.displayLengthUnit,
      ),
    );
    setFeedback(null);
    setConflict(false);
    setAppliedFlash(false);
  }, [baseline.monitor]);

  const apply = useCallback(async (): Promise<boolean> => {
    if (applying || conflict || !dirty || errors.length > 0) {
      return false;
    }
    if (typeof kernel.api?.model?.planarMonitors?.patch !== "function") {
      return false;
    }
    const activeCommandScopeKey = kernel.commands?.getSessionScopeKey?.();
    const operationSessionScopeKey =
      sessionScopeKey ??
      (typeof activeCommandScopeKey === "string"
        ? activeCommandScopeKey
        : null);
    if (!operationSessionScopeKey || activeCommandScopeKey === null) {
      setFeedback("Session identity is not ready. Try again after it loads.");
      return false;
    }

    const submittedDraft = draft;
    const submittedMonitor = structuredClone(submittedDraft.monitor);
    const initialCommandScope =
      activeCommandScopeKey ?? operationSessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();

    const historyContext = {
      ...createCommandContext("inspector", kernel, {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
        sessionScopeKey: operationSessionScopeKey,
        sourceDetail: "planar-monitor-inspector",
      }),
      isCurrentSessionScope: () => {
        const currentCommandScope =
          typeof kernel.commands?.getSessionScopeKey === "function"
            ? kernel.commands.getSessionScopeKey()
            : operationSessionScopeKey;
        return (
          currentCommandScope !== null &&
          currentCommandScope === initialCommandScope &&
          (historyGeneration === undefined ||
            kernel.authoringHistory?.getGeneration?.() === historyGeneration)
        );
      },
    };

    setApplying(true);
    setFeedback(null);
    setConflict(false);

    try {
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        "Update planar monitor",
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? baseline.revision;
          if (
            typeof commitRevision !== "number" ||
            !Number.isFinite(commitRevision)
          ) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          const writeOptions = authoringWriteOptions(
            commitRevision,
            operationSessionScopeKey,
          );
          if (
            !writeOptions?.sessionScopeKey ||
            writeOptions.baseRevision === undefined
          ) {
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

      if (historyContext.isCurrentSessionScope() === false) return false;

      const nextBaseline = {
        monitor: response.monitor,
        revision: response.scene_revision,
      };
      setBaselineState(nextBaseline);
      setAcknowledgedBaseline(nextBaseline);
      setDraft((current) =>
        current === submittedDraft
          ? planarMonitorDraftFromMonitor(
              response.monitor,
              submittedDraft.ui.displayLengthUnit,
            )
          : current,
      );
      kernel.resources?.invalidate(
        MODEL_PLANAR_MONITORS_PATH,
        response.scene_revision,
      );
      refetch?.();
      setAppliedFlash(true);
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
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
      setApplying(false);
    }
  }, [
    applying,
    baseline.revision,
    conflict,
    dirty,
    draft,
    errors.length,
    kernel,
    monitor.id,
    refetch,
    sessionScopeKey,
    visualizationState.data,
  ]);

  const duplicate = useCallback(async () => {
    setCommandPending(true);
    setFeedback(null);
    try {
      const result = await runMonitorCommand("planar-monitor.duplicate");
      if (result.status === "failed") {
        setFeedback(result.message ?? "Planar monitor duplication failed.");
      }
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Planar monitor duplication failed.",
      );
    } finally {
      setCommandPending(false);
    }
  }, [runMonitorCommand]);

  const handleResetDisplay = useCallback(() => {
    kernel.visualizationSync?.queuePatch({ planar: defaultPlanarDisplayPatch() });
    void kernel.visualizationSync?.flushNow?.();
  }, [kernel.visualizationSync]);

  const dirtyFields = useMemo<ReadonlySet<string>>(() => {
    const next = new Set<string>();
    if (!dirty) return next;
    if (draft.monitor.name !== baseline.monitor.name) next.add("name");
    if (
      JSON.stringify(draft.monitor.target) !==
      JSON.stringify(baseline.monitor.target)
    ) {
      next.add("target");
    }
    if (
      JSON.stringify(draft.monitor.frame) !==
      JSON.stringify(baseline.monitor.frame)
    ) {
      next.add("frame");
    }
    if (
      JSON.stringify(draft.monitor.operator) !==
      JSON.stringify(baseline.monitor.operator)
    ) {
      next.add("operator");
    }
    if (next.size === 0) next.add("monitor");
    return next;
  }, [baseline.monitor, dirty, draft.monitor]);

  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    errors.forEach((err, index) => {
      map.set(index === 0 ? "monitor" : `monitor_${index}`, err);
    });
    return map;
  }, [errors]);

  const specId = `model.planar.monitor:${monitor.id}`;
  const sessionKey = formatInspectorSessionKey(
    selection.nodeId ?? monitor.id,
    specId,
    "definition",
  );
  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey,
      nodeTitle: draft.monitor.name || monitor.id,
      mode: "staged",
      applying,
      dirty,
      dirtyFields,
      dirtyFieldLabels: Array.from(dirtyFields),
      invalidFields,
      valid: errors.length === 0 && !conflict,
      lockReason: conflict
        ? "The monitor definition changed externally. Revert this draft before applying."
        : null,
      applyBlockReason: conflict
        ? "The monitor definition changed externally. Revert this draft before applying."
        : sessionScopeKey
          ? null
          : "Session identity is not ready.",
      apply,
      revertAll: resetDraft,
      revertField: () => resetDraft(),
      focusField: () => setActiveTabId("definition"),
    }),
    [
      apply,
      applying,
      conflict,
      dirty,
      dirtyFields,
      draft.monitor.name,
      errors.length,
      invalidFields,
      monitor.id,
      resetDraft,
      sessionKey,
      sessionScopeKey,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

  const templateDraft = useMemo(() => toTemplateDraft(draft), [draft]);
  const templateBaseline = useMemo(
    () =>
      toTemplateDraft(
        planarMonitorDraftFromMonitor(
          baseline.monitor,
          draft.ui.displayLengthUnit,
        ),
      ),
    [baseline.monitor, draft.ui.displayLengthUnit],
  );

  const pickFaceButton = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Button
          aria-pressed={pickFaceArmed}
          size="sm"
          type="button"
          variant={pickFaceArmed ? "primary" : "secondary"}
          onClick={() =>
            planarMonitorFramePreviewStore.setPickFaceArmed(!pickFaceArmed)
          }
        >
          <Crosshair aria-hidden="true" size={13} />
          <span>Pick face in 3D</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void runMonitorCommand("planar-monitor.show-frame-3d")}
        >
          <Box aria-hidden="true" size={13} />
          <span>Show frame in 3D</span>
        </Button>
      </div>
    ),
    [pickFaceArmed, runMonitorCommand],
  );

  const spec = useMemo<InspectorSpec<PlanarMonitorTemplateDraft>>(
    () => ({
      id: specId,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          {
            id: "monitors",
            label: "Planar Monitors",
            selection: {
              kind: "model.planar.monitors",
              label: "Planar Monitors",
              nodeId: "model:definitions:planar-monitors",
              objectId: null,
              ref: null,
            },
          },
          { id: monitor.id, label: draft.monitor.name || monitor.id },
        ],
        canFitView: true,
        fitCommandId: "planar-monitor.show-frame-3d",
        searchable: true,
        primaryHeaderAction: {
          label: "Open 2D View",
          icon: Eye,
          onRun: () => {
            void runMonitorCommand("field-map.select-monitor");
          },
        },
        extraMenuActions: [
          {
            id: "show-frame-3d",
            label: "Show frame in 3D",
            icon: Box,
            onSelect: () => {
              void runMonitorCommand("planar-monitor.show-frame-3d");
            },
          },
          {
            id: "duplicate-monitor",
            label: "Duplicate",
            icon: Copy,
            disabledReason: !visualizationState.data?.planar
              ? "Planar visualization state is loading."
              : undefined,
            onSelect: () => duplicate(),
          },
          {
            id: "create-preset",
            label: "Create preset",
            icon: Plus,
            onSelect: () => {
              void runMonitorCommand("planar-monitor.create", {
                intent: { source: "inspector" },
              });
            },
          },
        ],
        deleteAction: {
          label: "Delete",
          confirmTitle: (d) => `Delete planar monitor "${d.monitor.name}"?`,
          confirmDescription:
            "This removes the planar monitor definition from the canonical scene.",
          onDelete: async () => {
            await runMonitorCommand("planar-monitor.delete");
          },
        },
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.monitor.name || monitor.id,
        renameFieldKey: "name",
        kindLabel: "Committed 2D planar monitor",
        entityId: monitor.id,
        statePill: () =>
          conflict
            ? { tone: "err", label: "Conflict" }
            : dirty
              ? { tone: "warn", label: "Edited" }
              : { tone: "ok", label: "Committed" },
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Frame",
          value: (d.monitor.frame.preset ?? "arbitrary").toUpperCase(),
        },
        {
          id: "offset",
          label: "Origin",
          value: formatMonitorOriginOffsetSummary(d.monitor),
        },
        { id: "target", label: "Target", value: d.monitor.target.kind },
        { id: "operator", label: "Operator", value: d.monitor.operator.kind },
      ],
      modeTabs: [
        { id: "definition", label: "Definition" },
        {
          id: "display",
          label: "2D Display",
          commitModeOverride: "liveViewport",
        },
      ],
      notices: () => {
        const items: InspectorNotice<PlanarMonitorTemplateDraft>[] = [];
        if (conflict) {
          items.push({
            id: "monitor-conflict",
            tone: "err",
            title: "External scene revision change",
            text:
              feedback ??
              "The monitor definition changed externally while this draft was open.",
            quickFix: {
              label: "Reload current monitor",
              onApply: () => {
                refetch?.();
                resetDraft();
              },
            },
          });
        } else if (feedback) {
          items.push({
            id: "monitor-feedback",
            tone: "err",
            text: feedback,
          });
        }
        for (const err of [...new Set(errors)]) {
          items.push({
            id: `val-${err}`,
            tone: "warn",
            text: err,
          });
        }
        return items;
      },
      sections: [
        {
          id: "plane-definition",
          title: "Monitor Definition",
          icon: Compass,
          modeTabId: "definition",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Planar monitor definition",
              wide: true,
              render: () => (
                <PlanarMonitorDefinitionEditor
                  availability={definitionAvailability}
                  draft={draft}
                  mode="committed"
                  pickFaceSlot={pickFaceButton}
                  onChange={updateDraft}
                />
              ),
            },
          ],
        },
        {
          id: "monitor-actions",
          title: "Monitor Actions",
          icon: Layers,
          modeTabId: "definition",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Actions",
              wide: true,
              render: () => (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void runMonitorCommand("field-map.select-monitor")
                    }
                  >
                    Open 2D View
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void runMonitorCommand("planar-monitor.create", {
                        intent: { source: "inspector" },
                      })
                    }
                  >
                    Create preset
                  </Button>
                  <Button
                    disabled={pending || !visualizationState.data?.planar}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void duplicate()}
                  >
                    Duplicate
                  </Button>
                  <Button
                    disabled={pending}
                    size="sm"
                    type="button"
                    variant="danger"
                    onClick={() =>
                      void runMonitorCommand("planar-monitor.delete")
                    }
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "planar-2d-display",
          title: "2D Display & Field Layers",
          icon: Palette,
          modeTabId: "display",
          live: true,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "2D viewport preferences",
              wide: true,
              render: () => (
                <ConnectedPlanar2DDisplayBody
                  monitorId={monitor.id}
                  selection={selection}
                />
              ),
            },
          ],
        },
      ],
      details: () => [
        { label: "Monitor ID", value: monitor.id, mono: true },
        { label: "Scene revision", value: String(sceneRevision) },
        { label: "Source", value: "SceneDocument / ProblemIR" },
      ],
      commitBar: {
        mode: "staged",
        lockReason: () =>
          conflict
            ? "The monitor definition changed externally. Revert or reload before applying."
            : null,
        onApply: async () => apply(),
        onRevert: () => resetDraft(),
      },
    }),
    [
      apply,
      conflict,
      definitionAvailability,
      dirty,
      draft,
      duplicate,
      errors,
      feedback,
      monitor.id,
      pending,
      pickFaceButton,
      refetch,
      resetDraft,
      runMonitorCommand,
      sceneRevision,
      selection,
      specId,
      updateDraft,
      visualizationState.data?.planar,
    ],
  );

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      if (commandId === "planar-monitor.show-frame-3d") {
        void runMonitorCommand("planar-monitor.show-frame-3d");
        return;
      }
      const activeModuleId = (
        kernel.layout as { get?: () => { activeViewportMainModuleId: string } }
      )?.get?.()?.activeViewportMainModuleId;
      const resolvedId =
        commandId ??
        (activeModuleId
          ? inspectorFitCommandId(activeModuleId)
          : "field-map.fit");
      void kernel.commands.execute(
        resolvedId,
        createCommandContext("inspector", kernel),
      );
    },
    [kernel, runMonitorCommand],
  );

  return (
    <>
      <InspectorTemplate<PlanarMonitorTemplateDraft>
        activeModeTabId={activeTabId}
        appliedFlash={appliedFlash}
        applyError={feedback}
        applying={applying}
        baseline={templateBaseline}
        dirtyFields={dirtyFields}
        draft={templateDraft}
        invalidFields={invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={EMPTY_SET}
        onActiveModeTabChange={setActiveTabId}
        onApply={apply}
        onFieldChange={(key, value) => {
          if (key === "name" && typeof value === "string") {
            updateDraft({
              ...draft,
              monitor: { ...draft.monitor, name: value },
            });
          }
        }}
        onFieldTouch={() => undefined}
        onFitView={handleFitView}
        onHideInspector={() => {
          void kernel.commands.execute(
            "panels:inspector:toggle",
            createCommandContext("inspector", kernel),
          );
        }}
        onOpenCodePreview={(title, _lang, code) =>
          setCodePreview({ title, code })
        }
        onResetDisplay={handleResetDisplay}
        onRevertAll={resetDraft}
        onRevertField={(fieldKey) => {
          if (fieldKey === "name") {
            updateDraft({
              ...draft,
              monitor: { ...draft.monitor, name: baseline.monitor.name },
            });
          } else {
            resetDraft();
          }
        }}
        onSelectNode={(next) => kernel.selection?.set(next, "inspector")}
      />
      <CodePreviewDialog
        codePreview={codePreview}
        onClose={() => setCodePreview(null)}
      />
    </>
  );
}

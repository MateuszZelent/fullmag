"use client";

import {
  Compass,
  Crosshair,
  Palette,
  Slice,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { KernelContext, useKernel } from "@/kernel/KernelContext";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  crossSectionWorkspaceStore,
  discardPlanarMonitorDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  planarMonitorDraftFromMonitor,
  planarMonitorIdentityForCreate,
  planarMonitorValidationErrors,
  updatePlanarMonitorDraft,
  type PlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorPickFaceArmed,
} from "@/kernel/workspace/planarMonitorFramePreview";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";
import {
  formatInspectorSessionKey,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  InspectorTemplate,
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import { defaultPlanarDisplayPatch, planarDisplayDiffersFromDefault } from "../../visualization/planarDisplayDefaults";
import { PlanarMonitorDefinitionEditor } from "../../panels/PlanarMonitorDefinitionEditor";
import { planarMonitorDefinitionAvailabilityErrors } from "../../panels/PlanarMonitorDefinitionEditor.model";
import { ConnectedInspectorSpec, LENGTH_UNITS_SI } from "../../panels/study/ConnectedInspectorSpec";
import {
  useSafePlanarMonitorDefinitionAvailability,
  createDefaultCanonicalMonitor,
  toTemplateDraft,
  type PlanarMonitorTemplateDraft,
  ConnectedPlanar2DDisplayBody,
  EMPTY_SET,
  CodePreviewDialog,
  type PlanarMonitorGeometryDraft,
  DEFAULT_PLANAR_GEOMETRY_DRAFT,
} from "./planarMonitorShared";

/* ── 2. model.planar.monitor.draft — Unsaved Draft ──────────────────────── */

export function PlanarMonitorDraftTemplatePanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedPlanarMonitorDraftPanel {...props} />;
  }
  return <PlanarMonitorDraftFallbackView {...props} />;
}

function ConnectedPlanarMonitorDraftPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const definitionAvailability = useSafePlanarMonitorDefinitionAvailability();
  const monitors = usePlanarMonitorsResource();
  const visualizationState = useVisualizationStateResource();
  const workspaceDraft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
  );
  const pickFaceArmed = usePlanarMonitorPickFaceArmed();

  const initialBaselineDraft = useMemo<PlanarMonitorDraft>(
    () =>
      planarMonitorDraftFromMonitor(
        createDefaultCanonicalMonitor("new_planar_monitor"),
      ),
    [],
  );

  const [localFallbackDraft, setLocalFallbackDraft] =
    useState<PlanarMonitorDraft>(initialBaselineDraft);
  const activeDraft = workspaceDraft ?? localFallbackDraft;
  const draftRef = useRef(activeDraft);
  useLayoutEffect(() => {
    draftRef.current = activeDraft;
  }, [activeDraft]);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string>("definition");
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);
  const applyInFlight = useRef(false);

  const handleDraftChange = useCallback((next: PlanarMonitorDraft) => {
    draftRef.current = next;
    setLocalFallbackDraft(next);
    updatePlanarMonitorDraft(next);
    setFeedback(null);
  }, []);

  // Publish live 3D frame preview and subscribe to 3D normal-handle gizmo edits.
  useEffect(() => {
    planarMonitorFramePreviewStore.setDraft(activeDraft);
    return () => planarMonitorFramePreviewStore.clearDraft();
  }, [activeDraft]);

  useEffect(
    () =>
      planarMonitorFramePreviewStore.registerDraftEditor({
        monitorId: activeDraft.monitor.id,
        proposeFrame: (frame) => {
          const current = draftRef.current;
          const next: PlanarMonitorDraft = {
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
          };
          draftRef.current = next;
          setLocalFallbackDraft(next);
          updatePlanarMonitorDraft(next);
        },
      }),
    [activeDraft.monitor.id],
  );

  const validationErrors = useMemo(
    () => [
      ...planarMonitorValidationErrors(activeDraft.monitor),
      ...planarMonitorDefinitionAvailabilityErrors(
        activeDraft.monitor,
        definitionAvailability,
      ),
    ],
    [activeDraft.monitor, definitionAvailability],
  );

  const commitDraft = useCallback(async (): Promise<boolean> => {
    if (applyInFlight.current) return false;
    if (typeof kernel.api?.model?.planarMonitors?.create !== "function") {
      return false;
    }
    const currentDraft = draftRef.current;
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
    if (validationErrors.length > 0) {
      setFeedback(validationErrors[0] ?? "Fix validation errors before creating.");
      return false;
    }

    const initialCommandScope =
      activeCommandScopeKey ?? operationSessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const historyContext = {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      selection: kernel.selection,
      sessionScopeKey: operationSessionScopeKey,
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

    const submittedDraft = currentDraft;
    applyInFlight.current = true;
    setApplying(true);
    setFeedback(null);
    setConflict(false);

    try {
      const existing = monitors.data?.monitors ?? [];
      const hasIdentityCollision = existing.some(
        (entry) =>
          entry.id === currentDraft.monitor.id ||
          entry.name === currentDraft.monitor.name,
      );
      const identity = hasIdentityCollision
        ? planarMonitorIdentityForCreate(currentDraft.monitor.name, existing)
        : { id: currentDraft.monitor.id, name: currentDraft.monitor.name };
      const draftWithIdentity: PlanarMonitorDraft = {
        ...currentDraft,
        monitor: { ...currentDraft.monitor, ...identity },
      };
      const fallbackRevision = monitors.data?.scene_revision ?? 1;

      const created = await runAuthoringMutationWithHistory(
        historyContext,
        "Create planar monitor",
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? fallbackRevision;
          return kernel.api.model.planarMonitors.create(
            planarMonitorCreateRequestFromDraft(
              draftWithIdentity,
              commitRevision,
            ),
            { sessionScopeKey: operationSessionScopeKey },
          );
        },
      );

      if (historyContext.isCurrentSessionScope() === false) return false;

      const latestStoreDraft =
        crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft;
      if (
        latestStoreDraft !== null &&
        workspaceDraft !== null &&
        latestStoreDraft !== submittedDraft
      ) {
        kernel.resources?.invalidate(
          MODEL_PLANAR_MONITORS_PATH,
          created.scene_revision,
        );
        setFeedback(
          "The monitor was created; newer monitor edits remain in the draft.",
        );
        return true;
      }

      discardPlanarMonitorDraft();
      kernel.visualizationSync?.queuePatch({
        planar: {
          source: { kind: "monitor", monitor_id: created.monitor.id },
        },
      });
      kernel.resources?.invalidate(
        MODEL_PLANAR_MONITORS_PATH,
        created.scene_revision,
      );
      const nodeId = `model:definitions:planar-monitors:${created.monitor.id}`;
      kernel.selection?.set(
        {
          kind: "model.planar.monitor",
          label: created.monitor.name,
          nodeId,
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: created.monitor.id,
            nodeId,
            type: "planar-monitor",
            visualizationTargetId: `planar-monitor:${created.monitor.id}`,
          },
        },
        "inspector",
      );
      kernel.layout?.setActiveViewportMainModule?.("field-map");
      kernel.layout?.setFocusedSlot?.("viewport-main");
      kernel.layout?.setPanelVisible?.("right", true);
      setAppliedFlash(true);
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
      setApplying(false);
    }
  }, [
    kernel,
    monitors.data,
    sessionScopeKey,
    validationErrors,
    workspaceDraft,
  ]);

  const handleDiscardDraft = useCallback(() => {
    discardPlanarMonitorDraft();
    setLocalFallbackDraft(initialBaselineDraft);
    setFeedback(null);
    setConflict(false);
    void kernel.commands?.execute?.(
      "planar-monitor.discard-draft",
      createCommandContext("inspector", kernel, {
        sourceDetail: "planar-monitor-draft-inspector",
      }),
    );
    kernel.selection?.set?.(
      {
        kind: "model.planar.monitors",
        label: "Planar Monitors",
        nodeId: "model:definitions:planar-monitors",
        objectId: null,
        ref: null,
      },
      "inspector",
    );
  }, [initialBaselineDraft, kernel]);

  const handleResetDisplay = useCallback(() => {
    kernel.visualizationSync?.queuePatch({ planar: defaultPlanarDisplayPatch() });
    void kernel.visualizationSync?.flushNow?.();
  }, [kernel.visualizationSync]);

  const templateDraft = useMemo(
    () => toTemplateDraft(activeDraft),
    [activeDraft],
  );
  const templateBaseline = useMemo(
    () => toTemplateDraft(initialBaselineDraft),
    [initialBaselineDraft],
  );

  // An unsaved draft is always unapplied relative to the canonical scene.
  const dirtyFields = useMemo<ReadonlySet<string>>(
    () => new Set(["monitor"]),
    [],
  );
  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    validationErrors.forEach((err, index) => {
      map.set(index === 0 ? "monitor" : `monitor_${index}`, err);
    });
    return map;
  }, [validationErrors]);

  const specId = `model.planar.monitor.draft:${selection.nodeId ?? "draft"}`;
  const sessionKey = formatInspectorSessionKey(
    selection.nodeId ?? "draft",
    specId,
    "definition",
  );
  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey,
      nodeTitle: activeDraft.monitor.name || "New Planar Monitor",
      mode: "staged",
      applying,
      dirty: workspaceDraft !== null,
      dirtyFields,
      dirtyFieldLabels: ["Planar monitor draft"],
      invalidFields,
      valid: invalidFields.size === 0 && !conflict,
      lockReason: conflict
        ? "The scene changed while this draft was open. Reload monitors before applying."
        : null,
      applyBlockReason: !sessionScopeKey ? "Session identity is not ready." : null,
      apply: commitDraft,
      revertAll: handleDiscardDraft,
      revertField: () => handleDiscardDraft(),
      focusField: () => undefined,
    }),
    [
      activeDraft.monitor.name,
      applying,
      commitDraft,
      conflict,
      dirtyFields,
      handleDiscardDraft,
      invalidFields,
      sessionKey,
      sessionScopeKey,
      workspaceDraft,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

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
      </div>
    ),
    [pickFaceArmed],
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
          { id: "draft", label: "New Planar Monitor" },
        ],
        primaryHeaderAction: {
          label: "Discard Draft",
          icon: Trash2,
          variant: "secondary",
          onRun: handleDiscardDraft,
        },
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.monitor.name || "New Planar Monitor",
        renameFieldKey: "name",
        kindLabel: "Unsaved planar monitor draft",
        entityId: activeDraft.monitor.id,
        statePill: () => ({ tone: "warn", label: "Draft" }),
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Frame",
          value: (d.monitor.frame.preset ?? "arbitrary").toUpperCase(),
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
            id: "draft-conflict",
            tone: "err",
            title: "Scene revision conflict",
            text:
              feedback ??
              "The scene changed while this monitor draft was open.",
            quickFix: {
              label: "Reload current monitors",
              onApply: () => {
                monitors.refetch?.();
                setConflict(false);
                setFeedback(null);
              },
            },
          });
        } else if (feedback) {
          items.push({
            id: "draft-feedback",
            tone: "err",
            text: feedback,
          });
        }
        for (const err of [...new Set(validationErrors)]) {
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
          id: "draft-definition",
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
                <div className="grid min-w-0 gap-3">
                  <PlanarMonitorDefinitionEditor
                    availability={definitionAvailability}
                    draft={activeDraft}
                    mode="create"
                    pickFaceSlot={pickFaceButton}
                    onChange={handleDraftChange}
                  />
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      disabled={
                        applying || conflict || validationErrors.length > 0
                      }
                      size="sm"
                      type="button"
                      variant="primary"
                      onClick={() => void commitDraft()}
                    >
                      Create Monitor
                    </Button>
                    <Button
                      disabled={applying}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={handleDiscardDraft}
                    >
                      Discard Draft
                    </Button>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "draft-2d-display",
          title: "2D Slice Display",
          icon: Palette,
          modeTabId: "display",
          live: true,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "2D display",
              wide: true,
              render: () => (
                <ConnectedPlanar2DDisplayBody
                  monitorId={activeDraft.monitor.id}
                  selection={selection}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        lockReason: () =>
          conflict
            ? "Reload current monitors before creating."
            : null,
        onApply: async () => commitDraft(),
        onRevert: () => handleDiscardDraft(),
      },
    }),
    [
      activeDraft,
      applying,
      commitDraft,
      conflict,
      definitionAvailability,
      feedback,
      handleDiscardDraft,
      handleDraftChange,
      monitors,
      pickFaceButton,
      selection,
      specId,
      validationErrors,
    ],
  );

  const hasDisplayOverrides = Boolean(
    visualizationState.data?.planar &&
      planarDisplayDiffersFromDefault(visualizationState.data.planar),
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
        onApply={commitDraft}
        onFieldChange={(key, value) => {
          if (key === "name" && typeof value === "string") {
            handleDraftChange({
              ...activeDraft,
              monitor: { ...activeDraft.monitor, name: value },
            });
          }
        }}
        onFieldTouch={() => undefined}
        onOpenCodePreview={(title, _lang, code) =>
          setCodePreview({ title, code })
        }
        onResetDisplay={hasDisplayOverrides ? handleResetDisplay : handleResetDisplay}
        onRevertAll={handleDiscardDraft}
        onRevertField={() => handleDiscardDraft()}
        onSelectNode={(next) => kernel.selection?.set(next, "inspector")}
      />
      <CodePreviewDialog
        codePreview={codePreview}
        onClose={() => setCodePreview(null)}
      />
    </>
  );
}

function PlanarMonitorDraftFallbackView({ selection }: InspectorPanelProps) {
  const [localBaseline, setLocalBaseline] =
    useState<PlanarMonitorGeometryDraft>({
      ...DEFAULT_PLANAR_GEOMETRY_DRAFT,
      name: "new_planar_monitor",
    });

  const spec = useMemo<InspectorSpec<PlanarMonitorGeometryDraft>>(
    () => ({
      id: `model.planar.monitor.draft:${selection.nodeId ?? "draft"}`,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          { id: "monitors", label: "Planar Monitors" },
          { id: "draft", label: "New Planar Monitor" },
        ],
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.name || "New Planar Monitor",
        renameFieldKey: "name",
        kindLabel: "Unsaved planar monitor draft",
        statePill: () => ({ tone: "warn", label: "Draft" }),
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Orientation",
          value: d.normalPreset.toUpperCase(),
        },
        { id: "grid", label: "Grid", value: `${d.samplesU} x ${d.samplesV}` },
      ],
      sections: [
        {
          id: "draft-frame",
          title: "Plane Geometry & Resolution",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              type: "segmented",
              key: "normalPreset",
              label: "Plane orientation",
              structural: true,
              options: [
                { value: "xy", label: "XY (+z)" },
                { value: "xz", label: "XZ (+y)" },
                { value: "yz", label: "YZ (+x)" },
                { value: "custom", label: "Custom" },
              ],
            },
            {
              type: "quantity",
              key: "planeOffsetM",
              label: "Plane offset",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
            },
            {
              type: "number",
              key: "samplesU",
              label: "Samples along U",
              integer: true,
              min: 4,
              max: 2048,
            },
            {
              type: "number",
              key: "samplesV",
              label: "Samples along V",
              integer: true,
              min: 4,
              max: 2048,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (d) => {
          setLocalBaseline(d);
          return true;
        },
      },
    }),
    [selection.nodeId],
  );

  return (
    <ConnectedInspectorSpec
      baseline={localBaseline}
      selection={selection}
      spec={spec}
    />
  );
}

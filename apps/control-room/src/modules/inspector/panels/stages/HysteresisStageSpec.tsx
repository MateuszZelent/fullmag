"use client";

import {
  Activity,
  ArrowRight,
  Bookmark,
  Box,
  Compass,
  Database,
  Download,
  Gauge,
  GitCommit,
  Magnet,
  Play,
  Radar,
  RotateCcw,
  Sigma,
  Sparkles,
  Table2,
  Workflow,
} from "lucide-react";
import { useCallback, useContext, useMemo, useState } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import type { HysteresisPointSchema, SceneResource } from "@/kernel/api/apiTypes";
import {
  useHysteresisPointsResource,
  useHysteresisProgressResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import type { KernelApi } from "@/kernel/types";
import {
  buildHysteresisLoadPointIn3DInput,
  HysteresisChart,
} from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  inspectorValuesEqual,
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import {
  HysteresisDenseWindowsEditor,
  HysteresisFieldSegmentsEditor,
  HysteresisMinorLoopsEditor,
  HysteresisSettleAlgorithmsEditor,
  HysteresisSettleBranchesEditor,
  parseHysteresisSettleSteps,
} from "../HysteresisStageDraftFields";
import {
  createDefaultStudyStageDraft,
  hysteresisFieldUnitScaleToTesla,
  readStageTextureAssignments,
  studyStageDraftToSceneStage,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../StudyStageAuthoringModel";
import {
  ConnectedInspectorSpec,
  PipelineStrip,
  type PipelineStripStep,
} from "../study/ConnectedInspectorSpec";
import {
  buildStudyCommandContext,
  useKernelStudyAuthoring,
} from "../study/useConnectedStudyAuthoring";
import { HysteresisDiagnosticTableSheet } from "./HysteresisDiagnosticTableSheet";
import {
  StageAutosaveRadixEditor,
  StageInitialStateRadixControl,
  StageTextureOverridesRow,
} from "./StageSharedControls";

type PointFilterBucket = "all" | "snapshots" | "bookmarks";
type FieldDisplayUnit = "mT" | "T" | "Oe" | "kA/m";

interface HysteresisValidationContext {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  backend: string;
  demagEnabled?: boolean;
  device: string;
  mode: string;
  precision?: string;
}

function parseStoragePolicyRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fallback
  }
  return { magnetization: "key_events" };
}

function formatMtInDisplayUnit(rawMt: string, unit: FieldDisplayUnit): string {
  if (unit === "mT") return rawMt;
  const parsed = Number(rawMt.trim());
  if (!Number.isFinite(parsed)) return rawMt;
  const tesla = parsed * 1e-3;
  const scale = hysteresisFieldUnitScaleToTesla(unit);
  return Number((tesla / scale).toPrecision(7)).toString();
}

function convertDisplayUnitToMtString(raw: string, unit: FieldDisplayUnit): string {
  if (unit === "mT") return raw;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return raw;
  const tesla = parsed * hysteresisFieldUnitScaleToTesla(unit);
  return Number((tesla * 1e3).toPrecision(7)).toString();
}

function createFallbackKernel(selection: InspectorPanelProps["selection"]): KernelApi {
  return {
    commands: {
      execute: () => Promise.resolve({ status: "completed" }),
      getSessionScopeKey: () => "fallback",
      refresh: () => undefined,
    },
    selection: {
      clear: () => undefined,
      get: () => selection,
      set: () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as KernelApi;
}

function deriveLoopMetrics(points: readonly HysteresisPointSchema[]) {
  if (points.length < 2) return null;
  let minHc: number | null = null;
  let maxHc: number | null = null;
  let mrPos: number | null = null;
  let mrNeg: number | null = null;
  let maxChi = 0;
  let loopArea = 0;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const dH = curr.field_value_mT - prev.field_value_mT;
    const dM = curr.m_parallel - prev.m_parallel;

    // Coercive field zero-crossing interpolation (m_parallel = 0)
    if (prev.m_parallel * curr.m_parallel <= 0 && prev.m_parallel !== curr.m_parallel) {
      const frac = Math.abs(prev.m_parallel) / Math.abs(dM);
      const hc = prev.field_value_mT + frac * dH;
      if (hc < 0) minHc = minHc === null ? hc : Math.min(minHc, hc);
      else maxHc = maxHc === null ? hc : Math.max(maxHc, hc);
    }

    // Remanence zero-crossing linear interpolation (H = 0)
    if (Math.abs(curr.field_value_mT) < 1e-6) {
      if (dH <= 0 && mrPos === null) mrPos = Math.abs(curr.m_parallel);
      if (dH > 0 && mrNeg === null) mrNeg = Math.abs(curr.m_parallel);
    } else if (prev.field_value_mT * curr.field_value_mT < 0 && Math.abs(dH) > 1e-12) {
      const fracH = Math.abs(prev.field_value_mT) / Math.abs(dH);
      const mrInterp = prev.m_parallel + fracH * dM;
      if (dH < 0 && mrPos === null) mrPos = Math.abs(mrInterp);
      else if (dH > 0 && mrNeg === null) mrNeg = Math.abs(mrInterp);
    }

    if (Math.abs(dH) > 1e-9) {
      const chi = Math.abs(dM / dH);
      if (chi > maxChi) maxChi = chi;
    }
    loopArea += 0.5 * (prev.m_parallel + curr.m_parallel) * dH;
  }

  const remanence =
    mrPos !== null && mrNeg !== null
      ? 0.5 * (mrPos + mrNeg)
      : (mrPos ?? mrNeg);
  const exchangeBiasMt =
    minHc !== null && maxHc !== null ? 0.5 * (minHc + maxHc) : null;

  return {
    exchangeBiasMt,
    loopAreaMt: Math.abs(loopArea),
    maxChiPerMt: maxChi > 0 ? maxChi : null,
    maxHc,
    minHc,
    mrNeg,
    mrPos,
    remanence,
  };
}

export function HysteresisStageInspectorPanel({
  initialDraft,
  selection,
}: InspectorPanelProps & { initialDraft?: StudyStageDraft }) {
  const kernelFromCtx = useContext(KernelContext);
  if (kernelFromCtx && !initialDraft) {
    return <ConnectedHysteresisStageInspectorPanel selection={selection} />;
  }
  return (
    <HysteresisStageInspectorPanelView
      initialDraft={initialDraft}
      selection={selection}
    />
  );
}

function ConnectedHysteresisStageInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    executeSelectedStage,
    executeStudyCommand,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
    sessionScopeKey,
  } = useKernelStudyAuthoring(selection);
  const hydratedDraft = useMemo(() => {
    if (selectedStageDraft && selectedStageDraft.kind === "hysteresis") {
      return {
        ...selectedStageDraft,
        stageEnabled: selectedStageDraft.stageEnabled ?? true,
      };
    }
    const fallback = createDefaultStudyStageDraft("hysteresis", selectedStageIndex);
    return { ...fallback, stageEnabled: fallback.stageEnabled ?? true };
  }, [selectedStageDraft, selectedStageIndex]);

  const validationContext = useMemo<HysteresisValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities?.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities?.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities?.active_lane,
      runtimeStatus?.capabilities?.algorithms_available,
    ],
  );

  return (
    <HysteresisStageInspectorPanelView
      algorithmsAvailable={runtimeStatus?.capabilities?.algorithms_available}
      hydratedDraft={hydratedDraft}
      lastAuthoringError={lastAuthoringError}
      pipelineStripSteps={pipelineStripSteps}
      sceneData={sceneData}
      sceneRevision={sceneRevision}
      selectedStageIndex={selectedStageIndex}
      selection={selection}
      sessionScopeKey={sessionScopeKey}
      validationContext={validationContext}
      onCommitStage={(nextDraft) =>
        commitSelectedStageDraft(() => nextDraft, "hysteresis")
      }
      onExecuteCommand={executeStudyCommand}
      onRunStage={(id, initialChoice) =>
        executeSelectedStage(id, initialChoice, "hysteresis")
      }
    />
  );
}

function HysteresisStageInspectorPanelView({
  algorithmsAvailable,
  hydratedDraft,
  initialDraft,
  lastAuthoringError = null,
  onCommitStage,
  onExecuteCommand,
  onRunStage,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selectedStageIndex = 0,
  selection,
  sessionScopeKey = null,
  validationContext,
}: InspectorPanelProps & {
  algorithmsAvailable?: readonly string[];
  hydratedDraft?: StudyStageDraft;
  initialDraft?: StudyStageDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: StudyStageDraft) => Promise<boolean>;
  onExecuteCommand?: (commandId: string, input?: Record<string, unknown>) => Promise<void>;
  onRunStage?: (stageId: string, initialState?: StageInitialStateChoice) => Promise<void>;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  selectedStageIndex?: number;
  sessionScopeKey?: string | null;
  validationContext?: HysteresisValidationContext;
}) {
  const kernelFromCtx = useContext(KernelContext);
  const kernel = useMemo(
    () => kernelFromCtx ?? createFallbackKernel(selection),
    [kernelFromCtx, selection],
  );
  const stageId =
    selection.ref?.type === "study-stage"
      ? selection.ref.stageId
      : hydratedDraft?.stageId || initialDraft?.stageId || "hyst_1";

  const [localBaseline, setLocalBaseline] = useState<StudyStageDraft>(() => {
    const base =
      hydratedDraft ?? initialDraft ?? createDefaultStudyStageDraft("hysteresis", 0);
    return { ...base, stageId: base.stageId || stageId };
  });
  const baseline = useMemo(
    () =>
      hydratedDraft
        ? { ...hydratedDraft, stageId: hydratedDraft.stageId || stageId }
        : localBaseline,
    [hydratedDraft, localBaseline, stageId],
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<number>>(() => new Set());
  const [liveSheetPoints, setLiveSheetPoints] = useState<readonly HysteresisPointSchema[]>([]);
  const [fieldUnit, setFieldUnit] = useState<FieldDisplayUnit>("mT");
  const [launchInitialState, setLaunchInitialState] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });

  const runCommand = useCallback(
    async (commandId: string, input?: Record<string, unknown>) => {
      if (onExecuteCommand) {
        await onExecuteCommand(commandId, input);
        return;
      }
      await kernel.commands.execute(
        commandId,
        buildStudyCommandContext(kernel, { sceneData }),
        input,
      );
    },
    [kernel, onExecuteCommand, sceneData],
  );

  const handleToggleBookmark = useCallback(
    (point: HysteresisPointSchema) => {
      setBookmarkedIds((prev) => {
        const next = new Set(prev);
        if (next.has(point.point_id)) next.delete(point.point_id);
        else next.add(point.point_id);
        return next;
      });
      void runCommand("hysteresis.bookmark-point", { point, stageId });
    },
    [runCommand, stageId],
  );

  const handleOpenDiagnosticSheetFromHeader = useCallback(async () => {
    if (liveSheetPoints.length === 0 && kernelFromCtx) {
      const pointsFn = kernelFromCtx.api?.analysis?.hysteresis?.points;
      if (typeof pointsFn === "function") {
        try {
          const reqOpts = sessionScopeKey ? { sessionScopeKey } : undefined;
          const fetched = await pointsFn(stageId, reqOpts);
          if (Array.isArray(fetched?.points)) {
            setLiveSheetPoints(fetched.points);
          }
        } catch {
          // Best-effort hydration before Live tab mounts
        }
      }
    }
    setSheetOpen(true);
  }, [kernelFromCtx, liveSheetPoints.length, sessionScopeKey, stageId]);

  const spec = useMemo<InspectorSpec<StudyStageDraft>>(() => {
    return {
      id: `study.stage.hysteresis:${stageId}`,
      header: {
        breadcrumbs: [
          {
            id: "study",
            label: "Study",
            selection: {
              kind: "study.root",
              label: "Study",
              nodeId: "model:study",
              objectId: null,
              ref: { kind: "study.root", nodeId: "model:study", type: "study" },
            },
          },
          {
            id: "stages",
            label: "Stages",
            selection: {
              kind: "study.stages",
              label: "Stages",
              nodeId: "model:study:stages",
              objectId: null,
              ref: { kind: "study.stages", nodeId: "model:study:stages", type: "study" },
            },
          },
          { id: stageId, label: selection.label || "Hysteresis 1" },
        ],
        searchable: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline)) {
              const errs = validateStudyStageDraft(
                ctx.draft,
                validationContext,
              ).filter((i) => i.severity === "error");
              if (errs.length > 0) return;
              if (onCommitStage) {
                const saved = await onCommitStage(ctx.draft);
                if (saved === false) return;
              }
              setLocalBaseline(ctx.draft);
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId || stageId, launchInitialState);
              return;
            }
            await runCommand("study.run");
          },
        },
        extraMenuActions: [
          {
            id: "open-diagnostic-sheet",
            label: "Open Full 15-Column Diagnostic Sheet…",
            icon: Table2,
            onSelect: () => {
              void handleOpenDiagnosticSheetFromHeader();
            },
          },
        ],
      },
      identity: {
        domain: "study",
        icon: Magnet,
        title: (d) => selection.label || d.stageId || "Hysteresis 1",
        kindLabel: "Quasi-static field sweep",
        entityId: stageId,
        statePill: (d) => {
          const errs = validateStudyStageDraft(d, validationContext).filter(
            (i) => i.severity === "error",
          );
          return errs.length > 0
            ? { tone: "err", label: `${errs.length} issues` }
            : { tone: "ok", label: "Ready" };
        },
      },
      facts: (d) => {
        const steps = parseHysteresisSettleSteps(d.settleSteps, d.stageId);
        const primary = steps[0];
        return [
          { id: "protocol", label: "Protocol", value: d.protocolKind || "major_loop" },
          {
            id: "range",
            label: "Range",
            value: `${d.fieldMinMt || "-200"} to ${d.fieldMaxMt || "200"} mT`,
          },
          { id: "step", label: "Step", value: `${d.fieldStepMt || "5"} mT` },
          {
            id: "solver",
            label: "Step solver",
            value: `${primary?.kind ?? "relax"} · ${primary?.method ?? "llg_overdamped"}`,
          },
        ];
      },
      modeTabs: [
        { id: "authoring", label: "Authoring" },
        {
          id: "live",
          label: "Live & Results",
          commitModeOverride: "readOnly",
        },
      ],
      notices: (d): readonly InspectorNotice<StudyStageDraft>[] => {
        const list: InspectorNotice<StudyStageDraft>[] = validateStudyStageDraft(
          d,
          validationContext,
        ).map((item, idx) => ({
          id: `hyst-issue-${idx}`,
          tone: item.severity === "error" ? "err" : "warn",
          text: item.message,
        }));
        if (lastAuthoringError) {
          list.unshift({
            id: "hyst-authoring-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline",
          title: "Pipeline",
          icon: Workflow,
          modeTabId: "authoring",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Order",
              wide: true,
              render: ({ draft, selectNode }) => (
                <PipelineStrip
                  currentIndex={selectedStageIndex}
                  steps={
                    pipelineStripSteps && pipelineStripSteps.length > 0
                      ? pipelineStripSteps
                      : [
                          {
                            id: stageId,
                            index: 0,
                            kind: "study.stage.hysteresis",
                            label: draft.stageId || "Hysteresis 1",
                          },
                        ]
                  }
                  onSelectStep={(step) => {
                    if (step.selection) selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              type: "text",
              key: "stageId",
              label: "Stage ID",
              mono: true,
              disabledReason: (d) =>
                d.pipelineNodeId
                  ? "Canonical pipeline stage IDs are immutable."
                  : null,
            },
            {
              type: "switch",
              key: "stageEnabled",
              label: "Include in study",
            },
            {
              type: "custom",
              label: "Launch initial state",
              wide: true,
              render: ({ draft }) => (
                <StageInitialStateRadixControl
                  choice={launchInitialState}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernelFromCtx?.savedResultsPlayback
                      ? (result) =>
                          kernelFromCtx.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={draft.stageId || stageId}
                  onChange={setLaunchInitialState}
                />
              ),
            },
          ],
        },
        {
          id: "protocol-initial",
          title: "Protocol & Initial State",
          icon: Compass,
          modeTabId: "authoring",
          defaultOpen: true,
          rows: [
            {
              type: "select",
              key: "protocolKind",
              label: "Loop protocol",
              structural: true,
              options: [
                { value: "major_loop", label: "Major loop (+H -> -H -> +H)" },
                { value: "major_with_minor_loops", label: "Major with minor loops" },
                { value: "virgin_curve", label: "Virgin curve (0 -> +H)" },
                { value: "virgin_then_major_loop", label: "Virgin + major loop" },
              ],
            },
            {
              type: "select",
              key: "initialStatePolicy",
              label: "Initial state policy",
              structural: true,
              options: [
                { value: "as_authored", label: "Preceding stage / authored m0" },
                { value: "zero_field_relaxed", label: "Relax at B = 0 first" },
                { value: "positive_saturation", label: "Positive saturation (+H)" },
                { value: "negative_saturation", label: "Negative saturation (-H)" },
                { value: "checkpoint", label: "Pinned checkpoint" },
              ],
            },
            {
              type: "text",
              key: "initialStateRef",
              label: "Checkpoint reference",
              showWhen: (d) => d.initialStatePolicy === "checkpoint",
            },
            {
              type: "custom",
              label: "Minor loops",
              wide: true,
              showWhen: (d) => d.protocolKind === "major_with_minor_loops",
              render: ({ draft, patchDraft }) => (
                <HysteresisMinorLoopsEditor draft={draft} onUpdate={patchDraft} />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    label: "Texture overrides",
                    wide: true,
                    render: ({
                      draft,
                      patchDraft,
                    }: {
                      draft: StudyStageDraft;
                      patchDraft: (p: Partial<StudyStageDraft>) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={draft.stageMagnetizationAssignments}
                        onChange={(stageMagnetizationAssignments) =>
                          patchDraft({ stageMagnetizationAssignments })
                        }
                      />
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "orientation-axis",
          title: "Field Orientation & Measurement Axis",
          icon: Radar,
          modeTabId: "authoring",
          defaultOpen: true,
          rows: [
            {
              type: "segmented",
              key: "orientationMode",
              label: "Orientation mode",
              structural: true,
              options: [
                { value: "preset", label: "Preset" },
                { value: "sample", label: "Angles" },
                { value: "global", label: "Vector 3D" },
              ],
            },
            {
              type: "select",
              key: "customDirection",
              label: "Field axis preset",
              showWhen: (d) => (d.orientationMode || "preset") === "preset",
              options: [
                { value: "in_plane_x", label: "In-plane +x" },
                { value: "in_plane_y", label: "In-plane +y" },
                { value: "oop_positive", label: "Out-of-plane +z" },
                { value: "oop_negative", label: "Out-of-plane -z" },
              ],
            },
            {
              type: "text",
              key: "thetaDeg",
              label: "Polar angle (deg)",
              showWhen: (d) => d.orientationMode === "sample",
            },
            {
              type: "text",
              key: "phiDeg",
              label: "Azimuthal angle (deg)",
              showWhen: (d) => d.orientationMode === "sample",
            },
            {
              type: "text",
              key: "customDirection",
              label: "Global field vector (x, y, z)",
              mono: true,
              placeholder: "0, 0, 1",
              showWhen: (d) => d.orientationMode === "global",
            },
            {
              type: "select",
              key: "measurementAxis",
              label: "Measurement axis",
              structural: true,
              options: [
                { value: "field_axis", label: "Along applied field" },
                { value: "sample_normal", label: "Sample normal (+z)" },
                { value: "easy_axis", label: "Primary easy axis" },
                { value: "custom", label: "Custom projection vector" },
              ],
            },
            {
              type: "text",
              key: "measurementAxisCustomVector",
              label: "Custom measurement vector",
              mono: true,
              placeholder: "1, 0, 0",
              showWhen: (d) => d.measurementAxis === "custom",
            },
          ],
        },
        {
          id: "field-schedule",
          title: "Field Schedule, Saturation & Windows",
          icon: Activity,
          modeTabId: "authoring",
          defaultOpen: true,
          rows: [
            {
              type: "segmented",
              key: "fieldScheduleMode",
              label: "Schedule mode",
              structural: true,
              options: [
                { value: "simple", label: "Uniform range" },
                { value: "piecewise", label: "Piecewise segments" },
              ],
            },
            {
              type: "custom",
              label: "Uniform field bounds",
              wide: true,
              showWhen: (d) => (d.fieldScheduleMode || "simple") === "simple",
              render: ({ draft, patchDraft }) => (
                <div className="grid gap-2 text-xs">
                  <div className="fm-inspector-row" data-layout="inline">
                    <span className="fm-inspector-row__label">Field display unit</span>
                    <div className="fm-inspector-row__control">
                      <SegmentedControl
                        aria-label="Hysteresis field unit"
                        options={[
                          { value: "mT", label: "mT" },
                          { value: "T", label: "T" },
                          { value: "Oe", label: "Oe" },
                          { value: "kA/m", label: "kA/m" },
                        ]}
                        value={fieldUnit}
                        onValueChange={(next) => setFieldUnit(next as FieldDisplayUnit)}
                      />
                    </div>
                  </div>
                  <div className="fm-inspector-row" data-layout="inline">
                    <span className="fm-inspector-row__label">
                      Minimum field ({fieldUnit})
                    </span>
                    <div className="fm-inspector-row__control">
                      <Input
                        aria-label={`Minimum field (${fieldUnit})`}
                        className="h-fm-control-sm font-mono"
                        value={formatMtInDisplayUnit(draft.fieldMinMt, fieldUnit)}
                        onChange={(e) =>
                          patchDraft({
                            fieldMinMt: convertDisplayUnitToMtString(
                              e.target.value,
                              fieldUnit,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="fm-inspector-row" data-layout="inline">
                    <span className="fm-inspector-row__label">
                      Maximum field ({fieldUnit})
                    </span>
                    <div className="fm-inspector-row__control">
                      <Input
                        aria-label={`Maximum field (${fieldUnit})`}
                        className="h-fm-control-sm font-mono"
                        value={formatMtInDisplayUnit(draft.fieldMaxMt, fieldUnit)}
                        onChange={(e) =>
                          patchDraft({
                            fieldMaxMt: convertDisplayUnitToMtString(
                              e.target.value,
                              fieldUnit,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="fm-inspector-row" data-layout="inline">
                    <span className="fm-inspector-row__label">
                      Field step ({fieldUnit})
                    </span>
                    <div className="fm-inspector-row__control">
                      <Input
                        aria-label={`Field step (${fieldUnit})`}
                        className="h-fm-control-sm font-mono"
                        value={formatMtInDisplayUnit(draft.fieldStepMt, fieldUnit)}
                        onChange={(e) =>
                          patchDraft({
                            fieldStepMt: convertDisplayUnitToMtString(
                              e.target.value,
                              fieldUnit,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              ),
            },
            {
              type: "custom",
              label: "Piecewise segments",
              wide: true,
              showWhen: (d) => d.fieldScheduleMode === "piecewise",
              render: ({ draft, patchDraft }) => (
                <HysteresisFieldSegmentsEditor draft={draft} onUpdate={patchDraft} />
              ),
            },
            {
              type: "custom",
              label: "Dense refinement windows",
              wide: true,
              render: ({ draft, patchDraft }) => (
                <HysteresisDenseWindowsEditor draft={draft} onUpdate={patchDraft} />
              ),
            },
            {
              type: "segmented",
              key: "saturationMode",
              label: "Saturation policy",
              structural: true,
              options: [
                { value: "none", label: "Fixed bounds" },
                { value: "auto", label: "Auto saturation stop" },
              ],
            },
            {
              type: "text",
              key: "maxProbeField",
              label: "Max probe field (mT)",
              mono: true,
              showWhen: (d) => d.saturationMode === "auto",
            },
            {
              type: "text",
              key: "saturationThresholds",
              label: "Saturation thresholds",
              mono: true,
              showWhen: (d) => d.saturationMode === "auto",
            },
          ],
        },
        {
          id: "step-solver",
          title: "Step Solver & Settle Pipeline",
          icon: Gauge,
          modeTabId: "authoring",
          defaultOpen: true,
          rows: [
            {
              type: "segmented",
              key: "settlePipelineMode",
              label: "Pipeline topology",
              structural: true,
              options: [
                { value: "sequence", label: "Sequential chain" },
                { value: "tree", label: "Fallback tree" },
              ],
            },
            {
              type: "custom",
              label: "Step solvers",
              wide: true,
              render: ({ draft, patchDraft }) => (
                <HysteresisSettleAlgorithmsEditor
                  algorithmsAvailable={algorithmsAvailable}
                  draft={draft}
                  onUpdate={patchDraft}
                />
              ),
            },
            {
              type: "custom",
              label: "Fallback branches",
              wide: true,
              showWhen: (d) => d.settlePipelineMode === "tree",
              render: ({ draft, patchDraft }) => (
                <HysteresisSettleBranchesEditor draft={draft} onUpdate={patchDraft} />
              ),
            },
            {
              type: "text",
              key: "torqueTolerance",
              label: "Stage torque tolerance (A/m)",
              mono: true,
            },
          ],
        },
        {
          id: "storage-policy",
          title: "Snapshot Storage Policy",
          icon: Database,
          modeTabId: "authoring",
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              label: "Magnetization snapshots",
              wide: true,
              render: ({ draft, patchDraft }) => {
                const storageRec = parseStoragePolicyRecord(draft.storagePolicy);
                const mode = String(storageRec.magnetization ?? "key_events");
                const updateStorage = (patch: Record<string, unknown>) =>
                  patchDraft({
                    storagePolicy: JSON.stringify({ ...storageRec, ...patch }),
                  });
                return (
                  <div className="grid gap-2 text-xs">
                    <div className="fm-inspector-row" data-layout="inline">
                      <span className="fm-inspector-row__label">
                        Snapshot storage mode
                      </span>
                      <div className="fm-inspector-row__control">
                        <Select
                          value={mode}
                          onValueChange={(magnetization) =>
                            updateStorage({
                              magnetization,
                              ...(magnetization === "every_n" ||
                              magnetization === "selected"
                                ? { every_n: Number(storageRec.every_n ?? 5) || 5 }
                                : {}),
                            })
                          }
                        >
                          <SelectTrigger
                            aria-label="Snapshot storage mode"
                            density="compact"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              None (scalar table only)
                            </SelectItem>
                            <SelectItem value="key_events">
                              Key events (Hc &amp; Mr)
                            </SelectItem>
                            <SelectItem value="selected">Selected cadence</SelectItem>
                            <SelectItem value="every_n">Every N points</SelectItem>
                            <SelectItem value="every_step">
                              Every field point
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {mode === "key_events" ? (
                      <div className="fm-inspector-row" data-layout="inline">
                        <span className="fm-inspector-row__label">
                          Key event |Δm| threshold
                        </span>
                        <div className="fm-inspector-row__control">
                          <Input
                            aria-label="Key event threshold dm"
                            className="h-fm-control-sm font-mono"
                            value={String(storageRec.key_event_threshold_dm ?? 0.05)}
                            onChange={(e) => {
                              const parsed = Number(e.target.value.trim());
                              updateStorage({
                                key_event_threshold_dm: Number.isFinite(parsed)
                                  ? parsed
                                  : e.target.value,
                              });
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {mode === "every_n" || mode === "selected" ? (
                      <div className="fm-inspector-row" data-layout="inline">
                        <span className="fm-inspector-row__label">
                          Snapshot cadence N
                        </span>
                        <div className="fm-inspector-row__control">
                          <Input
                            aria-label="Snapshot cadence N"
                            className="h-fm-control-sm font-mono"
                            value={String(storageRec.every_n ?? 5)}
                            onChange={(e) => {
                              const parsed = Number(e.target.value.trim());
                              updateStorage({
                                every_n: Number.isFinite(parsed)
                                  ? parsed
                                  : e.target.value,
                              });
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              },
            },
            {
              type: "switch",
              key: "storageEstimateAcknowledged",
              label: "Acknowledge large Zarr storage",
            },
            {
              type: "custom",
              label: "Stage autosave",
              wide: true,
              render: ({ draft, patchDraft }) => (
                <StageAutosaveRadixEditor
                  draft={draft.stageAutosave}
                  owner="run"
                  onChange={(stageAutosave) => patchDraft({ stageAutosave })}
                />
              ),
            },
          ],
        },
        {
          id: "live-loop",
          title: "Loop Curve, Metrics & Field Points",
          icon: Sparkles,
          modeTabId: "live",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Live sweep",
              wide: true,
              render: () => (
                <HysteresisLiveResultsWithSheetSync
                  bookmarkedIds={bookmarkedIds}
                  kernel={kernel}
                  stageId={stageId}
                  onExecuteCommand={runCommand}
                  onOpenSheet={(pts) => {
                    setLiveSheetPoints(pts);
                    setSheetOpen(true);
                  }}
                  onToggleBookmark={handleToggleBookmark}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (d) => {
          const errs = validateStudyStageDraft(d, validationContext).filter(
            (i) => i.severity === "error",
          );
          if (errs.length > 0) return false;
          studyStageDraftToSceneStage(d);
          if (onCommitStage) {
            const committed = await onCommitStage(d);
            if (!committed) return false;
          }
          setLocalBaseline(d);
          return true;
        },
      },
    };
  }, [
    algorithmsAvailable,
    bookmarkedIds,
    fieldUnit,
    handleOpenDiagnosticSheetFromHeader,
    handleToggleBookmark,
    kernel,
    kernelFromCtx,
    lastAuthoringError,
    launchInitialState,
    onCommitStage,
    onRunStage,
    pipelineStripSteps,
    runCommand,
    sceneData,
    sceneRevision,
    selectedStageIndex,
    selection.label,
    stageId,
    validationContext,
  ]);

  return (
    <>
      <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />
      <HysteresisDiagnosticTableSheet
        open={sheetOpen}
        points={liveSheetPoints}
        stageId={stageId}
        onBookmarkPoint={(pt) => handleToggleBookmark(pt)}
        onExportCsv={(pts) => {
          void runCommand("hysteresis.export-loop-csv", {
            points: pts,
            stageId,
          });
        }}
        onLoadPointIn3D={(pt) => {
          void runCommand(
            "hysteresis.load-point-in-3d",
            buildHysteresisLoadPointIn3DInput({
              point: pt,
              stageId,
              targetMetadata: {},
              yAxisKey: "m_parallel",
            }) as unknown as Record<string, unknown>,
          );
        }}
        onOpenChange={setSheetOpen}
        onUsePointAsInitialState={(pt) => {
          void runCommand("hysteresis.use-point-as-initial-state", {
            snapshotArtifactRef: pt.snapshot_json_artifact_ref ?? null,
            snapshotId: pt.snapshot_id ?? null,
            snapshotResourceRef: pt.snapshot_resource_ref ?? null,
            stageId,
          });
        }}
      />
    </>
  );
}

function HysteresisLiveResultsWithSheetSync({
  bookmarkedIds,
  kernel,
  onExecuteCommand,
  onOpenSheet,
  onToggleBookmark,
  stageId,
}: {
  bookmarkedIds: ReadonlySet<number>;
  kernel: KernelApi;
  onExecuteCommand: (commandId: string, input?: Record<string, unknown>) => Promise<void>;
  onOpenSheet: (points: readonly HysteresisPointSchema[]) => void;
  onToggleBookmark: (point: HysteresisPointSchema) => void;
  stageId: string;
}) {
  // Hook #1 + Hook #2 ONLY when Live & Results tab is active (<= 2 HTTP hooks total!)
  const pointsRes = useHysteresisPointsResource(stageId, { enabled: Boolean(stageId) });
  const progressRes = useHysteresisProgressResource(stageId, { enabled: Boolean(stageId) });
  const [bucket, setBucket] = useState<PointFilterBucket>("all");

  const points = useMemo(
    () => (Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : []),
    [pointsRes.data],
  );
  const filteredPoints = useMemo(() => {
    if (bucket === "snapshots") return points.filter((pt) => Boolean(pt.snapshot_id));
    if (bucket === "bookmarks") return points.filter((pt) => bookmarkedIds.has(pt.point_id));
    return points;
  }, [bookmarkedIds, bucket, points]);

  const derivedMetrics = useMemo(() => deriveLoopMetrics(points), [points]);

  const handleLoadPointIn3D = useCallback(
    (pt: HysteresisPointSchema) => {
      void onExecuteCommand(
        "hysteresis.load-point-in-3d",
        buildHysteresisLoadPointIn3DInput({
          point: pt,
          stageId,
          targetMetadata: {},
          yAxisKey: "m_parallel",
        }) as unknown as Record<string, unknown>,
      );
    },
    [onExecuteCommand, stageId],
  );

  return (
    <div className="grid gap-3">
      <HysteresisChart
        commandSource="inspector"
        data={{
          points,
          pointsRevision: pointsRes.revision ?? null,
          progress: progressRes.data ?? null,
        }}
        kernel={kernel}
        stageId={stageId}
      />

      <div className="flex flex-wrap gap-1.5">
        <Button
          disabled={points.length === 0}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            void onExecuteCommand("hysteresis.export-loop-csv", {
              points,
              stageId,
            })
          }
        >
          <Download size={13} aria-hidden="true" />
          <span>Export loop CSV</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            void onExecuteCommand("hysteresis.continue-to-next-stage", { stageId })
          }
        >
          <ArrowRight size={13} aria-hidden="true" />
          <span>Continue to next stage</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void onExecuteCommand("hysteresis.return-to-live", { stageId })}
        >
          <RotateCcw size={13} aria-hidden="true" />
          <span>Return to live</span>
        </Button>
      </div>

      <div className="rounded border border-fm-border p-2.5 grid gap-1.5 text-xs">
        <div className="font-medium flex items-center gap-1.5">
          <Sigma size={14} aria-hidden="true" />
          <span>Coercivity &amp; Loop Metrics</span>
        </div>
        {points.length === 0 ? (
          <EmptyState
            description="Run the hysteresis sweep to measure coercive fields and remanence."
            heading="No sweep points recorded yet"
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 tabular-nums">
            <div>
              <span className="text-fm-muted block">Coercive field Hc- / Hc+</span>
              <span>
                {derivedMetrics?.minHc != null
                  ? `${derivedMetrics.minHc.toFixed(2)} mT`
                  : "—"}
                {" / "}
                {derivedMetrics?.maxHc != null
                  ? `+${derivedMetrics.maxHc.toFixed(2)} mT`
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-fm-muted block">Remanence |Mr/Ms|</span>
              <span>
                {derivedMetrics?.remanence != null
                  ? derivedMetrics.remanence.toFixed(4)
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-fm-muted block">Exchange bias H_eb</span>
              <span>
                {derivedMetrics?.exchangeBiasMt != null
                  ? `${derivedMetrics.exchangeBiasMt.toFixed(2)} mT`
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-fm-muted block">Loop area &amp; max χ</span>
              <span>
                {derivedMetrics?.loopAreaMt != null
                  ? `${derivedMetrics.loopAreaMt.toFixed(2)} mT`
                  : "—"}
                {derivedMetrics?.maxChiPerMt != null
                  ? ` · ${derivedMetrics.maxChiPerMt.toFixed(4)} /mT`
                  : ""}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="rounded border border-fm-border p-2.5 grid gap-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium flex items-center gap-1.5">
            <Table2 size={14} aria-hidden="true" />
            <span>Field Points ({filteredPoints.length})</span>
          </span>
          <SegmentedControl
            aria-label="Filter hysteresis points"
            options={[
              { value: "all", label: `All (${points.length})` },
              {
                value: "snapshots",
                label: `3D (${points.filter((p) => Boolean(p.snapshot_id)).length})`,
              },
              { value: "bookmarks", label: `Pins (${bookmarkedIds.size})` },
            ]}
            value={bucket}
            onValueChange={(val) => setBucket(val as PointFilterBucket)}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums border-collapse">
            <thead>
              <tr className="border-b border-fm-border text-fm-muted">
                <th className="py-1 px-1.5">mu0 H (mT)</th>
                <th className="py-1 px-1.5">m_parallel</th>
                <th className="py-1 px-1.5">Branch</th>
                <th className="py-1 px-1.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPoints.slice(0, 25).map((pt) => (
                <tr
                  className="border-b border-fm-border-subtle"
                  key={pt.point_id}
                  onDoubleClick={() => onToggleBookmark(pt)}
                >
                  <td className="py-1 px-1.5">{pt.field_value_mT.toFixed(1)}</td>
                  <td className="py-1 px-1.5">{pt.m_parallel.toFixed(4)}</td>
                  <td className="py-1 px-1.5 truncate max-w-[72px]">
                    {pt.branch_id ?? "major"}
                  </td>
                  <td className="py-1 px-1.5">
                    <div className="flex items-center gap-1">
                      <Button
                        aria-label={`Load point ${pt.point_id} snapshot in 3D`}
                        disabled={!pt.snapshot_id}
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() => handleLoadPointIn3D(pt)}
                      >
                        <Box size={12} aria-hidden="true" />
                      </Button>
                      <Button
                        aria-label={`Compare point ${pt.point_id}`}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          void onExecuteCommand("hysteresis.compare-point", {
                            point: pt,
                            stageId,
                          })
                        }
                      >
                        <GitCommit size={12} aria-hidden="true" />
                      </Button>
                      <Button
                        aria-label={`Bookmark point ${pt.point_id}`}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => onToggleBookmark(pt)}
                      >
                        <Bookmark size={12} aria-hidden="true" />
                      </Button>
                      <Button
                        aria-label={`Export point ${pt.point_id} CSV`}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          void onExecuteCommand("hysteresis.export-point-csv", {
                            point: pt,
                            stageId,
                          })
                        }
                      >
                        <Download size={12} aria-hidden="true" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onOpenSheet(points)}
        >
          Open Full 15-Column Diagnostic Sheet…
        </Button>
      </div>
    </div>
  );
}

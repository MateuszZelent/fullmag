"use client";

import { Compass, Radar, Workflow } from "lucide-react";
import { useContext, useMemo } from "react";

import type { JsonObject, JsonValue } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorSectionSpec, InspectorSpec } from "../../../template";
import {
  PipelineStrip,
  type PipelineStripStep,
} from "../../../panels/study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import {
  summarizeMaskFieldDriveStage,
} from "../../../panels/stages/maskFieldDriveStageSummary";
import { StageSpecHost } from "../../../panels/stages/StageSharedControls";
import { stageBreadcrumbs, resolveStageMeta, fallbackPipelineSteps } from "./stageShared";
interface MaskFieldDriveTermView {
  readonly label: string;
  readonly maskCall: string;
  readonly maskParameters: string | null;
  readonly maskOutputs: readonly string[];
  readonly timeCall: string;
  readonly timeParameters: string | null;
  readonly timeOutputs: readonly string[];
}

interface MaskFieldDriveDraft {
  stageId: string;
  stageEnabled: boolean;
  actionKind: "add" | "update";
  driveId: string;
  driveName: string;
  target: string;
  shape: string;
  frame: string;
  timeOrigin: string;
  termLabel: string;
  maskParameters: string;
  timeParameters: string;
  terms: readonly MaskFieldDriveTermView[];
}

function extractRawFunctionParameters(fnRecord: unknown): string | null {
  if (!fnRecord || typeof fnRecord !== "object" || Array.isArray(fnRecord)) {
    return null;
  }
  const params = (fnRecord as Record<string, unknown>).parameters;
  if (!Array.isArray(params) || params.length === 0) return null;
  const formatted = params.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const rec = entry as Record<string, unknown>;
    return [`${String(rec.name ?? "")} = ${String(rec.value ?? "")}`];
  });
  return formatted.length > 0 ? formatted.join(", ") : null;
}

function extractMaskTermParameterDetails(
  rawStage: Record<string, unknown> | undefined,
): Array<{ maskParams: string | null; timeParams: string | null }> {
  if (!rawStage) return [];
  const payload =
    rawStage.payload &&
    typeof rawStage.payload === "object" &&
    !Array.isArray(rawStage.payload)
      ? (rawStage.payload as Record<string, unknown>)
      : rawStage;
  const drive =
    payload.drive && typeof payload.drive === "object" && !Array.isArray(payload.drive)
      ? (payload.drive as Record<string, unknown>)
      : null;
  const terms = Array.isArray(drive?.terms) ? drive.terms : [];
  return terms.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { maskParams: null, timeParams: null };
    }
    const term = entry as Record<string, unknown>;
    const mask =
      term.mask && typeof term.mask === "object" && !Array.isArray(term.mask)
        ? (term.mask as Record<string, unknown>)
        : null;
    return {
      maskParams: mask?.kind === "function" ? extractRawFunctionParameters(mask.function) : null,
      timeParams: extractRawFunctionParameters(term.time),
    };
  });
}

export function MaskFieldDriveStageInspectorPanel({
  selection,
  rawStagePayload,
}: InspectorPanelProps & {
  rawStagePayload?: Record<string, unknown>;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !rawStagePayload) {
    return <ConnectedMaskFieldDriveStagePanel selection={selection} />;
  }
  return (
    <MaskFieldDriveStageInspectorPanelView
      rawStagePayload={rawStagePayload}
      selection={selection}
    />
  );
}

function ConnectedMaskFieldDriveStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitStudyMetadata,
    lastAuthoringError,
    pipelineStripSteps,
    sceneData,
    selectedStageDraft,
  } = useKernelStudyAuthoring(selection);
  const pipelineNodeId = selectedStageDraft?.pipelineNodeId;

  return (
    <MaskFieldDriveStageInspectorPanelView
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      rawStagePayload={selectedStageDraft?.rawStage}
      selection={selection}
      stageEnabledFromScene={selectedStageDraft?.stageEnabled}
      stageIdFromScene={selectedStageDraft?.stageId}
      onCommitStage={
        pipelineNodeId
          ? async (draft) => {
              const study =
                sceneData?.study && typeof sceneData.study === "object"
                  ? (sceneData.study as Record<string, unknown>)
                  : null;
              const pipeline =
                study?.study_pipeline && typeof study.study_pipeline === "object"
                  ? (study.study_pipeline as Record<string, unknown>)
                  : null;
              if (!pipeline || !Array.isArray(pipeline.nodes)) return false;
              const patchNodes = (nodes: JsonValue[]): JsonValue[] =>
                nodes.map((item) => {
                  if (!item || typeof item !== "object" || Array.isArray(item)) {
                    return item;
                  }
                  const rec = item as JsonObject;
                  if (rec.id === pipelineNodeId) {
                    return { ...rec, enabled: draft.stageEnabled };
                  }
                  if (rec.node_kind === "group" && Array.isArray(rec.children)) {
                    return { ...rec, children: patchNodes(rec.children) };
                  }
                  return rec;
                });
              return commitStudyMetadata({
                study_pipeline: {
                  ...pipeline,
                  nodes: patchNodes(pipeline.nodes as JsonValue[]),
                },
              });
            }
          : undefined
      }
    />
  );
}

function MaskFieldDriveStageInspectorPanelView({
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  rawStagePayload,
  selection,
  stageEnabledFromScene,
  stageIdFromScene,
}: InspectorPanelProps & {
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: MaskFieldDriveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  rawStagePayload?: Record<string, unknown>;
  stageEnabledFromScene?: boolean;
  stageIdFromScene?: string;
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "mask_drive");
  const stageId = stageIdFromScene ?? fallbackId;
  const summary = useMemo(
    () =>
      rawStagePayload
        ? summarizeMaskFieldDriveStage(rawStagePayload)
        : null,
    [rawStagePayload],
  );
  const termParamDetails = useMemo(
    () => extractMaskTermParameterDetails(rawStagePayload),
    [rawStagePayload],
  );

  const baseline = useMemo<MaskFieldDriveDraft>(() => {
    const mappedTerms: MaskFieldDriveTermView[] = summary
      ? summary.terms.map((t, idx) => ({
          label: t.label,
          maskCall: t.mask.call,
          maskParameters: termParamDetails[idx]?.maskParams ?? null,
          maskOutputs: t.mask.outputs,
          timeCall: t.time.call,
          timeParameters: termParamDetails[idx]?.timeParams ?? null,
          timeOutputs: t.time.outputs,
        }))
      : [
          {
            label: "term 0",
            maskCall: "not declared",
            maskParameters: null,
            maskOutputs: [],
            timeCall: "1 (static)",
            timeParameters: null,
            timeOutputs: [],
          },
        ];

    return {
      stageId,
      stageEnabled: stageEnabledFromScene ?? true,
      actionKind: summary?.action ?? "add",
      driveId: summary?.driveId ?? stageId,
      driveName: summary?.driveName ?? summary?.driveId ?? "Mask antenna drive",
      target: summary?.target ?? "not declared",
      shape: summary?.shape ?? "not declared",
      frame: summary?.frame ?? "local",
      timeOrigin: summary?.timeOrigin ?? "stage_local",
      termLabel: summary?.term ?? "the only term",
      maskParameters: summary?.maskParameters ?? "unchanged",
      timeParameters: summary?.timeParameters ?? "unchanged",
      terms: mappedTerms,
    };
  }, [stageEnabledFromScene, stageId, summary, termParamDetails]);

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.mask_field_drive",
            summary?.kindLabel ?? "Mask field drive",
          ),
    [index, pipelineStripSteps, stageId, summary?.kindLabel],
  );

  const titleLabel =
    summary?.kindLabel ? `${summary.kindLabel} ${index + 1}` : `Mask Field Drive ${index + 1}`;
  const canTogglePipelineNode = Boolean(pipelineNodeId && onCommitStage);

  const spec = useMemo<InspectorSpec<MaskFieldDriveDraft>>(() => {
    const termSections: InspectorSectionSpec<MaskFieldDriveDraft>[] =
      baseline.actionKind === "update"
        ? [
            {
              id: "antenna-update",
              title: "Antenna Parameter Update",
              icon: Radar,
              defaultOpen: true,
              rows: [
                {
                  label: "Antenna ID",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.driveId,
                },
                {
                  label: "Term",
                  type: "readonly",
                  format: (d) => d.termLabel,
                },
                {
                  label: "Mask values",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.maskParameters,
                },
                {
                  label: "Time values",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.timeParameters,
                },
                {
                  label: "Effect",
                  type: "readonly",
                  format: () =>
                    "Applies updated values from this stage onward; antenna definition remains unchanged",
                },
              ],
            },
          ]
        : [
            {
              id: "antenna-meta",
              title: "Mask Antenna Metadata",
              icon: Compass,
              defaultOpen: true,
              rows: [
                {
                  label: "Antenna ID",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.driveId,
                },
                { label: "Target", type: "readonly", format: (d) => d.target },
                { label: "Support", type: "readonly", format: (d) => d.shape },
                { label: "Frame", type: "readonly", format: (d) => d.frame },
                { label: "Clock", type: "readonly", format: (d) => d.timeOrigin },
                {
                  label: "Effect",
                  type: "readonly",
                  format: () => "Active from this stage until a Remove stage",
                },
              ],
            },
            ...baseline.terms.map(
              (term, termIdx): InspectorSectionSpec<MaskFieldDriveDraft> => ({
                id: `mask-term-${termIdx}`,
                title: `Term ${term.label} (Mask × Time)`,
                icon: Radar,
                defaultOpen: true,
                rows: [
                  {
                    label: "Mask",
                    type: "readonly",
                    mono: true,
                    format: () => term.maskCall,
                  },
                  ...(term.maskParameters
                    ? [
                        {
                          label: "Mask parameters",
                          type: "readonly" as const,
                          mono: true,
                          format: () => term.maskParameters,
                        },
                      ]
                    : []),
                  ...term.maskOutputs.map((output, compIdx) => ({
                    label: (["Bx(r)", "By(r)", "Bz(r)"][compIdx] ??
                      `B${compIdx}(r)`),
                    type: "readonly" as const,
                    mono: true,
                    format: () => `${output} T`,
                  })),
                  {
                    label: "Time",
                    type: "readonly",
                    mono: true,
                    format: () => term.timeCall,
                  },
                  ...(term.timeParameters
                    ? [
                        {
                          label: "Time parameters",
                          type: "readonly" as const,
                          mono: true,
                          format: () => term.timeParameters,
                        },
                      ]
                    : []),
                  ...term.timeOutputs.map((output, outIdx) => ({
                    label:
                      term.timeOutputs.length > 1
                        ? `f_${outIdx + 1}(t)`
                        : "f(t)",
                    type: "readonly" as const,
                    mono: true,
                    format: () => output,
                  })),
                ],
              }),
            ),
          ];

    return {
      id: "study.stage.mask_field_drive",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Radar,
        title: (d) => d.driveName,
        kindLabel: "Mask antenna pipeline instruction",
        entityId: baseline.driveId,
        statePill: () => ({ tone: "info", label: "Read-only 0 s" }),
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "act",
          label: "Action",
          value: d.actionKind === "update" ? "Update parameters" : "Add mask drive",
        },
        { id: "id", label: "Antenna ID", value: d.driveId },
        { id: "frame", label: "Frame", value: d.frame },
        { id: "clock", label: "Clock", value: d.timeOrigin },
      ],
      notices: () =>
        lastAuthoringError
          ? [{ id: "authoring-error", tone: "err", text: lastAuthoringError }]
          : [],
      sections: [
        {
          id: "pipeline",
          title: "Pipeline",
          icon: Workflow,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              label: "Stage ID",
              type: "readonly",
              mono: true,
              format: (d) => d.stageId,
            },
            ...(canTogglePipelineNode
              ? [
                  {
                    key: "stageEnabled" as const,
                    label: "Include pipeline node",
                    type: "switch" as const,
                  },
                ]
              : [
                  {
                    label: "Authoring mode",
                    type: "readonly" as const,
                    format: () => "Preserved losslessly (read-only)",
                  },
                ]),
          ],
        },
        ...termSections,
      ],
      commitBar: canTogglePipelineNode
        ? {
            mode: "staged",
            onApply: async (draft) => {
              if (onCommitStage) {
                return onCommitStage(draft);
              }
              return true;
            },
          }
        : {
            mode: "readOnly",
            statusMessage: () =>
              "Mask antenna stage payload is preserved losslessly in read-only mode",
          },
    };
  }, [
    baseline.actionKind,
    baseline.driveId,
    baseline.terms,
    canTogglePipelineNode,
    index,
    lastAuthoringError,
    onCommitStage,
    resolvedSteps,
    titleLabel,
  ]);

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}


export { AddFieldDriveStageInspectorPanel } from "./AddFieldDriveStageSpec";
export { SincPulseChart } from "./SincPulseChartAndDriveModel";

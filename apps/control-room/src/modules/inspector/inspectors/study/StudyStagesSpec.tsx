"use client";

import {
  ArrowDown,
  ArrowUp,
  Copy,
  Gauge,
  GripVertical,
  Layers,
  Plus,
  Sigma,
  Trash2,
  Workflow,
} from "lucide-react";
import { useContext, useMemo } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../template";
import { hasStudyExecutionProfile } from "../../panels/StudyExecutionProfileModel";
import {
  createDefaultStudyStageDraft,
  withDefaultRelaxTimestepPolicy,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "../../panels/StudyStageAuthoringModel";
import {
  resolveStudyWorkflowStateBefore,
  validateStudyWorkflow,
} from "../../panels/stages/studyWorkflowState";
import { ConnectedInspectorSpec } from "../../panels/study/ConnectedInspectorSpec";
import {
  useKernelStudyAuthoring,
  useKernelStudyRuntimeTelemetry,
} from "../../panels/study/useConnectedStudyAuthoring";
import {
  type StudyStageSequenceItem,
  type StudyStagesDraft,
  studyBreadcrumbs,
  DEFAULT_STAGE_ITEMS,
  parseStagesDraftList,
  stageSequenceItemFromDraft,
  resolveStageInspectKind,
} from "./studyShared";
export function StudyStagesInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedStudyStagesInspectorPanel selection={selection} />;
  }
  return (
    <StudyStagesInspectorPanelView
      items={DEFAULT_STAGE_ITEMS}
      selection={selection}
    />
  );
}

function ConnectedStudyStagesInspectorPanel({ selection }: InspectorPanelProps) {
  const {
    commitStageDraftList,
    executeStudyCommand,
    globalDraft,
    isCanonicalPipeline,
    lastAuthoringError,
    sceneData,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);
  const { model: runtimeModel } = useKernelStudyRuntimeTelemetry(selection);
  const items = useMemo(
    () =>
      stageDrafts.map((d, idx) => {
        const base = stageSequenceItemFromDraft(d, idx);
        const liveStage = runtimeModel.stages[idx];
        return liveStage?.status && liveStage.status !== "not_started"
          ? { ...base, summary: `${base.summary} · ${liveStage.status}` }
          : base;
      }),
    [runtimeModel.stages, stageDrafts],
  );
  const profileBound = sceneData ? hasStudyExecutionProfile(sceneData) : false;
  return (
    <StudyStagesInspectorPanelView
      executionProfileBound={profileBound}
      isCanonicalPipeline={isCanonicalPipeline}
      items={items}
      lastAuthoringError={lastAuthoringError}
      selection={selection}
      stageDrafts={stageDrafts}
      onRunCommand={(cmd) => void executeStudyCommand(cmd)}
      onCommitSequence={async (nextItems) => {
        const nextDrafts = nextItems.map((item, idx) => {
          const existing = stageDrafts.find(
            (candidate) =>
              (candidate.pipelineNodeId ?? candidate.stageId) === item.rowKey ||
              candidate.stageId === item.stageId,
          );
          if (existing) {
            return {
              ...existing,
              stageId: item.stageId,
              stageEnabled: item.enabled,
            };
          }
          const copySource = stageDrafts.find(
            (candidate) =>
              item.rowKey.startsWith(`dup:${candidate.stageId}:`) ||
              item.rowKey.startsWith(
                `dup:${candidate.pipelineNodeId ?? candidate.stageId}:`,
              ),
          );
          if (copySource) {
            return {
              ...copySource,
              pipelineNodeId: undefined,
              stageId: item.stageId,
              stageEnabled: item.enabled,
            };
          }
          const created = withDefaultRelaxTimestepPolicy(
            createDefaultStudyStageDraft(
              item.kind as StudyStageDraftKind,
              idx,
            ),
            {
              backend: globalDraft.requestedBackend,
              device: globalDraft.requestedDevice,
              precision: globalDraft.requestedPrecision,
            },
          );
          return {
            ...created,
            stageId: item.stageId,
            stageEnabled: item.enabled,
          };
        });
        return commitStageDraftList(nextDrafts);
      }}
    />
  );
}

function StudyStagesInspectorPanelView({
  executionProfileBound = false,
  isCanonicalPipeline = false,
  items: sourceItems,
  lastAuthoringError = null,
  onCommitSequence,
  onRunCommand,
  selection,
  stageDrafts,
}: InspectorPanelProps & {
  executionProfileBound?: boolean;
  isCanonicalPipeline?: boolean;
  items: readonly StudyStageSequenceItem[];
  lastAuthoringError?: string | null;
  onCommitSequence?: (nextItems: StudyStageSequenceItem[]) => Promise<boolean>;
  onRunCommand?: (commandId: string) => void;
  stageDrafts?: readonly StudyStageDraft[];
}) {
  const workflowIssues = useMemo(
    () => (stageDrafts ? validateStudyWorkflow(stageDrafts) : []),
    [stageDrafts],
  );
  const cumulativeSummary = useMemo(() => {
    if (!stageDrafts) {
      return {
        drives: "k0_sinc (sinc_pulse, fc = 40.0 GHz)",
        clock: "Δt = 500 fs (f_Nyq = 1.00 THz)",
        fft: "Gamma (k = 0) FFT · my · Hann",
      };
    }
    const wf = resolveStudyWorkflowStateBefore(stageDrafts, stageDrafts.length);
    const activeDrives = stageDrafts
      .filter((d) => d.kind === "add_field_drive" && d.fieldDrive.enabled)
      .map((d) => `${d.fieldDrive.name || d.stageId} (${d.fieldDrive.waveform.kind})`);
    return {
      drives: activeDrives.length > 0 ? activeDrives.join(", ") : "None configured",
      clock: wf.tableAutosave
        ? `${wf.tableAutosave.samplePeriodS ?? "auto"} s (${wf.tableAutosave.sourceStageId})`
        : "OFF",
      fft: wf.fftResponse
        ? `${wf.fftResponse.analysis} · ${wf.fftResponse.responseComponent} (${wf.fftResponse.sourceStageId})`
        : "OFF",
    };
  }, [stageDrafts]);

  const baseline = useMemo<StudyStagesDraft>(() => {
    const computeKinds = new Set([
      "relax",
      "run",
      "hysteresis",
      "eigenmodes",
      "frequency_response",
    ]);
    const enabledCount = sourceItems.filter((s) => s.enabled).length;
    const computeCount = sourceItems.filter((s) => computeKinds.has(s.kind)).length;
    return {
      stagesJson: JSON.stringify(sourceItems),
      totalCount: sourceItems.length,
      enabledCount,
      computeCount,
      zeroDurationCount: sourceItems.length - computeCount,
    };
  }, [sourceItems]);

  const spec = useMemo<InspectorSpec<StudyStagesDraft>>(
    () => ({
      id: "study.stages",
      header: {
        breadcrumbs: studyBreadcrumbs("Stages"),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Workflow,
        title: () => "Stages",
        kindLabel: "Ordered study pipeline",
        entityId: "study:stages",
        statePill: (d) => {
          const items = parseStagesDraftList(d.stagesJson);
          return items.length > 0
            ? { tone: "ok", label: `${items.length} stages` }
            : { tone: "warn", label: "Empty" };
        },
      },
      facts: (d): readonly InspectorFact[] => {
        const items = parseStagesDraftList(d.stagesJson);
        const computeKinds = new Set([
          "relax",
          "run",
          "hysteresis",
          "eigenmodes",
          "frequency_response",
        ]);
        const enabled = items.filter((item) => item.enabled).length;
        const compute = items.filter((item) => computeKinds.has(item.kind)).length;
        return [
          { id: "total", label: "Total stages", value: String(items.length) },
          { id: "enabled", label: "Enabled", value: String(enabled) },
          { id: "compute", label: "Compute stages", value: String(compute) },
          { id: "zero", label: "0 s instructions", value: String(items.length - compute) },
        ];
      },
      notices: (): readonly InspectorNotice<StudyStagesDraft>[] => {
        const list: InspectorNotice<StudyStagesDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "stages-authoring-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (isCanonicalPipeline) {
          list.push({
            id: "canonical-pipeline-guard",
            tone: "info",
            text: "This study uses a canonical study_pipeline graph. Inspect individual stage nodes to edit parameters.",
          });
        }
        for (let i = 0; i < workflowIssues.length; i += 1) {
          const issue = workflowIssues[i]!;
          list.push({
            id: `wf-issue-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "stage-sequence",
          title: "Stage sequence",
          icon: Workflow,
          defaultOpen: true,
          summary: (d) => `${parseStagesDraftList(d.stagesJson).length} ordered stages`,
          rows: [
            {
              key: "stagesJson",
              type: "custom",
              wide: true,
              render: (ctx) => {
                const items = parseStagesDraftList(ctx.draft.stagesJson);
                const commitItems = (next: StudyStageSequenceItem[]) => {
                  ctx.setField("stagesJson", JSON.stringify(next));
                };
                const move = (idx: number, dir: -1 | 1) => {
                  const target = idx + dir;
                  if (target < 0 || target >= items.length) return;
                  const copy = [...items];
                  const tmp = copy[idx]!;
                  copy[idx] = copy[target]!;
                  copy[target] = tmp;
                  commitItems(copy);
                };
                const duplicate = (idx: number) => {
                  const src = items[idx];
                  if (!src || src.kind === "antenna_field_solve") return;
                  const copyId = `${src.stageId}_copy_${items.length + 1}`;
                  const next = [...items];
                  next.splice(idx + 1, 0, {
                    ...src,
                    rowKey: `dup:${src.rowKey}:${Date.now()}`,
                    stageId: copyId,
                  });
                  commitItems(next);
                };
                const addStage = (kind: string, label: string, durationBadge: string) => {
                  const n = items.length + 1;
                  commitItems([
                    ...items,
                    {
                      rowKey: `row-${kind}-${Date.now()}-${n}`,
                      stageId: `${kind}_${n}`,
                      kind,
                      label,
                      summary: `Configured ${label.toLowerCase()} stage`,
                      durationBadge,
                      enabled: true,
                    },
                  ]);
                };

                return (
                  <div className="fm-region-precedence-list">
                    <div className="fm-inspector-notice__actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            disabled={isCanonicalPipeline}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            <Plus aria-hidden="true" size={14} />
                            <span>Add Stage</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuLabel>Equilibrium &amp; Dynamics</DropdownMenuLabel>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() => addStage("relax", "Relax", "compute")}
                            >
                              Relaxation
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => addStage("run", "Run", "10 ns")}
                            >
                              Time Evolution Run
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("hysteresis", "Hysteresis", "sweep")
                              }
                            >
                              Hysteresis Loop
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>Linearized Spectra</DropdownMenuLabel>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("eigenmodes", "Eigenmodes", "modal")
                              }
                            >
                              Eigenmodes
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage(
                                  "frequency_response",
                                  "Frequency Response",
                                  "sweep",
                                )
                              }
                            >
                              Driven Frequency Response
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>0 s Pipeline Instructions</DropdownMenuLabel>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("add_field_drive", "Add Field Drive", "0 s")
                              }
                            >
                              Add Regional Field Drive
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("table_autosave", "Table Autosave", "0 s")
                              }
                            >
                              Table Autosave Clock
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("autosave", "Field Autosave", "0 s")
                              }
                            >
                              Field / Scalar Autosave
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("fft_response", "FFT Response", "0 s")
                              }
                            >
                              Spin-Wave FFT Response
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("save_state", "Save State", "0 s")
                              }
                            >
                              Save State Snapshot
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={executionProfileBound}
                              onSelect={() =>
                                addStage("change_device", "Change Device", "0 s")
                              }
                            >
                              Change Execution Device
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {onRunCommand ? (
                        <>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => onRunCommand("study.compute-observables")}
                          >
                            <Gauge aria-hidden="true" size={13} />
                            <span>Observables</span>
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => onRunCommand("study.compute-energies")}
                          >
                            <Sigma aria-hidden="true" size={13} />
                            <span>Energies</span>
                          </Button>
                        </>
                      ) : null}
                    </div>

                    {items.map((item, idx) => (
                      <div key={item.rowKey} className="fm-region-precedence-card">
                        <span aria-hidden="true" className="fm-stage-drag-handle">
                          <GripVertical size={14} />
                        </span>
                        <span className="fm-region-precedence-card__rank">{idx + 1}</span>
                        <div className="fm-region-precedence-card__body">
                          <div className="fm-region-precedence-card__title">
                            {item.label} <Badge>{item.durationBadge}</Badge>
                          </div>
                          <div className="fm-region-precedence-card__meta">{item.summary}</div>
                        </div>
                        <div className="fm-inspector-header-actions">
                          <Switch
                            aria-label={`Include ${item.label} in study`}
                            checked={item.enabled}
                            disabled={isCanonicalPipeline}
                            onCheckedChange={(checked) =>
                              commitItems(
                                items.map((entry, i) =>
                                  i === idx ? { ...entry, enabled: checked } : entry,
                                ),
                              )
                            }
                          />
                          <Button
                            aria-label={`Duplicate ${item.label}`}
                            disabled={
                              isCanonicalPipeline ||
                              item.kind === "antenna_field_solve"
                            }
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => duplicate(idx)}
                          >
                            <Copy aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            aria-label={`Move ${item.label} up`}
                            disabled={isCanonicalPipeline || idx === 0}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => move(idx, -1)}
                          >
                            <ArrowUp aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            aria-label={`Move ${item.label} down`}
                            disabled={
                              isCanonicalPipeline || idx === items.length - 1
                            }
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => move(idx, 1)}
                          >
                            <ArrowDown aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: resolveStageInspectKind(item.kind),
                                label: `${item.label} ${idx + 1}`,
                                nodeId: `model:study:stages:stage:${item.stageId}`,
                                objectId: null,
                                ref: {
                                  kind: "study.stage.action",
                                  nodeId: `model:study:stages:stage:${item.stageId}`,
                                  stageId: item.stageId,
                                  stageIndex: idx,
                                  type: "study-stage",
                                },
                              })
                            }
                          >
                            Inspect →
                          </Button>
                          <Button
                            aria-label={`Remove ${item.label}`}
                            disabled={isCanonicalPipeline}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              commitItems(items.filter((_, i) => i !== idx))
                            }
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "cumulative-state",
          title: "Cumulative workflow state",
          icon: Layers,
          defaultOpen: false,
          summary: () => `${cumulativeSummary.clock} · FFT ${cumulativeSummary.fft}`,
          rows: [
            {
              label: "Active drives at end",
              type: "readonly",
              format: () => cumulativeSummary.drives,
            },
            {
              label: "Table sampling clock",
              type: "readonly",
              format: () => cumulativeSummary.clock,
            },
            {
              label: "Spectral postprocessing",
              type: "readonly",
              format: () => cumulativeSummary.fft,
            },
          ],
        },
      ],
      commitBar: {
        mode: isCanonicalPipeline ? "readOnly" : "staged",
        onApply: async (draft) => {
          if (onCommitSequence) {
            return onCommitSequence(parseStagesDraftList(draft.stagesJson));
          }
          return true;
        },
      },
    }),
    [
      cumulativeSummary,
      executionProfileBound,
      isCanonicalPipeline,
      lastAuthoringError,
      onCommitSequence,
      onRunCommand,
      workflowIssues,
    ],
  );

  return <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />;
}

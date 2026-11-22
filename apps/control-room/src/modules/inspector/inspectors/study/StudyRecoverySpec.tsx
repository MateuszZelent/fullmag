"use client";

import {
  Activity,
  Database,
  Download,
  FileOutput,
  History,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { PERSISTENCE_CHECKPOINTS_PATH } from "@/kernel/api/apiPaths";
import type { CheckpointEntry, SessionImportInspectResponse } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorSpec } from "../../template";
import {
  ImportStateDialog,
  RestoreCheckpointDialog,
} from "../../panels/StudyInspectorDialogs";
import { readFileAsBase64 } from "../../panels/StudyInspectorDialogs.model";
import { ConnectedInspectorSpec } from "../../panels/study/ConnectedInspectorSpec";
import {
  buildStudyCommandContext,
  useKernelStudyAuthoring,
  useKernelStudyRecoveryResources,
} from "../../panels/study/useConnectedStudyAuthoring";
import {
  type StudyCheckpointItem,
  type StudyRecoveryDraft,
  studyBreadcrumbs,
} from "./studyShared";
export function StudyRecoveryInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedStudyRecoveryInspectorPanel selection={selection} />;
  }
  return <StudyRecoveryInspectorPanelView rawCheckpoints={[]} selection={selection} />;
}

const EMPTY_CHECKPOINTS: CheckpointEntry[] = [];

function ConnectedStudyRecoveryInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const { executeStudyCommand } = useKernelStudyAuthoring(selection);
  const { checkpoints, energyHistory, solverEnergy, solverStatus } =
    useKernelStudyRecoveryResources();
  const rawList = checkpoints.data?.checkpoints ?? EMPTY_CHECKPOINTS;

  const hydrated = useMemo<StudyRecoveryDraft>(() => {
    const items: StudyCheckpointItem[] = rawList.map((entry, idx) => {
      const rec = entry as unknown as Record<string, unknown>;
      const id =
        typeof rec.checkpoint_id === "string"
          ? rec.checkpoint_id
          : typeof rec.id === "string"
            ? rec.id
            : `ckpt-${idx + 1}`;
      const step =
        typeof rec.step === "number" ? `Step ${rec.step}` : "Saved state";
      const resumeClass =
        typeof rec.resume_class === "string" ? rec.resume_class : "exact_state";
      const sourceLabel =
        typeof rec.source === "string" && rec.source ? rec.source : null;
      const stageId =
        typeof rec.stage_id === "string" && rec.stage_id ? rec.stage_id : null;
      return { id, stepLabel: step, resumeClass, sourceLabel, stageId };
    });
    const energyData = solverEnergy.data;
    const totalEnergyJ =
      typeof energyData?.total === "number" && Number.isFinite(energyData.total)
        ? energyData.total
        : null;
    const zeemanEnergyJ =
      typeof energyData?.zeeman === "number" &&
      Number.isFinite(energyData.zeeman)
        ? energyData.zeeman
        : null;
    const statusData = solverStatus.data;
    const runtimeState =
      typeof statusData?.runtime_state === "string"
        ? statusData.runtime_state.toLowerCase()
        : "";
    const latestStepNum =
      typeof statusData?.step_index === "number" &&
      Number.isFinite(statusData.step_index)
        ? String(statusData.step_index)
        : typeof energyData?.step === "number" &&
            Number.isFinite(energyData.step)
          ? String(energyData.step)
          : null;
    const historyData = energyHistory.data;
    const historyRows = Array.isArray(historyData?.rows)
      ? historyData.rows
      : null;
    const returnedRows =
      typeof historyData?.returned_rows === "number" &&
      Number.isFinite(historyData.returned_rows)
        ? historyData.returned_rows
        : historyRows
          ? historyRows.length
          : totalEnergyJ !== null
            ? 1
            : 0;
    const totalRows =
      typeof historyData?.total_rows === "number" &&
      Number.isFinite(historyData.total_rows)
        ? historyData.total_rows
        : returnedRows;
    const lastRow = historyRows?.at(-1) ?? null;
    const prevRow =
      historyRows && historyRows.length >= 2
        ? historyRows.at(-2) ?? null
        : null;
    let latestDeDt: string | null = null;
    if (
      lastRow &&
      prevRow &&
      typeof lastRow.total === "number" &&
      typeof prevRow.total === "number" &&
      typeof lastRow.time_seconds === "number" &&
      typeof prevRow.time_seconds === "number" &&
      Number.isFinite(lastRow.total) &&
      Number.isFinite(prevRow.total) &&
      Number.isFinite(lastRow.time_seconds) &&
      Number.isFinite(prevRow.time_seconds)
    ) {
      const dt = lastRow.time_seconds - prevRow.time_seconds;
      if (dt > 0) {
        const deDt = (lastRow.total - prevRow.total) / dt;
        if (Number.isFinite(deDt)) {
          latestDeDt = `${deDt.toExponential(3)} J/s`;
        }
      }
    }
    const latestRhsNorm =
      typeof statusData?.max_rhs_norm_per_s === "number" &&
      Number.isFinite(statusData.max_rhs_norm_per_s)
        ? `${statusData.max_rhs_norm_per_s.toExponential(3)} 1/s`
        : null;

    return {
      checkpoints: items,
      latestStep: latestStepNum ?? items[0]?.stepLabel ?? null,
      resumeClass: items[0]?.resumeClass ?? null,
      energyRows: returnedRows,
      totalEnergyRows: totalRows,
      totalEnergyJ,
      zeemanEnergyJ,
      latestDeDt,
      latestRhsNorm,
      hasPausedState: runtimeState === "paused",
      importFormat: "fms",
      exportFormat: "fms",
    };
  }, [energyHistory.data, rawList, solverEnergy.data, solverStatus.data]);

  return (
    <StudyRecoveryInspectorPanelView
      executeStudyCommand={executeStudyCommand}
      hydratedBaseline={hydrated}
      rawCheckpoints={rawList}
      selection={selection}
    />
  );
}

function StudyRecoveryInspectorPanelView({
  executeStudyCommand,
  hydratedBaseline,
  rawCheckpoints,
  selection,
}: InspectorPanelProps & {
  executeStudyCommand?: (commandId: string, input?: Record<string, unknown>) => Promise<void>;
  hydratedBaseline?: StudyRecoveryDraft;
  rawCheckpoints: CheckpointEntry[];
}) {
  const kernel = useContext(KernelContext);
  const runRecoveryCommand = useCallback(
    async (commandId: string, input?: Record<string, unknown>) => {
      if (executeStudyCommand) {
        await executeStudyCommand(commandId, input);
        return;
      }
      if (kernel) {
        await kernel.commands.execute(
          commandId,
          buildStudyCommandContext(kernel),
          input,
        );
      }
    },
    [executeStudyCommand, kernel],
  );
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedRestoreId, setSelectedRestoreId] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importBase64, setImportBase64] = useState<string | null>(null);
  const [importInspecting, setImportInspecting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importInspection, setImportInspection] =
    useState<SessionImportInspectResponse["inspection"] | null>(null);
  const [restoreMode, setRestoreMode] = useState("resume");

  const handleInspectFile = useCallback(
    async (file: File | null) => {
      setImportFileName(file?.name ?? null);
      setImportError(null);
      setImportInspection(null);
      setImportBase64(null);
      if (!file || !kernel) return;
      setImportInspecting(true);
      try {
        const b64 = await readFileAsBase64(file);
        const res = await kernel.api.persistence.imports.inspect({
          fms_base64: b64,
        });
        setImportBase64(b64);
        setImportInspection(res.inspection);
      } catch (err) {
        setImportError(
          err instanceof Error ? err.message : "Failed to inspect .fms archive.",
        );
      } finally {
        setImportInspecting(false);
      }
    },
    [kernel],
  );

  const fallbackBaseline = useMemo<StudyRecoveryDraft>(
    () => ({
      checkpoints: [],
      latestStep: null,
      resumeClass: null,
      energyRows: 0,
      totalEnergyRows: 0,
      totalEnergyJ: null,
      zeemanEnergyJ: null,
      latestDeDt: null,
      latestRhsNorm: null,
      hasPausedState: false,
      importFormat: "fms",
      exportFormat: "fms",
    }),
    [],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const spec = useMemo<InspectorSpec<StudyRecoveryDraft>>(
    () => ({
      id: "study.recovery",
      header: {
        breadcrumbs: studyBreadcrumbs("Recovery"),
        canFitView: true,
        primaryHeaderAction: {
          label: "Save Checkpoint",
          icon: Database,
          onRun: async (ctx) => {
            if (kernel) {
              await runRecoveryCommand("study.save-checkpoint");
            } else {
              ctx.notify("Checkpoint requested", PERSISTENCE_CHECKPOINTS_PATH);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: History,
        title: () => "Recovery",
        kindLabel: "Checkpoints & state restoration",
        entityId: "study:recovery",
        statePill: (d) =>
          d.checkpoints.length > 0
            ? { tone: "ok", label: `${d.checkpoints.length} checkpoints` }
            : d.hasPausedState
              ? { tone: "warn", label: "Paused state held" }
              : { tone: "neutral", label: "No checkpoints" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "count", label: "Checkpoints", value: String(d.checkpoints.length) },
        { id: "step", label: "Latest step", value: d.latestStep },
        { id: "class", label: "Resume class", value: d.resumeClass },
        {
          id: "rows",
          label: "Energy rows",
          value: d.energyRows > 0 ? d.energyRows.toLocaleString("en-US") : null,
        },
      ],
      notices: (d) =>
        d.hasPausedState
          ? [
              {
                id: "paused-state",
                tone: "warn",
                text: "A paused runtime solver buffer is currently held in memory.",
                quickFix: {
                  label: "Resume Run",
                  onApply: (ctx) => {
                    if (kernel) {
                      void runRecoveryCommand("study.resume");
                    } else {
                      ctx.notify("Resuming study run");
                    }
                  },
                },
              },
            ]
          : [],
      sections: [
        {
          id: "saved-checkpoints",
          title: "Saved checkpoints",
          icon: Database,
          defaultOpen: true,
          summary: (d) =>
            d.checkpoints.length > 0
              ? `${d.checkpoints.length} saved`
              : "No checkpoints saved yet",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid gap-2">
                  {ctx.draft.checkpoints.length === 0 ? (
                    <EmptyState
                      description="Checkpoints are created automatically after completed stages or manually via Save Checkpoint."
                      heading="No checkpoints saved yet"
                    />
                  ) : (
                    <div className="fm-region-precedence-list">
                      {ctx.draft.checkpoints.map((ckpt) => (
                        <div key={ckpt.id} className="fm-field-layer-row">
                          <div>
                            <div className="fm-field-layer-row__label">{ckpt.id}</div>
                            <div className="fm-field-layer-row__meta">
                              {[
                                ckpt.stepLabel,
                                ckpt.resumeClass,
                                ckpt.stageId ? `stage ${ckpt.stageId}` : null,
                                ckpt.sourceLabel,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              type="button"
                              variant="secondary"
                              onClick={() => {
                                if (kernel && rawCheckpoints.length > 0) {
                                  setSelectedRestoreId(ckpt.id);
                                  setRestoreDialogOpen(true);
                                } else if (kernel) {
                                  void runRecoveryCommand(
                                    "study.restore-checkpoint",
                                    { checkpointId: ckpt.id, checkpoint_id: ckpt.id },
                                  );
                                } else {
                                  ctx.notify("Restoring checkpoint", ckpt.id);
                                }
                              }}
                            >
                              <RotateCcw aria-hidden="true" size={13} />
                              <span>Restore…</span>
                            </Button>
                            <Button
                              aria-label={`Discard checkpoint ${ckpt.id}`}
                              size="sm"
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                if (kernel) {
                                  void runRecoveryCommand(
                                    "study.discard-checkpoint",
                                    { checkpointId: ckpt.id, checkpoint_id: ckpt.id },
                                  );
                                } else {
                                  ctx.notify("Discarding checkpoint", ckpt.id);
                                }
                              }}
                            >
                              <Trash2 aria-hidden="true" size={13} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (kernel) {
                          void runRecoveryCommand("study.save-checkpoint");
                        } else {
                          ctx.notify("Saving checkpoint");
                        }
                      }}
                    >
                      <Database aria-hidden="true" size={13} />
                      <span>Save</span>
                    </Button>
                    <Button
                      disabled={ctx.draft.checkpoints.length === 0}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setSelectedRestoreId(ctx.draft.checkpoints[0]?.id ?? null);
                        setRestoreDialogOpen(true);
                      }}
                    >
                      <RotateCcw aria-hidden="true" size={13} />
                      <span>Restore dialog…</span>
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="danger"
                      onClick={() => {
                        if (kernel) {
                          void runRecoveryCommand("study.discard-paused-state");
                        } else {
                          ctx.notify("Discarding paused state");
                        }
                      }}
                    >
                      <Scissors aria-hidden="true" size={13} />
                      <span>Discard paused state</span>
                    </Button>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "state-import-export",
          title: "State import & export",
          icon: FileOutput,
          defaultOpen: true,
          rows: [
            {
              key: "importFormat",
              label: "Import format",
              type: "segmented",
              options: [
                { value: "fms", label: "Fullmag (.fms)" },
                { value: "ovf", label: "OVF 2.0 (.ovf)" },
                { value: "npz", label: "NumPy (.npz)" },
              ],
            },
            {
              label: "Import external state",
              type: "custom",
              render: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (kernel) {
                      setImportDialogOpen(true);
                    } else {
                      ctx.notify("Field state import inspection ready");
                    }
                  }}
                >
                  <Upload aria-hidden="true" size={13} />
                  <span>Import .{ctx.draft.importFormat} state…</span>
                </Button>
              ),
            },
            {
              key: "exportFormat",
              label: "Export format",
              type: "select",
              options: [
                { value: "fms", label: "Fullmag state (.fms)" },
                { value: "ovf", label: "OVF 2.0 binary (.ovf)" },
                { value: "zarr", label: "Zarr v3 snapshot (.zarr.zip)" },
              ],
            },
            {
              label: "Export current state",
              type: "custom",
              render: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (kernel) {
                      void runRecoveryCommand("study.export-state", {
                        format: ctx.draft.exportFormat,
                      });
                    } else {
                      ctx.notify(`Exporting .${ctx.draft.exportFormat} snapshot`);
                    }
                  }}
                >
                  <Download aria-hidden="true" size={13} />
                  <span>Export snapshot…</span>
                </Button>
              ),
            },
          ],
        },
        {
          id: "energy-ledger",
          title: "Run History & Energy Ledger",
          icon: Activity,
          defaultOpen: false,
          rows: [
            {
              label: "Returned energy rows",
              type: "readonly",
              format: (d) =>
                d.energyRows > 0
                  ? `${d.energyRows.toLocaleString("en-US")} of ${d.totalEnergyRows.toLocaleString("en-US")} rows`
                  : "Not computed yet",
            },
            {
              label: "Total energy E_tot",
              type: "readonly",
              format: (d) =>
                d.totalEnergyJ !== null
                  ? `${d.totalEnergyJ.toExponential(4)} J`
                  : "Not computed yet",
            },
            {
              label: "Zeeman energy E_Z",
              type: "readonly",
              format: (d) =>
                d.zeemanEnergyJ !== null
                  ? `${d.zeemanEnergyJ.toExponential(4)} J`
                  : "—",
            },
            {
              label: "Latest dE/dt",
              type: "readonly",
              format: (d) => d.latestDeDt ?? "—",
            },
            {
              label: "Latest RHS norm",
              type: "readonly",
              format: (d) => d.latestRhsNorm ?? "—",
            },
          ],
        },
      ],
      details: () => [
        { label: "Checkpoints URI", value: PERSISTENCE_CHECKPOINTS_PATH, mono: true },
        { label: "Import formats", value: ".fms, .ovf, .npz", mono: true },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () => "Recovery actions execute immediately with confirmation",
      },
    }),
    [kernel, rawCheckpoints.length, runRecoveryCommand],
  );

  return (
    <>
      <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />
      <RestoreCheckpointDialog
        checkpoints={rawCheckpoints}
        open={restoreDialogOpen}
        selectedCheckpointId={selectedRestoreId}
        onConfirm={(checkpointId) => {
          setRestoreDialogOpen(false);
          if (kernel) {
            void runRecoveryCommand("study.restore-checkpoint", {
              checkpoint_id: checkpointId,
              checkpointId,
            });
          }
        }}
        onOpenChange={setRestoreDialogOpen}
        onSelectCheckpoint={setSelectedRestoreId}
      />
      <ImportStateDialog
        error={importError}
        fileName={importFileName}
        inspecting={importInspecting}
        inspection={importInspection}
        open={importDialogOpen}
        restoreMode={restoreMode}
        onConfirm={() => {
          setImportDialogOpen(false);
          if (kernel && importBase64) {
            void runRecoveryCommand("study.import-state", {
              fms_base64: importBase64,
              restore_mode: restoreMode,
            });
          }
        }}
        onFileSelected={(file) => void handleInspectFile(file)}
        onOpenChange={setImportDialogOpen}
        onRestoreModeChange={setRestoreMode}
      />
    </>
  );
}

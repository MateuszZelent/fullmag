"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type {
  JsonValue,
  SceneResource,
  StudyStageResult,
} from "@/kernel/api/apiTypes";
import {
  studyResultCompletionLabel,
  studyResultDomainLabel,
  studyResultInitialStateLabel,
  studyResultPredecessorLabel,
} from "@/kernel/api/studyResultPlayback";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { useStudyStageResultsResource } from "@/kernel/resources/studyStageResultsResource";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";
import { useEditableRowKeys } from "@/shared/utils/useEditableRowKeys";

import { inspectorFitCommandId } from "../../inspectorFitCommand";
import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorSpec,
  type UseInspectorSpecControllerOptions,
} from "../../template";
import type {
  StageAutosaveDraft,
  StageAutosaveOwnerKind,
} from "../StageAutosaveDraft";
import type { StudyStageModel } from "../StudyInspectorPanelModel";
import { StudyProgressBar } from "../StudyProgressBar";
import { useKernelStudyRuntimeTelemetry } from "../study/useConnectedStudyAuthoring";
import { stageResultInitialState } from "./StageInitialStateSelector.model";
import { StageTextureAssignmentsEditor } from "./StageTextureAssignmentsEditor";

export function hasKernelResourceRuntime(
  kernel: KernelApi | null | undefined,
): boolean {
  return Boolean(
    kernel &&
      typeof (kernel.resources as { getRevision?: unknown } | undefined)
        ?.getRevision === "function",
  );
}

export function serializeStageEnabled(
  stageEnabled: boolean,
  base?: { stageEnabled?: boolean },
): boolean | undefined {
  if (!stageEnabled) return false;
  return base?.stageEnabled === true ? true : undefined;
}

export function StudyStageTelemetryBridge({
  children,
  selection,
}: {
  children: (selectedStageModel: StudyStageModel | null) => ReactNode;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  const hasSessionTelemetry = useSessionStatusSelector((state) =>
    Boolean(state.data?.resources && state.data?.session),
  );
  if (!hasKernelResourceRuntime(kernel) || !hasSessionTelemetry) {
    return <>{children(null)}</>;
  }
  return (
    <ConnectedStudyStageTelemetryBridge selection={selection}>
      {children}
    </ConnectedStudyStageTelemetryBridge>
  );
}

function ConnectedStudyStageTelemetryBridge({
  children,
  selection,
}: {
  children: (selectedStageModel: StudyStageModel | null) => ReactNode;
  selection: Selection;
}) {
  const { selectedStageModel } = useKernelStudyRuntimeTelemetry(selection);
  return <>{children(selectedStageModel)}</>;
}

function choiceKey(choice: StageInitialStateChoice): string {
  if (choice.kind === "prepared") {
    return JSON.stringify([
      choice.kind,
      choice.scene_revision,
      choice.initial_state_revision,
      choice.publication_id,
    ]);
  }
  if (choice.kind !== "stage_result") return choice.kind;
  return JSON.stringify([
    choice.run_id,
    choice.step_id,
    choice.case_id,
    choice.artifact_id,
    choice.content_sha256,
  ]);
}

function describeRelation(relation: StudyStageResult["authored_relation"]): string {
  switch (relation) {
    case "matching_authored_input":
      return "matches authored stage recipe";
    case "authored_input_changed":
      return "authored inputs changed";
    case "stage_absent":
      return "stage absent from current Study";
    case "authoring_unavailable":
      return "authoring comparison pending";
  }
}

function resultTitle(result: StudyStageResult): string {
  return `${result.authored_stage_id ?? result.source.step_id} · ${result.source.run_id} · ${result.accepted_at}`;
}

export interface StageSpecHostProps<TDraft extends object> {
  spec: InspectorSpec<TDraft>;
  selection: Selection;
  baseline: TDraft;
  serverFieldErrors?: Readonly<Record<string, string | null | undefined>>;
  options?: UseInspectorSpecControllerOptions<TDraft>;
  deriveFieldPatch?: (
    key: keyof TDraft & string,
    value: TDraft[keyof TDraft & string],
    nextDraft: TDraft,
  ) => Partial<TDraft> | null | undefined;
  className?: string;
}

/**
 * Stage inspector host wrapping `useInspectorSpecController` + `InspectorTemplate`
 * with optional synchronous `deriveFieldPatch` support for coupled stage draft fields
 * (e.g., synchronizing Tesla/A·m⁻¹ bias vectors, k-path sample counts, or FFT modes).
 */
export function StageSpecHost<TDraft extends object>({
  spec,
  selection,
  baseline,
  serverFieldErrors,
  options,
  deriveFieldPatch,
  className,
}: StageSpecHostProps<TDraft>): ReactNode {
  const kernel = useContext(KernelContext);
  const controller = useInspectorSpecController(
    spec,
    selection,
    baseline,
    serverFieldErrors,
    options,
  );
  const requestedTabId = options?.initialModeTabId;
  const setActiveModeTabId = controller.setActiveModeTabId;
  useEffect(() => {
    if (requestedTabId) {
      setActiveModeTabId(requestedTabId);
    }
  }, [requestedTabId, setActiveModeTabId]);
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel?.selection.set(next, "inspector");
    },
    [kernel],
  );

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      if (!kernel) return;
      const resolvedId =
        commandId ??
        inspectorFitCommandId(kernel.layout.get?.()?.activeViewportMainModuleId);
      void kernel.commands.execute(
        resolvedId,
        createCommandContext("inspector", kernel),
      );
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    if (!kernel) return;
    void kernel.commands.execute(
      "panels:inspector:toggle",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  return (
    <>
      <InspectorTemplate
        activeModeTabId={controller.activeModeTabId}
        animationKey={controller.animationKey}
        appliedFlash={controller.appliedFlash}
        applyError={controller.applyError}
        applying={controller.applying}
        baseline={controller.baseline}
        className={className}
        dirtyFields={controller.dirtyFields}
        displayUnits={controller.displayUnits}
        draft={controller.draft}
        forceShowErrors={controller.forceShowErrors}
        invalidFields={controller.invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={controller.touchedFields}
        onActiveModeTabChange={controller.setActiveModeTabId}
        onApply={controller.requestApply}
        onDisplayUnitChange={controller.setDisplayUnit}
        onFieldChange={(key, value) => {
          const nextDraft = { ...controller.draft, [key]: value };
          const derived = deriveFieldPatch?.(key, value, nextDraft);
          if (derived && Object.keys(derived).length > 0) {
            controller.patchDraft({
              [key]: value,
              ...derived,
            } as Partial<TDraft>);
          } else {
            controller.setField(key, value);
          }
        }}
        onFieldTouch={controller.touchField}
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof TDraft & string)}
        onHideInspector={handleHideInspector}
        onOpenCodePreview={(title, _language, code) =>
          setCodePreview({ title, code })
        }
        onParseErrorChange={controller.setParseError}
        onPatchDraft={controller.patchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={controller.revertAll}
        onRevertField={controller.revertField}
        onSelectNode={handleSelectNode}
      />
      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{codePreview?.title ?? "Python DSL"}</DialogTitle>
            <DialogDescription>
              Equivalent Fullmag Python authoring snippet for the current draft.
            </DialogDescription>
          </DialogHeader>
          <pre className="fm-inspector-code-preview">
            <code>{codePreview?.code ?? ""}</code>
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function StageAutosaveRadixEditor({
  draft,
  onChange,
  owner,
}: {
  draft: StageAutosaveDraft;
  onChange: (next: StageAutosaveDraft) => void;
  owner: StageAutosaveOwnerKind;
}) {
  const rowKeys = useEditableRowKeys(draft.fields.map((field) => field.quantity));
  const cadenceUnit = owner === "relax" ? "accepted steps" : "s";

  return (
    <div className="grid gap-2.5 text-xs" aria-label="Stage autosave">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-fm-primary">Stage autosave</div>
          <div className="text-fm-muted">
            Persist scalar tables and field snapshots owned by this{" "}
            {owner === "relax" ? "Relax" : "Run"} stage.
          </div>
        </div>
        <Switch
          aria-label="Enable stage autosave"
          checked={draft.enabled}
          onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
        />
      </div>

      {draft.enabled ? (
        <div className="grid gap-2 rounded-md border border-fm-border-subtle p-2.5">
          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Autosave target</span>
            <div className="fm-inspector-row__control">
              <Input
                aria-label="Autosave target"
                className="h-fm-control-sm"
                value={draft.target}
                onChange={(event) =>
                  onChange({ ...draft, target: event.target.value })
                }
              />
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Series layout</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.layout}
                onValueChange={(layout) =>
                  onChange({
                    ...draft,
                    layout: layout as StageAutosaveDraft["layout"],
                  })
                }
              >
                <SelectTrigger aria-label="Autosave layout" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="continuous">Continuous</SelectItem>
                  <SelectItem value="separate">Separate per stage</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Storage format</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.format}
                onValueChange={(format) =>
                  onChange({
                    ...draft,
                    format: format as StageAutosaveDraft["format"],
                  })
                }
              >
                <SelectTrigger aria-label="Autosave format" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zarr">Zarr (default)</SelectItem>
                  <SelectItem value="hdf5">HDF5</SelectItem>
                  <SelectItem value="txt">TXT table only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Scalar table</span>
            <div className="fm-inspector-row__control flex justify-end">
              <Switch
                aria-label="Enable stage scalar table"
                checked={draft.tableEnabled}
                onCheckedChange={(tableEnabled) =>
                  onChange({ ...draft, tableEnabled })
                }
              />
            </div>
          </div>

          {draft.tableEnabled ? (
            <>
              <div className="fm-inspector-row" data-layout="inline">
                <span className="fm-inspector-row__label">Table quantities</span>
                <div className="fm-inspector-row__control">
                  <Input
                    aria-label="Stage table quantities"
                    className="h-fm-control-sm font-mono"
                    value={draft.tableQuantities}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        tableQuantities: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="fm-inspector-row" data-layout="inline">
                <span className="fm-inspector-row__label">
                  Table cadence ({cadenceUnit})
                </span>
                <div className="fm-inspector-row__control">
                  <Input
                    aria-label="Stage table cadence"
                    className="h-fm-control-sm font-mono"
                    value={draft.tableCadence}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        tableCadence: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
            </>
          ) : null}

          <div className="grid gap-2 border-t border-fm-border-subtle pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-fm-primary">Field snapshots</span>
              <Button
                disabled={draft.format === "txt"}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  rowKeys.append("m");
                  onChange({
                    ...draft,
                    fields: [
                      ...draft.fields,
                      {
                        cadence: owner === "relax" ? "10" : "1e-12",
                        quantity: "m",
                      },
                    ],
                  });
                }}
              >
                <Plus aria-hidden="true" size={14} />
                <span>Add field</span>
              </Button>
            </div>
            {draft.format === "txt" ? (
              <div className="text-fm-muted">
                TXT stores scalar tables only. Choose Zarr or HDF5 for 3D fields.
              </div>
            ) : null}
            {draft.fields.map((field, index) => (
              <div
                className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5"
                key={rowKeys.keys[index]}
              >
                <Input
                  aria-label={`Autosave field ${index + 1} quantity`}
                  className="h-fm-control-sm font-mono"
                  placeholder="Quantity (e.g. m)"
                  value={field.quantity}
                  onChange={(event) => {
                    const quantity = event.target.value;
                    rowKeys.rename(index, quantity);
                    onChange({
                      ...draft,
                      fields: draft.fields.map((item, i) =>
                        i === index ? { ...item, quantity } : item,
                      ),
                    });
                  }}
                />
                <Input
                  aria-label={`Autosave field ${index + 1} cadence`}
                  className="h-fm-control-sm font-mono"
                  placeholder={`Cadence (${cadenceUnit})`}
                  value={field.cadence}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      fields: draft.fields.map((item, i) =>
                        i === index
                          ? { ...item, cadence: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
                <Button
                  aria-label={`Remove autosave field ${field.quantity || index + 1}`}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    rowKeys.remove(index);
                    onChange({
                      ...draft,
                      fields: draft.fields.filter((_, i) => i !== index),
                    });
                  }}
                >
                  <Trash2 aria-hidden="true" size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StageTextureOverridesRow({
  disabledReason = null,
  onChange,
  scene,
  value,
}: {
  disabledReason?: string | null;
  onChange: (next: JsonValue | undefined) => void;
  scene: SceneResource | null;
  value: JsonValue | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (!scene) {
    return (
      <div className="text-xs text-fm-muted">
        Scene magnetization overrides become available once the model scene loads.
      </div>
    );
  }
  return (
    <StageTextureAssignmentsEditor
      disabledReason={disabledReason}
      open={open}
      scene={scene}
      value={value}
      onChange={onChange}
      onOpenChange={setOpen}
    />
  );
}

interface StageInitialStateRadixControlProps {
  choice: StageInitialStateChoice;
  disabled?: boolean;
  hasAuthoredReset: boolean;
  onChange: (next: StageInitialStateChoice) => void;
  onPreviewResult?: (result: StudyStageResult) => void;
  sceneRevision: number | null;
  stageId: string;
}

function buildStaticInitialStateChoices(
  hasAuthoredReset: boolean,
): { choice: StageInitialStateChoice; label: string }[] {
  const choices: { choice: StageInitialStateChoice; label: string }[] = [
    {
      choice: { kind: "default_for_target" },
      label: "From configured Study flow",
    },
    { choice: { kind: "authored_study" }, label: "Study initial texture (m₀)" },
    {
      choice: { kind: "latest_compatible_state" },
      label: "Latest compatible state at start",
    },
  ];
  if (hasAuthoredReset) {
    choices.push({
      choice: { kind: "authored_stage" },
      label: "Start all objects from this stage's authored state",
    });
  }
  return choices;
}

export function StageInitialStateRadixControl(
  props: StageInitialStateRadixControlProps,
) {
  const kernel = useContext(KernelContext);
  if (
    hasKernelResourceRuntime(kernel) &&
    Boolean(kernel?.api?.simulation?.stages?.results)
  ) {
    return <ConnectedStageInitialStateRadixControl {...props} />;
  }
  return <StandaloneStageInitialStateRadixControl {...props} />;
}

function StandaloneStageInitialStateRadixControl({
  choice,
  disabled = false,
  hasAuthoredReset,
  onChange,
}: StageInitialStateRadixControlProps) {
  const choices = buildStaticInitialStateChoices(hasAuthoredReset);
  const selectedKey = choiceKey(choice);
  if (!choices.some((opt) => choiceKey(opt.choice) === selectedKey)) {
    const pinnedLabel =
      choice.kind === "stage_result"
        ? `${choice.step_id} · ${choice.run_id} · pinned result`
        : "Previously selected source";
    choices.push({ choice, label: pinnedLabel });
  }

  return (
    <div className="grid gap-2 text-xs">
      <div className="fm-inspector-row" data-layout="inline">
        <span className="fm-inspector-row__label">Initial magnetization</span>
        <div className="fm-inspector-row__control">
          <Select
            disabled={disabled}
            value={selectedKey}
            onValueChange={(val) => {
              const found = choices.find((opt) => choiceKey(opt.choice) === val);
              if (found) onChange(found.choice);
            }}
          >
            <SelectTrigger aria-label="Initial magnetization" density="compact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((opt) => (
                <SelectItem
                  key={choiceKey(opt.choice)}
                  value={choiceKey(opt.choice)}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function ConnectedStageInitialStateRadixControl({
  choice,
  disabled = false,
  hasAuthoredReset,
  onChange,
  onPreviewResult,
  sceneRevision,
  stageId,
}: StageInitialStateRadixControlProps) {
  const [page, setPage] = useState<{ revision: number | null; cursors: string[] }>({
    revision: sceneRevision,
    cursors: [],
  });
  const cursors = page.revision === sceneRevision ? page.cursors : [];
  const catalog = useStudyStageResultsResource({
    limit: 25,
    cursor: cursors.at(-1),
    sceneRevision,
    enabled: sceneRevision !== null,
  });
  const last = useStudyStageResultsResource({
    stageId,
    limit: 1,
    sceneRevision,
    enabled: sceneRevision !== null,
  });
  const catalogData =
    catalog.data?.scene_revision === sceneRevision ? catalog.data : null;
  const lastResult =
    last.data?.scene_revision === sceneRevision ? last.data.results[0] : undefined;
  const completion = lastResult?.completion;
  const metricUnit =
    completion?.metric_unit === "1" ? "" : completion?.metric_unit;

  const choices = buildStaticInitialStateChoices(hasAuthoredReset);

  const selectedKey = choiceKey(choice);
  let selectedResult: StudyStageResult | undefined;
  for (const result of catalogData?.results ?? []) {
    const source = stageResultInitialState(result);
    if (source) {
      if (choiceKey(source) === selectedKey) selectedResult = result;
      const relation =
        result.authored_relation === "matching_authored_input"
          ? ""
          : ` · ${describeRelation(result.authored_relation)}`;
      choices.push({ choice: source, label: `${resultTitle(result)}${relation}` });
    }
  }
  if (!choices.some((opt) => choiceKey(opt.choice) === selectedKey)) {
    const pinnedLabel =
      choice.kind === "stage_result"
        ? `${choice.step_id} · ${choice.run_id} · pinned result`
        : "Previously selected source";
    choices.push({ choice, label: pinnedLabel });
  }

  const selectedPredecessor = selectedResult
    ? studyResultPredecessorLabel(selectedResult)
    : null;
  const savedPredecessor = lastResult
    ? studyResultPredecessorLabel(lastResult)
    : null;

  return (
    <div className="grid gap-2 text-xs">
      <div className="fm-inspector-row" data-layout="inline">
        <span className="fm-inspector-row__label">Initial magnetization</span>
        <div className="fm-inspector-row__control">
          <Select
            disabled={disabled || sceneRevision === null}
            value={selectedKey}
            onValueChange={(val) => {
              const found = choices.find((opt) => choiceKey(opt.choice) === val);
              if (found) onChange(found.choice);
            }}
          >
            <SelectTrigger aria-label="Initial magnetization" density="compact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((opt) => (
                <SelectItem
                  key={choiceKey(opt.choice)}
                  value={choiceKey(opt.choice)}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {choice.kind === "stage_result" ? (
        <div className="grid gap-1.5 rounded border border-fm-border-subtle p-2">
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Pinned state</span>
            <span className="font-mono truncate">
              {choice.step_id} · {choice.run_id} · {choice.artifact_id}
            </span>
          </div>
          {selectedResult ? (
            <div className="flex justify-between gap-2">
              <span className="text-fm-muted">Comparison</span>
              <span>
                {describeRelation(selectedResult.authored_relation)} ·{" "}
                {studyResultDomainLabel(selectedResult.domain_relation)}
              </span>
            </div>
          ) : null}
          {selectedPredecessor ? (
            <div className="flex justify-between gap-2">
              <span className="text-fm-muted">Predecessor</span>
              <span>{selectedPredecessor}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span>Use as saved seed after model changes</span>
            <Switch
              aria-label="Use as a saved seed"
              checked={choice.allow_stale_model === true}
              disabled={disabled || sceneRevision === null}
              onCheckedChange={(allow_stale_model) =>
                onChange({ ...choice, allow_stale_model })
              }
            />
          </div>
        </div>
      ) : null}

      {cursors.length > 0 || catalogData?.next_cursor ? (
        <div className="flex items-center gap-2">
          <Button
            disabled={disabled || cursors.length === 0}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() =>
              setPage({ revision: sceneRevision, cursors: cursors.slice(0, -1) })
            }
          >
            Newer results
          </Button>
          <Button
            disabled={disabled || !catalogData?.next_cursor}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              if (catalogData?.next_cursor) {
                setPage({
                  revision: sceneRevision,
                  cursors: [...cursors, catalogData.next_cursor],
                });
              }
            }}
          >
            Older results
          </Button>
        </div>
      ) : null}

      <div className="flex justify-between gap-2">
        <span className="text-fm-muted">Last saved result</span>
        <span className="truncate">
          {lastResult
            ? resultTitle(lastResult)
            : last.status === "loading"
              ? "Loading…"
              : "No saved result"}
        </span>
      </div>
      {lastResult ? (
        <div className="grid gap-1 rounded border border-fm-border-subtle p-2">
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Recipe relation</span>
            <span>{describeRelation(lastResult.authored_relation)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Layout</span>
            <span>{studyResultDomainLabel(lastResult.domain_relation)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Initial state</span>
            <span>{studyResultInitialStateLabel(lastResult.initial_state)}</span>
          </div>
          {savedPredecessor ? (
            <div className="flex justify-between gap-2">
              <span className="text-fm-muted">Predecessor</span>
              <span>{savedPredecessor}</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Completion</span>
            <span>{studyResultCompletionLabel(completion)}</span>
          </div>
          {completion?.metric_value !== undefined && metricUnit !== undefined ? (
            <div className="flex justify-between gap-2">
              <span className="text-fm-muted">Stop metric</span>
              <span className="tabular-nums">
                {`${completion.metric_value} ${metricUnit}`.trimEnd()}
              </span>
            </div>
          ) : null}
          {onPreviewResult && lastResult.supports_magnetization_input ? (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onPreviewResult(lastResult)}
            >
              Preview last saved result
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatBytesMiB(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatWorkerAdmission(
  telemetry: StudyStageModel["parallelExecution"],
): string {
  if (!telemetry) return "—";
  const limit =
    typeof telemetry.admission_worker_limit === "number"
      ? `; limit ${telemetry.admission_worker_limit}`
      : "";
  return `${telemetry.active_workers} active; admission ${telemetry.admission_desired_workers}${limit}`;
}

function formatResourceTarget(
  telemetry: StudyStageModel["parallelExecution"],
): string {
  if (!telemetry) return "—";
  const kindLabel =
    telemetry.cpu_target_kind === "soft_admission_target"
      ? "Soft CPU admission target"
      : "CPU target reported";
  const cpuPct =
    typeof telemetry.cpu_target_percent === "number" &&
    Number.isFinite(telemetry.cpu_target_percent)
      ? `${telemetry.cpu_target_percent.toFixed(1)}%`
      : "—";
  const memPct =
    typeof telemetry.memory_target_percent === "number" &&
    Number.isFinite(telemetry.memory_target_percent)
      ? `${telemetry.memory_target_percent.toFixed(1)}%`
      : "—";
  return `CPU ${cpuPct}; memory ${memPct}; reserve ${formatBytesMiB(telemetry.memory_reserve_bytes)}; ${kindLabel}`;
}

function formatMeasuredResources(
  telemetry: StudyStageModel["parallelExecution"],
): string {
  if (!telemetry) return "—";
  const cpu =
    typeof telemetry.cpu_busy_percent === "number" &&
    Number.isFinite(telemetry.cpu_busy_percent)
      ? `${telemetry.cpu_busy_percent.toFixed(1)}% CPU busy`
      : "CPU —";
  const memory =
    typeof telemetry.memory_available_bytes === "number" &&
    typeof telemetry.memory_limit_bytes === "number"
      ? `${formatBytesMiB(telemetry.memory_available_bytes)} available / ${formatBytesMiB(telemetry.memory_limit_bytes)} limit`
      : "memory —";
  return `${cpu}; ${memory}`;
}

function formatAdmissionReason(
  telemetry: StudyStageModel["parallelExecution"],
): string {
  if (!telemetry) return "—";
  const labels: Record<string, string> = {
    calibrating_first_sample: "Calibrating first sample",
    cpu_target_exhausted: "Waiting for CPU capacity",
    insufficient_memory_for_probe: "Waiting for memory capacity",
    insufficient_memory_for_worker: "Waiting for memory capacity",
    telemetry_unavailable: "Waiting for resource telemetry",
    telemetry_invalid: "Telemetry invalid; admission paused",
    telemetry_stale: "Telemetry stale; admission paused",
    telemetry_unavailable_no_new_admission: "Waiting for resource telemetry",
    waiting_cpu_headroom_for_probe: "Waiting for CPU capacity",
    waiting_memory_headroom_for_probe: "Waiting for memory capacity",
  };
  return labels[telemetry.admission_reason] ?? "Admission state reported";
}

export function StageLiveTelemetryPanel({
  emptyDescription,
  stageModel,
}: {
  emptyDescription: string;
  stageModel: StudyStageModel | null | undefined;
}) {
  if (
    !stageModel ||
    ((stageModel.status === "draft" || stageModel.status === "not started") &&
      !stageModel.parallelExecution)
  ) {
    return (
      <EmptyState
        description={emptyDescription}
        heading="Not computed yet"
      />
    );
  }

  const parallel = stageModel.parallelExecution;

  return (
    <div className="grid gap-2 text-xs">
      <StudyProgressBar
        indeterminate={
          stageModel.status.toLowerCase() === "running" &&
          !stageModel.progressLabel &&
          stageModel.progressPercent <= 0
        }
        label={`${stageModel.label} progress`}
        statusLabel={stageModel.progressLabel ?? undefined}
        value={stageModel.progressPercent}
      />
      {stageModel.progressDetail ? (
        <div className="text-fm-muted">{stageModel.progressDetail}</div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 rounded border border-fm-border-subtle p-2.5 tabular-nums">
        <div>
          <span className="block text-fm-muted">Status</span>
          <span className="font-medium">{stageModel.status}</span>
        </div>
        <div>
          <span className="block text-fm-muted">Converged</span>
          <span>
            {stageModel.converged === null || stageModel.converged === undefined
              ? "—"
              : stageModel.converged
                ? "Yes"
                : "No"}
          </span>
        </div>
        <div>
          <span className="block text-fm-muted">Stop metric</span>
          <span>
            {stageModel.runtimeMetric
              ? `${stageModel.runtimeMetric.name}: ${
                  stageModel.runtimeMetric.value === "unavailable"
                    ? "—"
                    : stageModel.runtimeMetric.value
                }`
              : "—"}
          </span>
        </div>
        <div>
          <span className="block text-fm-muted">Threshold</span>
          <span>{stageModel.runtimeMetric?.threshold ?? "—"}</span>
        </div>
        <div>
          <span className="block text-fm-muted">Stop reason</span>
          <span>{stageModel.stopReason ?? "—"}</span>
        </div>
        <div>
          <span className="block text-fm-muted">Checkpoint</span>
          <span className="font-mono truncate">{stageModel.checkpointRef ?? "—"}</span>
        </div>
      </div>
      {stageModel.transition ? (
        <div className="grid gap-1 rounded border border-fm-border-subtle p-2">
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Transition</span>
            <span>{stageModel.transition.label ?? "Reported"}</span>
          </div>
          {stageModel.transition.reason ? (
            <div className="flex justify-between gap-2">
              <span className="text-fm-muted">Transition reason</span>
              <span>{stageModel.transition.reason}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {parallel ? (
        <div
          aria-label="Parallel worker admission telemetry"
          className="grid gap-1 rounded border border-fm-border-subtle p-2 tabular-nums"
        >
          <div className="font-medium text-fm-primary">
            Adaptive worker pool ({parallel.terminal ? "terminal sample" : "live sample"})
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Workers</span>
            <span>{formatWorkerAdmission(parallel)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Resolved workers</span>
            <span>
              {parallel.resolved_workers != null
                ? String(parallel.resolved_workers)
                : "Not resolved yet"}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Resource target</span>
            <span className="text-right">{formatResourceTarget(parallel)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Measured CPU / memory</span>
            <span className="text-right">{formatMeasuredResources(parallel)}</span>
          </div>
          {typeof parallel.cpu_available_cores === "number" &&
          Number.isFinite(parallel.cpu_available_cores) &&
          parallel.cpu_available_cores >= 0 ? (
            <div className="flex justify-between gap-2">
              <span className="text-fm-muted">Available CPU capacity</span>
              <span>{`${parallel.cpu_available_cores.toFixed(2)} cores`}</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <span className="text-fm-muted">Admission state</span>
            <span>{formatAdmissionReason(parallel)}</span>
          </div>
        </div>
      ) : null}
      {stageModel.artifactRefs.length > 0 ? (
        <div className="text-fm-muted font-mono break-all">
          Artifacts: {stageModel.artifactRefs.join(", ")}
        </div>
      ) : null}
    </div>
  );
}

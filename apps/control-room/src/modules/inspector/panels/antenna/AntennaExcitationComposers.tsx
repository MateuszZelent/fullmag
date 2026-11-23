"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND,
  antennaFieldSolveStudyReference,
} from "@/kernel/runtime/antennaFieldSolveStudyCommand";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  parseAntennaColorRange,
  type AntennaColorRange,
} from "@/kernel/visualization/antennaColorRange";
import { antennaNavigationLinks } from "@/modules/explorer/public";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { antennaFieldSolveDefinitionPortError } from "@/shared/domain/study/antennaFieldSolveCapability";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorPropertyRow } from "../../primitives/InspectorPropertyRow";
import { antennaNavigationScene } from "./AntennaNavigationScene";
import {
  composeAntennaProjection,
  composeAntennaProjectionDrive,
} from "./AntennaProjectionDriveComposerModel";
import {
  antennaPlaneOrientation,
  antennaPlaneOrientations,
  antennaVectorDraftCells,
  type AntennaPlaneFrameDraft,
} from "./AntennaSamplingPlaneFieldsModel";
import {
  antennaSamplingResolution,
  type AntennaSamplingGridDraft,
} from "./AntennaSamplingResolutionModel";
import { antennaSolveTargetOptions } from "./AntennaSolveTargetsEditorModel";
import {
  acknowledgeAntennaSpectrumDraft,
  composeAntennaSpectrumRequest,
  emptyAntennaSpectrumDraft,
  type AntennaSpectrumDraft,
  type AntennaSpectrumLocalDraft,
} from "./AntennaSpectrumComposerModel";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { antennaRunStageIds } from "./SolvedAntennaDriveEditorModel";

function makeSessionFence(
  kernel: ReturnType<typeof useKernel>,
  scope: string | null,
): () => boolean {
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();
  return () => {
    const scopeMatches =
      !scope || !kernel.commands.getSessionScopeKey
        ? true
        : kernel.commands.getSessionScopeKey() === scope;
    const generationMatches =
      historyGeneration === undefined ||
      kernel.authoringHistory?.getGeneration?.() === historyGeneration;
    return scopeMatches && generationMatches;
  };
}

// ============================================================================
// 1. RadixRelatedResources
// ============================================================================

export function RadixRelatedResources({
  scene,
  selection,
  scope,
  available,
}: {
  scene: SceneResource | null;
  selection: Selection;
  scope: string | null;
  available: boolean;
}): ReactNode {
  const kernel = useKernel();
  const [error, setError] = useState<string | null>(null);
  const links = useMemo(
    () => (scene ? antennaNavigationLinks(scene, selection) : []),
    [scene, selection],
  );
  if (!links.length) return null;

  return (
    <div className="fm-inspector-stack" data-testid="antenna-related-resources">
      {links.map((link) => (
        <div key={link.key} className="fm-inspector-stack">
          <Button
            className="h-auto min-h-fm-control-md w-full justify-start py-1.5 text-left whitespace-normal break-words"
            disabled={!available || !link.selection}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              const liveScene = antennaNavigationScene(kernel, scope) ?? scene;
              const target = liveScene
                ? antennaNavigationLinks(liveScene, selection).find(
                    (item) => item.key === link.key,
                  )
                : null;
              const nextSelection = target?.selection ?? link.selection;
              if (!nextSelection) {
                setError(
                  "The related resource changed or is missing in the current scene. Refresh before navigating.",
                );
                return;
              }
              setError(null);
              kernel.selection.set(nextSelection, "inspector");
            }}
          >
            Open {link.label}
            {link.selection && link.selection.label !== link.label
              ? ` · ${link.selection.label}`
              : ""}
          </Button>
          {link.reason ? <p className="fm-inspector-hint">{link.reason}</p> : null}
        </div>
      ))}
      {error ? <FeedbackBanner kind="warning" message={error} /> : null}
    </div>
  );
}

// ============================================================================
// 2. RadixSamplingPlaneFields & RadixSamplingResolution
// ============================================================================

function RadixVectorDraftRow({
  label,
  value,
  unitSuffix,
  onChange,
}: {
  label: string;
  value: string;
  unitSuffix?: string;
  onChange: (nextValue: string) => void;
}): ReactNode {
  const cells = antennaVectorDraftCells(value);
  if (!cells) {
    return (
      <div className="fm-inspector-stack">
        <FieldRow label={label} mono value={value || "—"} />
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onChange("0, 0, 0")}
        >
          Replace {label} with XYZ coordinates
        </Button>
      </div>
    );
  }
  return (
    <InspectorPropertyRow
      label={unitSuffix ? `${label} [${unitSuffix}]` : label}
      layout="stacked"
    >
      <div className="grid grid-cols-3 gap-1.5">
        {(["X", "Y", "Z"] as const).map((axis, idx) => (
          <Input
            key={axis}
            aria-label={`${label} ${axis}`}
            inputMode="decimal"
            placeholder={axis}
            value={cells[idx] ?? ""}
            onChange={(e) => {
              const next = [...cells];
              next[idx] = e.currentTarget.value;
              onChange(next.join(", "));
            }}
          />
        ))}
      </div>
    </InspectorPropertyRow>
  );
}

export function RadixSamplingPlaneFields({
  values,
  onChange,
}: {
  values: AntennaPlaneFrameDraft;
  onChange: (next: AntennaPlaneFrameDraft) => void;
}): ReactNode {
  const orientation = antennaPlaneOrientation(values);
  return (
    <div className="fm-inspector-stack" data-testid="antenna-sampling-plane-fields">
      <InspectorPropertyRow label="Plane orientation">
        <Select
          value={orientation}
          onValueChange={(nextId) => {
            const preset = antennaPlaneOrientations.find((o) => o.id === nextId);
            if (preset) {
              onChange({ ...values, axisU: preset.axisU, axisV: preset.axisV });
            }
          }}
        >
          <SelectTrigger aria-label="Plane orientation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            {orientation === "custom" ? (
              <SelectItem disabled value="custom">
                Custom axes · edit XYZ below
              </SelectItem>
            ) : null}
            {antennaPlaneOrientations.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      <RadixVectorDraftRow
        label="Plane origin"
        unitSuffix="m"
        value={values.originM}
        onChange={(originM) => onChange({ ...values, originM })}
      />
      <RadixVectorDraftRow
        label="Axis u"
        value={values.axisU}
        onChange={(axisU) => onChange({ ...values, axisU })}
      />
      <RadixVectorDraftRow
        label="Axis v"
        value={values.axisV}
        onChange={(axisV) => onChange({ ...values, axisV })}
      />
    </div>
  );
}

function formatDistanceMetric(value: number): string {
  return value >= 1e-9 && value < 1e-6
    ? formatValueWithUnit(value * 1e9, "nm")
    : formatValueWithUnit(value, "m");
}

function formatWavevectorMetric(value: number): string {
  return `${value.toExponential(4)} rad/m`;
}

export function RadixSamplingResolution({
  values,
  transform = "spatial_fft",
}: {
  values: AntennaSamplingGridDraft;
  transform?: string;
}): ReactNode {
  const metrics = antennaSamplingResolution(values, transform);
  if (transform !== "spatial_fft") {
    return (
      <div className="fm-antenna-readout" data-testid="antenna-sampling-resolution">
        <p className="fm-inspector-hint">
          Uniform FFT spacing and k bounds apply to uniform spatial FFT requests.
        </p>
      </div>
    );
  }
  return (
    <div className="fm-inspector-stack" data-testid="antenna-sampling-resolution">
      <FieldRow
        label="Runtime sample budget"
        value={
          metrics
            ? `${metrics.sampleCount.toLocaleString("en-US")} / ${metrics.limit.toLocaleString("en-US")}${metrics.withinBudget ? "" : " (over budget)"}`
            : "—"
        }
      />
      <FieldRow
        label="Spacing u"
        value={metrics ? formatDistanceMetric(metrics.u.spacingM) : "—"}
      />
      <FieldRow
        label="Spacing v"
        value={metrics ? formatDistanceMetric(metrics.v.spacingM) : "—"}
      />
      <FieldRow
        label="FFT Δk u"
        value={metrics ? formatWavevectorMetric(metrics.u.deltaKRadPerM) : "—"}
      />
      <FieldRow
        label="FFT Δk v"
        value={metrics ? formatWavevectorMetric(metrics.v.deltaKRadPerM) : "—"}
      />
      <FieldRow
        label="FFT k u bounds"
        value={
          metrics
            ? `${formatWavevectorMetric(metrics.u.minimumKRadPerM)} → ${formatWavevectorMetric(metrics.u.maximumKRadPerM)}`
            : "—"
        }
      />
      <FieldRow
        label="FFT k v bounds"
        value={
          metrics
            ? `${formatWavevectorMetric(metrics.v.minimumKRadPerM)} → ${formatWavevectorMetric(metrics.v.maximumKRadPerM)}`
            : "—"
        }
      />
    </div>
  );
}

// ============================================================================
// 3. RadixAntennaStudyStageComposer
// ============================================================================

export function RadixAntennaStudyStageComposer({
  objectId,
  stageId,
  scene,
  sceneScopeKey,
  status,
}: {
  objectId: string;
  stageId: string;
  scene: SceneResource | null;
  sceneScopeKey: string | null;
  status: string;
}): ReactNode {
  const kernel = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = JSON.stringify([scope, objectId, stageId]);
  const owner = useRef<string | null>(null);
  const inflight = useRef<string | null>(null);
  useLayoutEffect(() => {
    owner.current = key;
    return () => {
      owner.current = null;
    };
  }, [key]);

  const [choice, setChoice] = useState<{ key: string; portId: string } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    key: string;
    kind: "error" | "success";
    message: string;
  } | null>(null);

  const definitions = (scene?.antenna_field_solve_stages ?? []).filter(
    (stage) => stage.id === stageId && stage.source_object_id === objectId,
  );
  const definition = definitions.length === 1 ? definitions[0] : null;
  const portIds = definition?.port_mode_ids ?? [];
  const capabilityError = definition
    ? antennaFieldSolveDefinitionPortError(portIds)
    : null;
  const portId =
    choice?.key === key ? choice.portId : portIds.length === 1 ? (portIds[0] ?? "") : "";
  const pending = pendingKey === key;
  const currentScene = Boolean(
    scene && status === "ready" && (!sceneScopeKey || sceneScopeKey === scope),
  );
  const selectedPorts = (scene?.antenna_port_modes ?? []).filter(
    (port) => port.id === portId,
  );
  const validPort =
    portIds.filter((id) => id === portId).length === 1 &&
    selectedPorts.length === 1 &&
    selectedPorts[0]?.source_object_id === objectId &&
    selectedPorts[0]?.current_transport_id === definition?.current_transport_id;

  const studyReference =
    scene && definition && validPort && !capabilityError
      ? antennaFieldSolveStudyReference(scene, {
          objectId,
          portModeId: portId,
          stageId,
        })
      : null;

  function openStudyStage() {
    if (!currentScene || studyReference?.state !== "present") return;
    const nodeId = `model:study:stages:stage:${studyReference.queueId}`;
    kernel.selection.set(
      {
        kind: "study.stage.antenna_field_solve",
        label: "Antenna Field Solve",
        nodeId,
        objectId: null,
        ref: {
          kind: "study.stage.antenna_field_solve",
          nodeId,
          stageId: studyReference.queueId,
          stageIndex: studyReference.index,
          type: "study-stage",
        },
      },
      "inspector",
    );
  }

  async function addStageToStudy() {
    if (
      !currentScene ||
      !validPort ||
      capabilityError ||
      studyReference?.state !== "missing" ||
      inflight.current === key
    ) {
      return;
    }
    const isCurrent = () =>
      owner.current === key &&
      (!scope || !kernel.commands.getSessionScopeKey
        ? true
        : kernel.commands.getSessionScopeKey() === scope);
    inflight.current = key;
    setPendingKey(key);
    setFeedback(null);
    try {
      const result = await kernel.commands.execute(
        ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND,
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          input: { objectId, portModeId: portId, stageId },
          isCurrentSessionScope: isCurrent,
          resources: kernel.resources,
          selection: kernel.selection,
          sessionScopeKey: scope ?? undefined,
          source: "inspector",
        },
      );
      if (isCurrent() && result && result.status !== "cancelled") {
        setFeedback({
          key,
          kind: result.status === "completed" ? "success" : "error",
          message:
            result.message ?? "Field-solve command completed.",
        });
      }
    } catch (error) {
      if (isCurrent()) {
        setFeedback({
          key,
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (inflight.current === key) inflight.current = null;
      if (isCurrent()) setPendingKey(null);
    }
  }

  async function executeFieldSolveStage() {
    if (!currentScene || inflight.current === key) return;
    inflight.current = key;
    setPendingKey(key);
    setFeedback(null);
    try {
      if (studyReference?.state === "present") {
        await kernel.commands.execute(
          "study.execute-stage",
          createCommandContext("inspector", kernel, {
            input: {
              stageId: studyReference.queueId,
              stageIndex: studyReference.index,
            },
            resourceData: scene ? { [MODEL_SCENE_PATH]: scene } : undefined,
            sessionScopeKey: scope ?? undefined,
            sourceDetail: "object.antenna.solution",
          }),
        );
        setFeedback({
          key,
          kind: "success",
          message: "Antenna field-solve execution requested.",
        });
      } else if (validPort && !capabilityError) {
        await addStageToStudy();
      }
    } catch (error) {
      setFeedback({
        key,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (inflight.current === key) inflight.current = null;
      setPendingKey(null);
    }
  }

  return (
    <div className="fm-inspector-stack" data-testid="antenna-study-stage-composer">
      <p className="fm-inspector-hint">
        Select one port mode for this stage. Adding a Study stage creates an explicit
        execution reference without starting LLG or relaxation.
      </p>
      <InspectorPropertyRow label="Stage port mode">
        <Select
          disabled={!currentScene || !definition || Boolean(capabilityError)}
          value={portId || "__none__"}
          onValueChange={(next) => {
            setChoice({ key, portId: next === "__none__" ? "" : next });
            setFeedback(null);
          }}
        >
          <SelectTrigger aria-label="Stage port mode">
            <SelectValue placeholder="Select an explicit port mode" />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="__none__">Select an explicit port mode</SelectItem>
            {[...new Set(portIds)].map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorPropertyRow>

      {!definition ? (
        <FeedbackBanner
          kind="error"
          message="The field-solve definition is missing or ambiguous."
        />
      ) : null}
      {capabilityError ? (
        <FeedbackBanner kind="error" message={capabilityError} />
      ) : null}
      {portId && !validPort ? (
        <FeedbackBanner
          kind="error"
          message="The selected port must belong uniquely to this source and current transport."
        />
      ) : null}
      {studyReference?.state === "invalid" ? (
        <FeedbackBanner kind="error" message={studyReference.message} />
      ) : null}
      {studyReference?.state === "present" ? (
        <div className="fm-inspector-stack">
          <FieldRow label="Study stage ID" mono value={studyReference.queueId} />
          <div className="fm-inspector-inline-actions">
            <Button
              disabled={!currentScene}
              size="sm"
              type="button"
              variant="secondary"
              onClick={openStudyStage}
            >
              Open Study stage
            </Button>
            <Button
              disabled={!currentScene || pending}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void executeFieldSolveStage()}
            >
              Solve antenna visualization
            </Button>
          </div>
        </div>
      ) : null}
      {feedback?.key === key && !capabilityError ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
      <div className="fm-inspector-inline-actions">
        <Button
          disabled={
            !currentScene ||
            !validPort ||
            Boolean(capabilityError) ||
            studyReference?.state !== "missing" ||
            pending
          }
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => void addStageToStudy()}
        >
          Add Field Solve to Study
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// 4. RadixAntennaProjectionDriveComposer
// ============================================================================

interface ProjectionComposerDraft {
  key: string;
  baseRevision: number;
  dirty: boolean;
  target: string;
  mode: "projection" | "drive";
  run: string;
  peak: string;
  frequency: string;
}

export function RadixAntennaProjectionDriveComposer({
  stageId,
  scene,
  sceneScopeKey,
  status,
  refetch,
}: {
  stageId: string;
  scene: SceneResource | null;
  sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const key = JSON.stringify([scope, stageId]);
  const owner = useRef<string | null>(null);
  const inflight = useRef<string | null>(null);
  useLayoutEffect(() => {
    owner.current = key;
    return () => {
      owner.current = null;
    };
  }, [key]);

  const [local, setLocal] = useState<ProjectionComposerDraft | null>(null);
  const [pendingKey, setPending] = useState<string | null>(null);
  const [rejectedKey, setRejected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    key: string;
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const current =
    scene && (!sceneScopeKey || sceneScopeKey === scope) ? scene : null;
  const revision = current?.revision ?? current?.scene_revision ?? null;
  const validRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const initial: ProjectionComposerDraft = {
    baseRevision: validRevision ? revision : -1,
    dirty: false,
    frequency: "",
    key,
    mode: "projection",
    peak: "",
    run: "",
    target: "",
  };
  const draft = local?.key === key ? local : initial;
  const pending = pendingKey === key;
  const conflict =
    draft.dirty &&
    !pending &&
    (draft.baseRevision !== revision || rejectedKey === key);
  const targets = antennaSolveTargetOptions(current);
  const runs = antennaRunStageIds(current);

  let request: AuthoringTransactionRequest | null = null;
  let reason: string | null = null;
  try {
    if (!current || !validRevision || status !== "ready") {
      throw new Error("Waiting for the current session-scoped scene.");
    }
    const target = targets.find((option) => option.key === draft.target)?.target;
    if (!target) throw new Error("Select a projection target explicitly.");
    const combined = draft.mode === "drive";
    if (combined && target.kind !== "object") {
      throw new Error("The combined drive composer requires an object target.");
    }
    const result =
      combined && target.kind === "object"
        ? composeAntennaProjectionDrive(
            current,
            stageId,
            target.object_id,
            draft.run,
            draft.peak,
            draft.frequency,
          )
        : null;
    const projection =
      result?.projection ?? composeAntennaProjection(current, stageId, target);
    request = {
      base_revision: draft.baseRevision,
      kind: "merge_patch",
      merge_patch: {
        antenna_target_projections: [
          ...(current.antenna_target_projections ?? []),
          projection,
        ],
        ...(result
          ? {
              solved_antenna_drives: [
                ...(current.solved_antenna_drives ?? []),
                result.drive,
              ],
            }
          : {}),
      },
    };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }

  const canCreate = Boolean(request && draft.dirty && !conflict && !pending);

  function update(patch: Partial<ProjectionComposerDraft>) {
    if (!current || !validRevision) return;
    setLocal({
      ...draft,
      ...(draft.dirty ? {} : { baseRevision: revision }),
      ...patch,
      dirty: true,
    });
    setFeedback(null);
  }

  function discard() {
    if (!pending) {
      setLocal(null);
      setRejected(null);
      setFeedback(null);
    }
  }

  async function create(): Promise<void> {
    if (!current || !request || !canCreate || inflight.current === key) return;
    const submitted = draft;
    const transaction = request;
    const isCurrent = () =>
      owner.current === key && makeSessionFence(kernel, scope)();
    if (!isCurrent()) return;
    inflight.current = key;
    setPending(key);
    setFeedback(null);
    const sceneId = current.scene?.id ?? "";
    const validate = (
      response: Parameters<typeof committedAntennaTransactionScene>[0],
    ) =>
      sceneId
        ? committedAntennaTransactionScene(response, transaction, sceneId)
        : (response.committed_scene ?? current);
    try {
      const response = await runAuthoringMutationWithHistory(
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          isCurrentSessionScope: isCurrent,
          resourceData: { [MODEL_SCENE_PATH]: current },
          selection: kernel.selection,
          sessionScopeKey: scope ?? undefined,
        },
        `Create antenna projection from ${stageId}`,
        () =>
          kernel.api.model.commitTransaction(
            transaction,
            scope ? { sessionScopeKey: scope } : undefined,
          ),
        validate,
      );
      if (!isCurrent()) return;
      const committedRev =
        typeof response?.scene_revision === "number"
          ? response.scene_revision
          : submitted.baseRevision + 1;
      if (response?.committed_scene) {
        publishCommittedSceneResource(
          kernel.resources,
          validate(response),
          committedRev,
          undefined,
          false,
          scope,
          kernel.api.resourceCacheScope,
        );
      }
      invalidateAuthoringMutationDependents(
        kernel.resources,
        "interaction",
        committedRev,
      );
      setLocal((val) =>
        val?.key === key
          ? { ...val, baseRevision: committedRev, dirty: val !== submitted }
          : val,
      );
      setRejected(null);
      setFeedback({
        key,
        kind: "success",
        message:
          submitted.mode === "drive"
            ? "Projection and drive committed."
            : "Projection committed.",
      });
    } catch (error) {
      if (!isCurrent()) return;
      setRejected(key);
      refetch();
      setFeedback({
        key,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (inflight.current === key) inflight.current = null;
      setPending((val) => (val === key ? null : val));
    }
  }

  return (
    <div className="fm-inspector-stack" data-testid="antenna-projection-composer">
      <p className="fm-inspector-hint">
        Bind a field-solve output to a target object or region, optionally creating a
        paired sinusoidal current drive.
      </p>
      <InspectorPropertyRow label="Projection composition">
        <SegmentedControl
          aria-label="Projection composition"
          columns={2}
          options={[
            { label: "Projection only", value: "projection" },
            { label: "Projection + drive", value: "drive" },
          ]}
          value={draft.mode}
          onValueChange={(nextMode) =>
            update({ mode: nextMode as "projection" | "drive" })
          }
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Projection target">
        <Select
          value={draft.target || "__none__"}
          onValueChange={(val) => update({ target: val === "__none__" ? "" : val })}
        >
          <SelectTrigger aria-label="Projection target">
            <SelectValue placeholder="Select projection target" />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="__none__">Select projection target</SelectItem>
            {targets.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      {draft.mode === "drive" ? (
        <>
          <InspectorPropertyRow label="Run stage">
            <Select
              value={draft.run || "__none__"}
              onValueChange={(val) => update({ run: val === "__none__" ? "" : val })}
            >
              <SelectTrigger aria-label="Run stage">
                <SelectValue placeholder="Select Run stage" />
              </SelectTrigger>
              <SelectContent className="fm-inspector-select-content">
                <SelectItem value="__none__">Select Run stage</SelectItem>
                {runs.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InspectorPropertyRow>
          <InspectorPropertyRow label="Peak current [A]">
            <Input
              aria-label="Peak current"
              inputMode="decimal"
              placeholder="0.02"
              value={draft.peak}
              onChange={(e) => update({ peak: e.currentTarget.value })}
            />
          </InspectorPropertyRow>
          <InspectorPropertyRow label="Frequency [Hz]">
            <Input
              aria-label="Frequency"
              inputMode="decimal"
              placeholder="10000000000"
              value={draft.frequency}
              onChange={(e) => update({ frequency: e.currentTarget.value })}
            />
          </InspectorPropertyRow>
        </>
      ) : null}
      {reason && draft.dirty ? (
        <FeedbackBanner kind="warning" message={reason} />
      ) : null}
      {conflict ? (
        <FeedbackBanner
          kind="warning"
          message="Scene changed. Review and explicitly rebase or discard your draft."
        />
      ) : null}
      {feedback?.key === key ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
      <div className="fm-inspector-inline-actions">
        <Button
          disabled={!draft.dirty || pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={discard}
        >
          Discard projection draft
        </Button>
        {conflict && validRevision ? (
          <Button
            disabled={pending || status !== "ready"}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              setLocal({ ...draft, baseRevision: revision, dirty: true });
              setRejected(null);
            }}
          >
            Rebase projection draft
          </Button>
        ) : null}
        <Button
          disabled={!canCreate}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => void create()}
        >
          {draft.mode === "drive"
            ? "Create projection and drive"
            : "Create projection"}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// 5. RadixAntennaSpectrumComposer
// ============================================================================

export function RadixAntennaSpectrumComposer({
  stageId,
  scene,
  sceneScopeKey,
  status,
  refetch,
}: {
  stageId: string;
  scene: SceneResource | null;
  sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const key = JSON.stringify([scope, stageId]);
  const owner = useRef<string | null>(null);
  const inflight = useRef<string | null>(null);
  useLayoutEffect(() => {
    owner.current = key;
    return () => {
      owner.current = null;
    };
  }, [key]);

  const [local, setLocal] = useState<AntennaSpectrumLocalDraft | null>(null);
  const [pendingKey, setPending] = useState<string | null>(null);
  const [rejectedKey, setRejected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    key: string;
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const current =
    scene && (!sceneScopeKey || sceneScopeKey === scope) ? scene : null;
  const revision = current?.revision ?? current?.scene_revision ?? null;
  const validRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const initial: AntennaSpectrumLocalDraft = {
    baseRevision: validRevision ? revision : -1,
    dirty: false,
    key,
    values: emptyAntennaSpectrumDraft,
  };
  const draft = local?.key === key ? local : initial;
  const values = draft.values;
  const pending = pendingKey === key;
  const conflict =
    draft.dirty &&
    !pending &&
    (draft.baseRevision !== revision || rejectedKey === key);

  let request: AuthoringTransactionRequest | null = null;
  let reason: string | null = null;
  try {
    if (!current || !validRevision || status !== "ready") {
      throw new Error("Waiting for the current session-scoped scene.");
    }
    const spectrum = composeAntennaSpectrumRequest(current, stageId, values);
    request = {
      base_revision: draft.baseRevision,
      kind: "merge_patch",
      merge_patch: {
        antenna_spectrum_requests: [
          ...(current.antenna_spectrum_requests ?? []),
          spectrum,
        ],
      },
    };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }

  const canCreate = Boolean(request && draft.dirty && !pending && !conflict);

  function update(patch: Partial<AntennaSpectrumDraft>) {
    if (!current || !validRevision) return;
    setLocal({
      ...draft,
      ...(draft.dirty ? {} : { baseRevision: revision }),
      dirty: true,
      values: { ...values, ...patch },
    });
    setFeedback(null);
  }

  function discard() {
    if (!pending) {
      setLocal(null);
      setRejected(null);
      setFeedback(null);
    }
  }

  async function create(): Promise<void> {
    if (!current || !request || !canCreate || inflight.current === key) return;
    const submitted = draft;
    const transaction = request;
    const isCurrent = () =>
      owner.current === key && makeSessionFence(kernel, scope)();
    if (!isCurrent()) return;
    inflight.current = key;
    setPending(key);
    setFeedback(null);
    const sceneId = current.scene?.id ?? "";
    const validate = (
      response: Parameters<typeof committedAntennaTransactionScene>[0],
    ) =>
      sceneId
        ? committedAntennaTransactionScene(response, transaction, sceneId)
        : (response.committed_scene ?? current);
    try {
      const response = await runAuthoringMutationWithHistory(
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          isCurrentSessionScope: isCurrent,
          resourceData: { [MODEL_SCENE_PATH]: current },
          selection: kernel.selection,
          sessionScopeKey: scope ?? undefined,
        },
        `Create antenna source FFT from ${stageId}`,
        () =>
          kernel.api.model.commitTransaction(
            transaction,
            scope ? { sessionScopeKey: scope } : undefined,
          ),
        validate,
      );
      if (!isCurrent()) return;
      const committedRev =
        typeof response?.scene_revision === "number"
          ? response.scene_revision
          : submitted.baseRevision + 1;
      if (response?.committed_scene) {
        publishCommittedSceneResource(
          kernel.resources,
          validate(response),
          committedRev,
          undefined,
          false,
          scope,
          kernel.api.resourceCacheScope,
        );
      }
      invalidateAuthoringMutationDependents(
        kernel.resources,
        "interaction",
        committedRev,
      );
      setLocal((val) =>
        acknowledgeAntennaSpectrumDraft(val, submitted, committedRev),
      );
      setRejected(null);
      setFeedback({
        key,
        kind: "success",
        message: "Source FFT request saved.",
      });
    } catch (error) {
      if (!isCurrent()) return;
      setRejected(key);
      refetch();
      setFeedback({
        key,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (inflight.current === key) inflight.current = null;
      setPending((val) => (val === key ? null : val));
    }
  }

  return (
    <div className="fm-inspector-stack" data-testid="antenna-spectrum-composer">
      <p className="fm-inspector-hint">
        Author a structured 2D spatial FFT request over the per-ampere antenna field
        basis.
      </p>
      <InspectorPropertyRow label="FFT target object">
        <Select
          value={values.targetObjectId || "__none__"}
          onValueChange={(val) =>
            update({ targetObjectId: val === "__none__" ? "" : val })
          }
        >
          <SelectTrigger aria-label="FFT target object">
            <SelectValue placeholder="Select target object" />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="__none__">Select target object</SelectItem>
            {(current?.objects ?? []).map((obj) => (
              <SelectItem key={obj.id} value={obj.id}>
                {obj.name || obj.id} ({obj.id})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      <RadixSamplingPlaneFields
        values={values}
        onChange={(frame) => update(frame)}
      />
      <InspectorPropertyRow label="Extent u [m]">
        <Input
          aria-label="Extent u"
          inputMode="decimal"
          value={values.extentUM}
          onChange={(e) => update({ extentUM: e.currentTarget.value })}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Extent v [m]">
        <Input
          aria-label="Extent v"
          inputMode="decimal"
          value={values.extentVM}
          onChange={(e) => update({ extentVM: e.currentTarget.value })}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Samples u">
        <Input
          aria-label="Samples u"
          inputMode="numeric"
          value={values.samplesU}
          onChange={(e) => update({ samplesU: e.currentTarget.value })}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Samples v">
        <Input
          aria-label="Samples v"
          inputMode="numeric"
          value={values.samplesV}
          onChange={(e) => update({ samplesV: e.currentTarget.value })}
        />
      </InspectorPropertyRow>
      <RadixSamplingResolution values={values} />
      <InspectorPropertyRow label="Window">
        <Select
          value={values.windowKind}
          onValueChange={(val) =>
            update({ windowKind: val as AntennaSpectrumDraft["windowKind"] })
          }
        >
          <SelectTrigger aria-label="Window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="rectangular">Rectangular</SelectItem>
            <SelectItem value="hann">Hann</SelectItem>
            <SelectItem value="hamming">Hamming</SelectItem>
            <SelectItem value="blackman">Blackman</SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Normalization">
        <Select
          value={values.normalization}
          onValueChange={(val) =>
            update({
              normalization: val as AntennaSpectrumDraft["normalization"],
            })
          }
        >
          <SelectTrigger aria-label="Normalization">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="integral_si">Integral SI</SelectItem>
            <SelectItem value="unitary_discrete">Unitary discrete</SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Component">
        <Select
          value={values.component}
          onValueChange={(val) =>
            update({ component: val as AntennaSpectrumDraft["component"] })
          }
        >
          <SelectTrigger aria-label="Component">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="x">Hx</SelectItem>
            <SelectItem value="y">Hy</SelectItem>
            <SelectItem value="z">Hz</SelectItem>
            <SelectItem value="u">Hu</SelectItem>
            <SelectItem value="v">Hv</SelectItem>
            <SelectItem value="normal">Hnormal</SelectItem>
            <SelectItem value="vector_power">Vector magnitude squared</SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Outside domain">
        <Select
          value={values.outsidePolicy}
          onValueChange={(val) =>
            update({
              outsidePolicy: val as AntennaSpectrumDraft["outsidePolicy"],
            })
          }
        >
          <SelectTrigger aria-label="Outside domain">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="error">Fail request</SelectItem>
            <SelectItem value="zero">Zero outside samples</SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      {reason && draft.dirty ? (
        <FeedbackBanner kind="warning" message={reason} />
      ) : null}
      {conflict ? (
        <FeedbackBanner
          kind="warning"
          message="Scene changed. Review and explicitly rebase or discard the FFT draft."
        />
      ) : null}
      {feedback?.key === key ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
      <div className="fm-inspector-inline-actions">
        <Button
          disabled={!draft.dirty || pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={discard}
        >
          Discard FFT draft
        </Button>
        {conflict && validRevision ? (
          <Button
            disabled={pending || status !== "ready"}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              setLocal({ ...draft, baseRevision: revision, dirty: true });
              setRejected(null);
            }}
          >
            Rebase FFT draft
          </Button>
        ) : null}
        <Button
          disabled={!canCreate}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => void create()}
        >
          Create source FFT request
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// 6. RadixAntennaColorRangeControl
// ============================================================================

export function RadixAntennaColorRangeControl({
  context,
  range,
  data,
  unit,
  disabled,
  onApply,
  scopeDescription = "One scale for points, vectors and surfaces",
}: {
  context: string;
  range?: AntennaColorRange;
  data?: AntennaColorRange;
  unit: string;
  scopeDescription?: string;
  disabled: boolean;
  onApply: (nextRange: AntennaColorRange | undefined) => void;
}): ReactNode {
  const [draftState, setDraft] = useState(() => ({
    context,
    error: "",
    maximum: String(range?.maximum ?? data?.maximum ?? ""),
    minimum: String(range?.minimum ?? data?.minimum ?? ""),
    touched: false,
  }));
  const draft =
    draftState.context === context
      ? draftState
      : {
          context,
          error: "",
          maximum: String(range?.maximum ?? data?.maximum ?? ""),
          minimum: String(range?.minimum ?? data?.minimum ?? ""),
          touched: false,
        };
  const minimum = draft.touched
    ? draft.minimum
    : String(range?.minimum ?? data?.minimum ?? "");
  const maximum = draft.touched
    ? draft.maximum
    : String(range?.maximum ?? data?.maximum ?? "");

  const edit = (key: "minimum" | "maximum", value: string) =>
    setDraft({
      context,
      error: "",
      maximum,
      minimum,
      [key]: value,
      touched: true,
    });

  const apply = () => {
    try {
      const next = parseAntennaColorRange(minimum, maximum);
      onApply(next);
      setDraft({
        context,
        error: "",
        maximum,
        minimum,
        touched: true,
      });
    } catch (error) {
      setDraft({
        context,
        error: error instanceof Error ? error.message : String(error),
        maximum,
        minimum,
        touched: true,
      });
    }
  };

  return (
    <div className="fm-antenna-color-range fm-inspector-stack">
      <p className="fm-inspector-hint" role="status">
        {range
          ? `Manual color range: ${range.minimum.toExponential(4)} … ${range.maximum.toExponential(4)} ${unit}`
          : "Auto color range"}
        . {scopeDescription}; values outside the limits use endpoint colors.
      </p>
      <InspectorPropertyRow label={`Color minimum [${unit}]`}>
        <Input
          aria-label="Color minimum"
          disabled={disabled}
          inputMode="decimal"
          value={minimum}
          onChange={(e) => edit("minimum", e.currentTarget.value)}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label={`Color maximum [${unit}]`}>
        <Input
          aria-label="Color maximum"
          disabled={disabled}
          inputMode="decimal"
          value={maximum}
          onChange={(e) => edit("maximum", e.currentTarget.value)}
        />
      </InspectorPropertyRow>
      {draft.error ? <p role="alert">{draft.error}</p> : null}
      <div className="fm-antenna-color-range__actions flex flex-wrap gap-2">
        <Button
          disabled={disabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={apply}
        >
          Apply color range
        </Button>
        <Button
          disabled={disabled || !range}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            onApply(undefined);
            setDraft({
              context,
              error: "",
              maximum: String(data?.maximum ?? ""),
              minimum: String(data?.minimum ?? ""),
              touched: false,
            });
          }}
        >
          Reset color range to Auto
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";

import { useKernel } from "@/kernel/KernelContext";
import {
  parseQuantityInput,
  type QuantityDimension,
} from "@/kernel/authoring/object-edit/quantityInput";
import {
  fieldDriveMutationResourceKeys,
  useFieldDrivesResource,
} from "@/kernel/resources/fieldDriveResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import { milliTeslaToTesla, teslaToMilliTesla, validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { Button } from "@/shared/ui/Button";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
import { commitRegionalFieldDrive, regionalFieldDriveSamplingContext, regionalFieldDriveSelectorOptions, resolveRegionalFieldDrivePanelModel } from "./RegionalFieldDrivePanelModel";
import { SincPulsePreview } from "./SincPulsePreview";

type FieldDriveSincProfile = Extract<
  RegionalFieldDriveResource["spatial_profile"],
  { kind: "sinc" }
>;
type FieldDriveSincEnvelope = Extract<
  Extract<RegionalFieldDriveResource["spatial_profile"], { kind: "geometry_mask" }>["envelope"],
  { kind: "sinc" }
>;
type SincProfileLike = {
  axis: number[];
  center_m?: number;
  kind: "sinc";
  period_m: number;
  width_m?: number | null;
  window?: string;
};
type FieldDriveRawInputDrafts = Record<string, string>;
type FieldDriveRawInputDraftState = {
  identityKey: string;
  values: FieldDriveRawInputDrafts;
};

const PIECEWISE_POINTS_RAW_KEY = "waveform.piecewise_linear.points";

function parseFiniteFieldDriveNumber(text: string): number | null {
  if (text.trim().length === 0) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Physical dimension of a scalar field-drive input; selects accepted unit suffixes. */
function fieldDriveInputDimension(key: string): QuantityDimension {
  if (/\.(t0|t_on|t_off)$/.test(key)) return "time";
  if (/_hz$/.test(key)) return "frequency";
  if (/_m$/.test(key)) return "length";
  if (/_rad$/.test(key)) return "angle";
  return "dimensionless";
}

function parseFieldDriveNumericInput(
  key: string,
  text: string,
): { valid: true; value: number | null } | { valid: false; value: null } {
  if (key.endsWith(".width_m") && text.trim().length === 0) {
    return { valid: true, value: null };
  }
  // Plain numbers are SI; explicit suffixes such as "50 ps" or "20 GHz" are converted.
  const parsed = parseQuantityInput(text, fieldDriveInputDimension(key));
  return parsed.parseStatus === "valid" && parsed.parsedSI !== null
    ? { valid: true, value: parsed.parsedSI }
    : { valid: false, value: null };
}

function parsePiecewiseLinearDraft(text: string): {
  error: string | null;
  points: number[][] | null;
} {
  const points: number[][] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    const fields = line.trim().split(/[ ,;]+/);
    if (fields.length !== 2) {
      return {
        error: `Waveform line ${index + 1} must contain exactly two values.`,
        points: null,
      };
    }
    const time = parseFiniteFieldDriveNumber(fields[0]);
    const value = parseFiniteFieldDriveNumber(fields[1]);
    if (time === null || value === null) {
      return {
        error: `Waveform line ${index + 1} must contain two complete finite numbers.`,
        points: null,
      };
    }
    points.push([time, value]);
  }
  return { error: null, points };
}

function formatPiecewiseLinearDraft(points: readonly (readonly number[])[]): string {
  return points.map((point) => point.join(", ")).join("\n");
}

function updateSincProfileDraft(
  profile: SincProfileLike,
  field: string,
  value: number | null,
): SincProfileLike {
  const axisMatch = /^axis\.([0-2])$/.exec(field);
  if (axisMatch && value !== null) {
    const axis = [...profile.axis];
    axis[Number(axisMatch[1])] = value;
    return { ...profile, axis };
  }
  if (field === "width_m") return { ...profile, width_m: value };
  if (value === null) return profile;
  if (field === "period_m") return { ...profile, period_m: value };
  if (field === "center_m") return { ...profile, center_m: value };
  return profile;
}

function applyFieldDriveNumericInput(
  drive: RegionalFieldDriveResource,
  key: string,
  value: number | null,
): RegionalFieldDriveResource {
  if (key === "drive.amplitude_mT") {
    return value === null ? drive : { ...drive, amplitude_B_T: milliTeslaToTesla(value) };
  }
  const directionMatch = /^direction\.([0-2])$/.exec(key);
  if (directionMatch && value !== null) {
    const direction = [...drive.direction];
    direction[Number(directionMatch[1])] = value;
    return { ...drive, direction };
  }

  if (key.startsWith("waveform.sinc_pulse.") && drive.waveform.kind === "sinc_pulse" && value !== null) {
    const field = key.slice("waveform.sinc_pulse.".length);
    if (field === "cutoff_hz") return { ...drive, waveform: { ...drive.waveform, cutoff_hz: value } };
    if (field === "t0") return { ...drive, waveform: { ...drive.waveform, t0: value } };
    if (field === "amplitude") return { ...drive, waveform: { ...drive.waveform, amplitude: value } };
  }
  if (key.startsWith("waveform.sinusoidal.") && drive.waveform.kind === "sinusoidal" && value !== null) {
    const field = key.slice("waveform.sinusoidal.".length);
    if (field === "frequency_hz") return { ...drive, waveform: { ...drive.waveform, frequency_hz: value } };
    if (field === "phase_rad") return { ...drive, waveform: { ...drive.waveform, phase_rad: value } };
    if (field === "offset") return { ...drive, waveform: { ...drive.waveform, offset: value } };
  }
  if (key.startsWith("waveform.pulse.") && drive.waveform.kind === "pulse" && value !== null) {
    const field = key.slice("waveform.pulse.".length);
    if (field === "t_on") return { ...drive, waveform: { ...drive.waveform, t_on: value } };
    if (field === "t_off") return { ...drive, waveform: { ...drive.waveform, t_off: value } };
  }

  const profilePrefix = "spatial_profile.sinc.";
  if (key.startsWith(profilePrefix) && drive.spatial_profile.kind === "sinc") {
    const profile = updateSincProfileDraft(drive.spatial_profile, key.slice(profilePrefix.length), value);
    return { ...drive, spatial_profile: profile as FieldDriveSincProfile };
  }
  const envelopePrefix = "spatial_profile.geometry_mask.envelope.sinc.";
  if (
    key.startsWith(envelopePrefix) &&
    drive.spatial_profile.kind === "geometry_mask" &&
    drive.spatial_profile.envelope.kind === "sinc"
  ) {
    const profile = updateSincProfileDraft(
      drive.spatial_profile.envelope,
      key.slice(envelopePrefix.length),
      value,
    );
    return {
      ...drive,
      spatial_profile: {
        ...drive.spatial_profile,
        envelope: profile as FieldDriveSincEnvelope,
      },
    };
  }
  return drive;
}

function applyFieldDriveRawInputs(
  drive: RegionalFieldDriveResource,
  rawInputs: FieldDriveRawInputDrafts,
): RegionalFieldDriveResource {
  let result = drive;
  for (const [key, text] of Object.entries(rawInputs)) {
    if (key === PIECEWISE_POINTS_RAW_KEY) {
      if (result.waveform.kind !== "piecewise_linear") continue;
      const parsed = parsePiecewiseLinearDraft(text);
      if (parsed.points !== null) {
        result = { ...result, waveform: { ...result.waveform, points: parsed.points } };
      }
      continue;
    }
    const parsed = parseFieldDriveNumericInput(key, text);
    if (parsed.valid) result = applyFieldDriveNumericInput(result, key, parsed.value);
  }
  return result;
}

function fieldDriveRawInputError(key: string, text: string): string | null {
  if (key === PIECEWISE_POINTS_RAW_KEY) return parsePiecewiseLinearDraft(text).error;
  return parseFieldDriveNumericInput(key, text).valid
    ? null
    : "Enter a complete finite number (SI, or with a unit such as ps or GHz) before applying.";
}

function rawFieldValue(
  rawInputs: FieldDriveRawInputDrafts,
  key: string,
  value: number | null | undefined,
): string {
  return rawInputs[key] ?? (value == null ? "" : String(value));
}

function rawFieldError(
  rawInputs: FieldDriveRawInputDrafts,
  key: string,
): string | undefined {
  const text = rawInputs[key];
  return text === undefined ? undefined : fieldDriveRawInputError(key, text) ?? undefined;
}

function RawNumberField({
  drafts,
  fieldKey,
  label,
  unit,
  value,
  disabled,
  onChange,
}: {
  drafts: FieldDriveRawInputDrafts;
  fieldKey: string;
  label: string;
  unit?: string;
  value: number | null | undefined;
  disabled: boolean;
  onChange: (key: string, text: string) => void;
}) {
  const error = rawFieldError(drafts, fieldKey);
  return (
    <FormField
      label={label}
      unit={unit}
      type="text"
      inputMode="text"
      autoComplete="off"
      disabled={disabled}
      value={rawFieldValue(drafts, fieldKey, value)}
      error={error}
      invalid={Boolean(error)}
      onChange={(event) => onChange(fieldKey, event.currentTarget.value)}
    />
  );
}

export function RegionalFieldDrivePanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, resources } = kernel;
  const sessionScopeKey = kernel.commands.getSessionScopeKey?.() ?? null;
  const resource = useFieldDrivesResource();
  const scene = useSceneResource();
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );
  const model = useMemo(
    () => resolveRegionalFieldDrivePanelModel(selection, resource.data ?? null),
    [resource.data, selection],
  );
  const drive = model.drive;
  const sourceObjectId = selection.ref?.type === "physics-field-drive" ? selection.ref.sourceObjectId : undefined;
  const transactionIdentityKey = model.mode === "create"
    ? `${sessionScopeKey ?? "no-session"}:create:${sourceObjectId ?? "global"}`
    : `${sessionScopeKey ?? "no-session"}:drive:${drive?.id ?? model.driveId ?? "none"}`;
  const transactionIdentityKeyRef = useRef(transactionIdentityKey);
  transactionIdentityKeyRef.current = transactionIdentityKey;
  const [pendingOperation, setPendingOperation] = useState<{
    identityKey: string;
    id: number;
    sessionScopeKey: string;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rawInputDraftState, setRawInputDraftState] = useState<FieldDriveRawInputDraftState>(
    () => ({ identityKey: transactionIdentityKey, values: {} }),
  );
  const rawInputDrafts = rawInputDraftState.identityKey === transactionIdentityKey
    ? rawInputDraftState.values
    : {};
  const draftKey = model.mode === "create"
    ? `${sessionScopeKey ?? "no-session"}:draft:${sourceObjectId ?? "global"}:${resource.data ? "loaded" : "loading"}`
    : `${sessionScopeKey ?? "no-session"}:${drive?.id ?? "none"}:${model.sceneRevision ?? "none"}`;
  // One field-drive replacement is the transaction boundary. Keep its pending
  // identity stable across scene-revision changes and scope it to this session/drive.
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey &&
    pendingOperation.identityKey === transactionIdentityKey;
  const [draftState, setDraftState] = useState<{
    key: string;
    value: RegionalFieldDriveResource | null;
  }>(() => ({ key: draftKey, value: drive ? structuredClone(drive) : null }));
  const baseDraft =
    draftState.key === draftKey
      ? draftState.value
      : drive
        ? structuredClone(drive)
        : null;
  const draft = baseDraft ? applyFieldDriveRawInputs(baseDraft, rawInputDrafts) : null;
  function setRawInputDraft(key: string, text: string): void {
    setRawInputDraftState((current) => ({
      identityKey: transactionIdentityKey,
      values: {
        ...(current.identityKey === transactionIdentityKey ? current.values : {}),
        [key]: text,
      },
    }));
  }
  function resetRawInputDrafts(identityKey: string): void {
    setRawInputDraftState((current) => current.identityKey === identityKey
      ? { identityKey, values: {} }
      : current);
  }
  function setDraft(
    update: (
      value: RegionalFieldDriveResource | null,
    ) => RegionalFieldDriveResource | null,
  ): void {
    setDraftState((current) => {
      const currentValue =
        current.key === draftKey
          ? current.value
          : drive
            ? structuredClone(drive)
            : null;
      return {
        key: draftKey,
        value: update(currentValue ? applyFieldDriveRawInputs(currentValue, rawInputDrafts) : null),
      };
    });
  }
  const rawInputErrors = Object.entries(rawInputDrafts)
    .map(([key, text]) => fieldDriveRawInputError(key, text))
    .filter((error): error is string => error !== null);
  const hasInvalidWaveformRawDraft = Object.entries(rawInputDrafts).some(
    ([key, text]) => key.startsWith("waveform.") && fieldDriveRawInputError(key, text) !== null,
  );
  const hasInvalidSpatialRawDraft = Object.entries(rawInputDrafts).some(
    ([key, text]) => key.startsWith("spatial_profile.") && fieldDriveRawInputError(key, text) !== null,
  );
  const selectedStageIds = draft?.activation.kind === "stage_ids" ? draft.activation.stage_ids : [];
  const selectedStageIdSet = new Set(selectedStageIds);
  const samplingContext = useMemo(
    () => regionalFieldDriveSamplingContext(scene.data ?? null, draft?.activation ?? null),
    [draft?.activation, scene.data],
  );
  const sincPreview = useMemo(
    () => draft?.waveform.kind === "sinc_pulse" && !hasInvalidWaveformRawDraft
      ? buildSincPulsePreview({
          cutoffHz: draft.waveform.cutoff_hz,
          t0S: draft.waveform.t0 ?? 0,
          waveformAmplitude: draft.waveform.amplitude ?? 1,
          fieldAmplitudeT: draft.amplitude_B_T,
          samplePeriodS: samplingContext.samplePeriodS,
          durationS: samplingContext.durationS,
        })
      : null,
    [draft, hasInvalidWaveformRawDraft, samplingContext.durationS, samplingContext.samplePeriodS],
  );
  const validationErrors = [...new Set([
    ...(draft ? validateFieldDriveDraft(draft) : []),
    ...rawInputErrors,
  ])];
  const dirty = Boolean(
    draft &&
      (model.mode === "create" ||
        (drive && JSON.stringify(draft) !== JSON.stringify(drive))),
  ) || rawInputErrors.length > 0;

  async function save(): Promise<boolean> {
    if (!draft || model.sceneRevision === null) return false;
    if (model.mode !== "create" && model.mode !== "found") return false;
    if (validationErrors.length > 0) {
      if (transactionIdentityKeyRef.current === transactionIdentityKey) {
        setFeedback(validationErrors.join(" "));
      }
      return false;
    }
    const mutationContext = captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
        sourceDetail: "RegionalFieldDrivePanel",
      }),
    );
    const mutationSessionScopeKey = mutationContext.sessionScopeKey;
    if (!mutationSessionScopeKey || mutationContext.isCurrentSessionScope?.() !== true) {
      if (transactionIdentityKeyRef.current === transactionIdentityKey) {
        setFeedback("An active session is required to save this field drive.");
      }
      return false;
    }
    const operationId = ++nextPendingOperationId.current;
    const isCurrentOperation = () =>
      transactionIdentityKeyRef.current === transactionIdentityKey &&
      nextPendingOperationId.current === operationId;
    setPendingOperation({
      identityKey: transactionIdentityKey,
      id: operationId,
      sessionScopeKey: mutationSessionScopeKey,
    });
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        mutationContext,
        `${model.mode === "create" ? "Create" : "Update"} field drive ${draft.id}`,
        ({ baseRevision }) => {
          const committedRevision = baseRevision ?? model.sceneRevision;
          if (
            typeof committedRevision !== "number" ||
            !Number.isSafeInteger(committedRevision) ||
            committedRevision < 0
          ) {
            throw new Error("The canonical scene revision is unavailable. Refetch before saving the field drive.");
          }
          return commitRegionalFieldDrive(
            api.model,
            model.mode as "create" | "found",
            committedRevision,
            draft,
            { sessionScopeKey: mutationSessionScopeKey },
          );
        },
      );
      if (mutationContext.isCurrentSessionScope?.() !== true) return false;
      for (const resourceKey of fieldDriveMutationResourceKeys()) {
        resources.invalidate(resourceKey, response.scene_revision);
      }
      if (!isCurrentOperation()) return false;
      resetRawInputDrafts(transactionIdentityKey);
      if (model.mode === "create") {
        const nodeId = `model:physics:field-drives:${draft.id}`;
        kernel.selection.set({
          kind: "physics.field-drive",
          label: draft.name,
          nodeId,
          objectId: null,
          ref: {
            fieldDriveId: draft.id,
            kind: "physics.field-drive",
            nodeId,
            type: "physics-field-drive",
          },
        }, "inspector");
      }
      setFeedback(model.mode === "create" ? "Field drive created." : "Field drive saved.");
      return true;
    } catch (error) {
      if (
        mutationContext.isCurrentSessionScope?.() !== true ||
        !isCurrentOperation()
      ) return false;
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPendingOperation((current) => current?.id === operationId ? null : current);
    }
  }

  const resetInspectorDraft = useCallback(() => {
    setDraftState({
      key: draftKey,
      value: drive ? structuredClone(drive) : null,
    });
    setRawInputDraftState({ identityKey: transactionIdentityKey, values: {} });
    setFeedback(null);
  }, [draftKey, drive, transactionIdentityKey]);

  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    Boolean(draft && sessionScopeKey && model.sceneRevision !== null && validationErrors.length === 0),
    undefined,
    save,
    resetInspectorDraft,
    {
      historyMode: "mutation-owned",
      applyBlockReason: validationErrors[0],
    },
  );

  const driveTarget = draft?.target;
  const scope = driveTarget?.kind === "region"
    ? {
        kind: "region" as const,
        objectId: driveTarget.object_id,
        regionId: driveTarget.region_id,
        stableRef: `region:${driveTarget.object_id}:${driveTarget.region_id}`,
      }
    : driveTarget?.kind === "object"
      ? {
          kind: "object" as const,
          objectId: driveTarget.object_id,
          stableRef: `object:${driveTarget.object_id}`,
        }
      : { kind: "global" as const, stableRef: "global:physics" };

  return (
    <PhysicsInspectorOverview
      model={buildPhysicsInspectorOverviewModel({
        execution: { sceneRevision: model.sceneRevision },
        family: "field_drive",
        scope,
        source: {
          id: model.driveId ?? draft?.id ?? "none",
          kind: "field_drive",
          status: model.mode === "create" ? "configured" : model.mode === "found" ? drive?.enabled === false ? "inactive" : "active" : "absent",
        },
        status: model.mode === "create" ? "configured" : model.mode === "found" ? drive?.enabled === false ? "inactive" : "active" : "absent",
        statusReason: model.mode === "create" ? "Draft is not committed." : model.mode === "found" ? null : "Selected field drive is unavailable.",
      })}
      primary={<div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Regional field drive" collapsible defaultOpen>
        {model.mode !== "create" && model.mode !== "found" ? <FeedbackBanner kind="warning" message="Selected field drive is unavailable." /> : null}
        {model.mode === "create" ? <FormField label="ID" disabled={!draft || pending} value={draft?.id ?? ""} onChange={(event) => setDraft((value) => value ? { ...value, id: event.target.value } : value)} /> : <FieldRow label="ID" value={model.driveId ?? "none"} />}
        <FormField label="Name" disabled={!draft || pending} value={draft?.name ?? ""} onChange={(event) => setDraft((value) => value ? { ...value, name: event.target.value } : value)} />
        <FormField label="Enabled" type="checkbox" disabled={!draft || pending} checked={draft?.enabled ?? false} onChange={(event) => setDraft((value) => value ? { ...value, enabled: event.target.checked } : value)} />
        <RawNumberField drafts={rawInputDrafts} fieldKey="drive.amplitude_mT" label="Amplitude" unit="mT" disabled={!draft || pending} value={draft ? teslaToMilliTesla(draft.amplitude_B_T) : 0} onChange={setRawInputDraft} />
        <Vector3Field
          label="Direction"
          disabled={!draft || pending}
          values={([0, 1, 2] as const).map((index) => rawFieldValue(rawInputDrafts, `direction.${index}`, (draft?.direction ?? [0, 0, 0])[index])) as [string, string, string]}
          errors={([0, 1, 2] as const).map((index) => rawFieldError(rawInputDrafts, `direction.${index}`))}
          onChange={(index, text) => setRawInputDraft(`direction.${index}`, text)}
        />
        <FormField label="Target" type="select" disabled={!draft || pending} value={draft?.target.kind ?? "global"} onChange={(event) => setDraft((value) => value ? { ...value, target: event.target.value === "global" ? { kind: "global" } : event.target.value === "object" ? { kind: "object", object_id: "" } : { kind: "region", object_id: "", region_id: "" } } : value)}><option value="global">Global</option><option value="object">Object</option><option value="region">Region</option></FormField>
        {draft && draft.target.kind !== "global" ? <FormField label="Object" type="select" disabled={pending} value={draft.target.object_id} onChange={(event) => setDraft((value) => value && value.target.kind !== "global" ? { ...value, target: { ...value.target, object_id: event.target.value, ...(value.target.kind === "region" ? { region_id: "" } : {}) } } : value)}><option value="">Select an object</option>{selectorOptions.objects.map((object) => <option key={object.id} value={object.id}>{object.label}</option>)}</FormField> : null}
        {draft?.target.kind === "region" ? <FormField label="Stable region" type="select" disabled={pending} value={draft.target.region_id} onChange={(event) => setDraft((value) => value?.target.kind === "region" ? { ...value, target: { ...value.target, region_id: event.target.value } } : value)}><option value="">Select a region</option>{(selectorOptions.regionsByObject[draft.target.object_id] ?? []).map((region) => <option key={region.id} value={region.id}>{region.label}</option>)}</FormField> : null}
        <FormField label="Spatial profile" type="select" disabled={!draft || pending || hasInvalidSpatialRawDraft} value={draft?.spatial_profile.kind ?? "uniform"} onChange={(event) => setDraft((value) => value ? { ...value, spatial_profile: event.target.value === "uniform" ? { kind: "uniform" } : event.target.value === "sinc" ? { kind: "sinc", axis: [1, 0, 0], period_m: 1e-7, center_m: 0, window: "none" } : { kind: "geometry_mask", object_id: "", envelope: { kind: "uniform" } } } : value)}><option value="uniform">Uniform</option><option value="sinc">Spatial sinc</option><option value="geometry_mask">Geometry mask</option></FormField>
        {draft?.spatial_profile.kind === "geometry_mask" ? <><FormField label="Mask geometry" type="select" disabled={pending} value={draft.spatial_profile.object_id} onChange={(event) => setDraft((value) => value?.spatial_profile.kind === "geometry_mask" ? { ...value, spatial_profile: { ...value.spatial_profile, object_id: event.target.value } } : value)}><option value="">Select an object</option>{selectorOptions.objects.map((object) => <option key={object.id} value={object.id}>{object.label}</option>)}</FormField><FormField label="Envelope" type="select" disabled={pending || hasInvalidSpatialRawDraft} value={draft.spatial_profile.envelope.kind} onChange={(event) => setDraft((value) => value?.spatial_profile.kind === "geometry_mask" ? { ...value, spatial_profile: { ...value.spatial_profile, envelope: event.target.value === "sinc" ? { kind: "sinc", axis: [1, 0, 0], period_m: 1e-7, center_m: 0, window: "none" } : { kind: "uniform" } } } : value)}><option value="uniform">Uniform</option><option value="sinc">Spatial sinc</option></FormField>{draft.spatial_profile.envelope.kind === "sinc" ? <SpatialSincFields profile={draft.spatial_profile.envelope} prefix="spatial_profile.geometry_mask.envelope.sinc." pending={pending} rawInputs={rawInputDrafts} onRawChange={setRawInputDraft} onWindowChange={(window) => setDraft((value) => value?.spatial_profile.kind === "geometry_mask" && value.spatial_profile.envelope.kind === "sinc" ? { ...value, spatial_profile: { ...value.spatial_profile, envelope: { ...value.spatial_profile.envelope, window } } } : value)} /> : null}</> : null}
        {draft?.spatial_profile.kind === "sinc" ? <SpatialSincFields profile={draft.spatial_profile} prefix="spatial_profile.sinc." pending={pending} rawInputs={rawInputDrafts} onRawChange={setRawInputDraft} onWindowChange={(window) => setDraft((value) => value?.spatial_profile.kind === "sinc" ? { ...value, spatial_profile: { ...value.spatial_profile, window } } : value)} /> : null}
        {feedback ? <FeedbackBanner kind={feedback === "Field drive saved." || feedback === "Field drive created." ? "success" : "error"} message={feedback} /> : null}
      </InspectorGroup>
      <InspectorGroup title="Waveform" collapsible defaultOpen>
        <FormField label="Kind" type="select" disabled={!draft || pending || hasInvalidWaveformRawDraft} value={draft?.waveform.kind ?? "constant"} onChange={(event) => setDraft((value) => value ? { ...value, waveform: event.target.value === "constant" ? { kind: "constant" } : event.target.value === "sinusoidal" ? { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0, offset: 0 } : event.target.value === "pulse" ? { kind: "pulse", t_on: 0, t_off: 1e-9 } : event.target.value === "piecewise_linear" ? { kind: "piecewise_linear", points: [[0, 0], [1e-9, 1]] } : { kind: "sinc_pulse", cutoff_hz: 20e9, t0: 50e-12, amplitude: 1 } } : value)}><option value="constant">Constant</option><option value="sinusoidal">Sinusoidal</option><option value="pulse">Pulse</option><option value="piecewise_linear">Piecewise linear</option><option value="sinc_pulse">Sinc pulse</option></FormField>
        <FormField label="Time origin" type="select" disabled={!draft || pending} value={draft?.time_origin ?? "stage_local"} onChange={(event) => setDraft((value) => value ? { ...value, time_origin: event.target.value as "stage_local" | "absolute" } : value)}><option value="stage_local">Stage local</option><option value="absolute">Absolute</option></FormField>
        {draft?.waveform.kind === "sinc_pulse" ? (
          <>
            <FieldRow label="Definition" value="a sinc(2 fc (t - t0))" />
            <RawNumberField drafts={rawInputDrafts} fieldKey="waveform.sinc_pulse.cutoff_hz" label="Cutoff" unit="Hz" disabled={pending} value={draft.waveform.cutoff_hz} onChange={setRawInputDraft} />
            <RawNumberField drafts={rawInputDrafts} fieldKey="waveform.sinc_pulse.t0" label="Center t0" unit="s" disabled={pending} value={draft.waveform.t0 ?? 0} onChange={setRawInputDraft} />
            <RawNumberField drafts={rawInputDrafts} fieldKey="waveform.sinc_pulse.amplitude" label="Waveform amplitude" disabled={pending} value={draft.waveform.amplitude ?? 1} onChange={setRawInputDraft} />
            {sincPreview ? <SincPulsePreview model={sincPreview} solverDtS={samplingContext.solverDtS} /> : null}
          </>
        ) : null}
        {draft?.waveform.kind === "sinusoidal" ? <><RawNumberField drafts={rawInputDrafts} fieldKey="waveform.sinusoidal.frequency_hz" label="Frequency" unit="Hz" disabled={pending} value={draft.waveform.frequency_hz} onChange={setRawInputDraft} /><RawNumberField drafts={rawInputDrafts} fieldKey="waveform.sinusoidal.phase_rad" label="Phase" unit="rad" disabled={pending} value={draft.waveform.phase_rad ?? 0} onChange={setRawInputDraft} /><RawNumberField drafts={rawInputDrafts} fieldKey="waveform.sinusoidal.offset" label="Offset" disabled={pending} value={draft.waveform.offset ?? 0} onChange={setRawInputDraft} /></> : null}
        {draft?.waveform.kind === "pulse" ? <><RawNumberField drafts={rawInputDrafts} fieldKey="waveform.pulse.t_on" label="On time" unit="s" disabled={pending} value={draft.waveform.t_on} onChange={setRawInputDraft} /><RawNumberField drafts={rawInputDrafts} fieldKey="waveform.pulse.t_off" label="Off time" unit="s" disabled={pending} value={draft.waveform.t_off} onChange={setRawInputDraft} /></> : null}
        {draft?.waveform.kind === "piecewise_linear" ? <FormField label="Points (time, value)" type="textarea" disabled={pending} rows={5} value={rawInputDrafts[PIECEWISE_POINTS_RAW_KEY] ?? formatPiecewiseLinearDraft(draft.waveform.points)} error={rawFieldError(rawInputDrafts, PIECEWISE_POINTS_RAW_KEY)} invalid={Boolean(rawFieldError(rawInputDrafts, PIECEWISE_POINTS_RAW_KEY))} onChange={(event) => setRawInputDraft(PIECEWISE_POINTS_RAW_KEY, event.currentTarget.value)} /> : null}
      </InspectorGroup>
      <InspectorGroup title="Stage activation" collapsible defaultOpen>
        <FormField label="Mode" type="select" disabled={!draft || pending} value={draft?.activation.kind ?? "all_time_evolution"} onChange={(event) => setDraft((value) => value ? { ...value, activation: event.target.value === "stage_ids" ? { kind: "stage_ids", stage_ids: [] } : { kind: "all_time_evolution" } } : value)}><option value="all_time_evolution">All time stages</option><option value="stage_ids">Selected stages</option></FormField>
        {draft?.activation.kind === "stage_ids" ? <div className="grid min-w-0 gap-fm-inspector-row">{selectorOptions.timeEvolutionStages.map((stage) => <FormField key={stage.id} label={stage.label} type="checkbox" disabled={pending} checked={selectedStageIdSet.has(stage.id)} onChange={(event) => setDraft((value) => { if (value?.activation.kind !== "stage_ids") return value; const stageIds = event.target.checked ? [...value.activation.stage_ids, stage.id] : value.activation.stage_ids.filter((id) => id !== stage.id); return { ...value, activation: { kind: "stage_ids", stage_ids: stageIds } }; })} />)}{selectorOptions.timeEvolutionStages.length === 0 ? <><FeedbackBanner kind="warning" message="No run stage with a stable ID is available. Add a run stage before assigning this drive." /><AddRunStageAction scene={scene.data ?? null} /></> : null}</div> : <FieldRow label="Stages" value="all time-evolution stages" />}
      </InspectorGroup>
    </div>}
    />
  );
}

function SpatialSincFields({
  profile,
  prefix,
  pending,
  rawInputs,
  onRawChange,
  onWindowChange,
}: {
  profile: SincProfileLike;
  prefix: string;
  pending: boolean;
  rawInputs: FieldDriveRawInputDrafts;
  onRawChange: (key: string, text: string) => void;
  onWindowChange: (window: string) => void;
}) {
  const axisKeys = ([0, 1, 2] as const).map((index) => `${prefix}axis.${index}`);
  return <>
    <Vector3Field
      label="Spatial axis"
      disabled={pending}
      values={([0, 1, 2] as const).map((index) => rawFieldValue(rawInputs, axisKeys[index], profile.axis[index])) as [string, string, string]}
      errors={axisKeys.map((key) => rawFieldError(rawInputs, key))}
      onChange={(index, text) => onRawChange(axisKeys[index], text)}
    />
    <RawNumberField drafts={rawInputs} fieldKey={`${prefix}period_m`} label="Spatial period" unit="m" disabled={pending} value={profile.period_m} onChange={onRawChange} />
    <RawNumberField drafts={rawInputs} fieldKey={`${prefix}center_m`} label="Spatial center" unit="m" disabled={pending} value={profile.center_m ?? 0} onChange={onRawChange} />
    <RawNumberField drafts={rawInputs} fieldKey={`${prefix}width_m`} label="Spatial width" unit="m" disabled={pending} value={profile.width_m} onChange={onRawChange} />
    <FormField label="Window" type="select" disabled={pending} value={profile.window ?? "none"} onChange={(event) => onWindowChange(event.target.value)}><option value="none">None</option><option value="hann">Hann</option></FormField>
  </>;
}

/** Empty-state CTA: runs the canonical Study command instead of only describing it. */
function AddRunStageAction({ scene }: { readonly scene: unknown }) {
  const kernel = useKernel();
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    includeSharedDomainReadiness: false,
    includeStageExecution: false,
  });
  const context = createCommandContext("inspector", kernel, {
    resourceData: { ...runtimeResourceData, [MODEL_SCENE_PATH]: scene },
    // The shell presenter reports failures; this surface has no inline result line.
    feedback: "foreground",
    sourceDetail: "RegionalFieldDrivePanel.empty-stages",
  });
  const command = kernel.commands.get("study.add-run-stage");
  if (!command) return null;
  const enabled = kernel.commands.isEnabled(command.id, context);
  return (
    <Button
      disabled={!enabled}
      disabledReason={enabled ? null : (command.disabledReason?.(context) ?? null)}
      size="sm"
      type="button"
      variant="secondary"
      onClick={() => void kernel.commands.execute(command.id, context)}
    >
      Add run stage
    </Button>
  );
}

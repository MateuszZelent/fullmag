"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  MaskFieldDriveResource,
  MaskFunctionResource,
  MaskTermResource,
  ReadyAntennaResource,
} from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  maskAntennaMutationResourceKeys,
  useMaskFieldDrivesResource,
  useReadyAntennasResource,
} from "@/kernel/resources/maskAntennaResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  addTerm,
  addTermParameter,
  commitMaskAntenna,
  defaultMaskShape,
  maskAntennaSummary,
  MAX_MASK_TERMS,
  readyAntennaCalls,
  readyAntennaDefaultArguments,
  removeTerm,
  removeTermParameter,
  replaceReadyAntennaCall,
  resolveMaskAntennaPanelModel,
  setTermLocal,
  setTermName,
  setTermOutput,
  setTermParameter,
  setTermStatic,
  termFunction,
  validateMaskAntennaDraft,
  type MaskFunctionRole,
  type MaskShapeKind,
} from "./MaskAntennaPanelModel";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
import { regionalFieldDriveSelectorOptions } from "./RegionalFieldDrivePanelModel";

type RawInputs = Record<string, string>;

const MASK_OUTPUT_LABELS = ["Bx", "By", "Bz"] as const;
const NEW_READY_CALL = "new";

function maskAntennaNodeId(driveId: string): string {
  return `model:physics:mask-antennas:${driveId}`;
}

function maskAntennaSelection(
  drive: { id: string; name: string },
): Omit<Selection, "moduleSource"> {
  const nodeId = maskAntennaNodeId(drive.id);
  return {
    kind: "physics.field-drive",
    label: drive.name || drive.id,
    nodeId,
    objectId: null,
    ref: {
      fieldDriveId: drive.id,
      fieldDriveKind: "mask",
      kind: "physics.field-drive",
      nodeId,
      type: "physics-field-drive",
    },
  };
}

function maskAntennaDraftSelection(): Omit<Selection, "moduleSource"> {
  const nodeId = "model:physics:mask-antenna:draft";
  return {
    kind: "physics.field-drive",
    label: "New mask antenna",
    nodeId,
    objectId: null,
    ref: {
      draft: true,
      fieldDriveKind: "mask",
      kind: "physics.field-drive",
      nodeId,
      type: "physics-field-drive",
    },
  };
}

/** Plain SI numbers only; an empty or partial text is not a value. */
function parseFiniteNumber(text: string): number | null {
  if (text.trim().length === 0) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function rawValue(raw: RawInputs, key: string, value: number | undefined): string {
  return raw[key] ?? (value === undefined ? "" : String(value));
}

function rawError(raw: RawInputs, key: string): string | undefined {
  const text = raw[key];
  return text !== undefined && parseFiniteNumber(text) === null
    ? "Enter a finite number in SI units."
    : undefined;
}

function withComponent(values: readonly number[], index: number, value: number): number[] {
  return values.map((current, position) => (position === index ? value : current));
}

/** Apply one numeric draft, addressed by its field key, to the antenna. */
function applyNumericInput(
  drive: MaskFieldDriveResource,
  key: string,
  value: number,
): MaskFieldDriveResource {
  const [scope, ...rest] = key.split("|");
  if (scope === "position") {
    return { ...drive, position_m: withComponent(drive.position_m, Number(rest[0]), value) };
  }
  if (scope === "shape") {
    const shape = drive.shape;
    const [field, component] = rest;
    if (field === "center") {
      return { ...drive, shape: { ...shape, center: withComponent(shape.center, Number(component), value) } };
    }
    if (field === "size" && shape.kind === "box") {
      return { ...drive, shape: { ...shape, size: withComponent(shape.size, Number(component), value) } };
    }
    if (field === "axis" && shape.kind === "cylinder") {
      return { ...drive, shape: { ...shape, axis: withComponent(shape.axis, Number(component), value) } };
    }
    if (field === "radius" && shape.kind !== "box") {
      return { ...drive, shape: { ...shape, radius: value } };
    }
    if (field === "height" && shape.kind === "cylinder") {
      return { ...drive, shape: { ...shape, height: value } };
    }
    return drive;
  }
  if (scope === "term") {
    const [termIndex, role, name] = rest;
    return setTermParameter(drive, Number(termIndex), role as MaskFunctionRole, name, value);
  }
  return drive;
}

function applyRawInputs(drive: MaskFieldDriveResource, raw: RawInputs): MaskFieldDriveResource {
  let result = drive;
  for (const [key, text] of Object.entries(raw)) {
    const value = parseFiniteNumber(text);
    if (value !== null) result = applyNumericInput(result, key, value);
  }
  return result;
}

function RawNumberField({
  disabled,
  fieldKey,
  label,
  onChange,
  raw,
  unit,
  value,
}: {
  disabled: boolean;
  fieldKey: string;
  label: string;
  onChange: (key: string, text: string) => void;
  raw: RawInputs;
  unit?: string;
  value: number | undefined;
}) {
  const error = rawError(raw, fieldKey);
  return (
    <FormField
      label={label}
      unit={unit}
      type="text"
      inputMode="text"
      autoComplete="off"
      disabled={disabled}
      value={rawValue(raw, fieldKey, value)}
      error={error}
      invalid={Boolean(error)}
      onChange={(event) => onChange(fieldKey, event.currentTarget.value)}
    />
  );
}

function RawVectorField({
  disabled,
  keyPrefix,
  label,
  onChange,
  raw,
  values,
}: {
  disabled: boolean;
  keyPrefix: string;
  label: string;
  onChange: (key: string, text: string) => void;
  raw: RawInputs;
  values: readonly number[];
}) {
  const keys = ([0, 1, 2] as const).map((index) => `${keyPrefix}|${index}`);
  return (
    <Vector3Field
      label={label}
      disabled={disabled}
      values={keys.map((key, index) => rawValue(raw, key, values[index])) as [string, string, string]}
      errors={keys.map((key) => rawError(raw, key))}
      onChange={(index, text) => onChange(keys[index], text)}
    />
  );
}

/** Parameters, local equations and outputs of one mask or time function. */
function FunctionFields({
  disabled,
  onLocalChange,
  onOutputChange,
  onParameterAdd,
  onParameterRemove,
  onRawChange,
  raw,
  role,
  target,
  termIndex,
}: {
  disabled: boolean;
  onLocalChange: (localIndex: number, expression: string) => void;
  onOutputChange: (outputIndex: number, expression: string) => void;
  onParameterAdd: (name: string) => void;
  onParameterRemove: (name: string) => void;
  onRawChange: (key: string, text: string) => void;
  raw: RawInputs;
  role: MaskFunctionRole;
  target: MaskFunctionResource;
  termIndex: number;
}) {
  const [newParameter, setNewParameter] = useState("");
  const parameters = target.parameters ?? [];
  const canAdd = /^[A-Za-z_][A-Za-z0-9_]*$/.test(newParameter) &&
    !parameters.some((parameter) => parameter.name === newParameter);
  return (
    <>
      <FieldRow label={role === "mask" ? "Mask function" : "Time function"} value={target.name ?? "unnamed"} />
      {parameters.map((parameter) => (
        <div key={parameter.name} className="grid min-w-0 gap-fm-inspector-row">
          <RawNumberField
            raw={raw}
            fieldKey={`term|${termIndex}|${role}|${parameter.name}`}
            label={parameter.name}
            disabled={disabled}
            value={parameter.value}
            onChange={onRawChange}
          />
          <div className="fm-inspector-toolbar">
            <Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => onParameterRemove(parameter.name)}>
              Remove {parameter.name}
            </Button>
          </div>
        </div>
      ))}
      <FormField
        label="New parameter"
        disabled={disabled}
        value={newParameter}
        onChange={(event) => setNewParameter(event.currentTarget.value)}
      />
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={disabled || !canAdd}
          onClick={() => {
            onParameterAdd(newParameter);
            setNewParameter("");
          }}
        >
          Add parameter
        </Button>
      </div>
      {(target.locals ?? []).map((local, index) => (
        <FormField
          key={local.name}
          label={`${local.name} =`}
          disabled={disabled}
          value={local.expression}
          onChange={(event) => onLocalChange(index, event.currentTarget.value)}
        />
      ))}
      {target.outputs.map((output, index) => (
        <FormField
          key={index}
          label={role === "mask" ? `${MASK_OUTPUT_LABELS[index] ?? `B${index}`} =` : "f(t) ="}
          unit={role === "mask" ? "T" : undefined}
          disabled={disabled}
          value={output}
          onChange={(event) => onOutputChange(index, event.currentTarget.value)}
        />
      ))}
    </>
  );
}

function ArrayMaskRows({ mask }: { mask: Extract<MaskTermResource["mask"], { kind: "sampled" }> }) {
  return (
    <>
      <FieldRow label="Mask" value="array (written by a loop), read-only" />
      <FieldRow label="Lattice" value={mask.size.join(" x ")} />
      <FieldRow label="Cell" value={`${mask.cell_m.join(", ")} m`} />
      <FieldRow label="Origin" value={`${mask.origin_m.join(", ")} m`} />
      <FieldRow label="SHA-256" value={mask.sha256.slice(0, 16)} />
    </>
  );
}

/** Argument form of one ready-antenna call; builds its terms through the API. */
function ReadyAntennaCallFields({
  antenna,
  busy,
  disabled,
  onBuild,
  title,
  values,
}: {
  antenna: ReadyAntennaResource;
  busy: boolean;
  disabled: boolean;
  onBuild: (values: Record<string, number>) => void;
  title: string;
  values: Record<string, number>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const parsed: Record<string, number> = {};
  let missing: string | null = null;
  let invalid = false;
  for (const argument of antenna.arguments) {
    const text = drafts[argument.name] ??
      (values[argument.name] === undefined ? "" : String(values[argument.name]));
    if (text.trim().length === 0) {
      if (typeof argument.default !== "number" && argument.name !== "sigma_x") {
        missing ??= argument.name;
      }
      continue;
    }
    const value = parseFiniteNumber(text);
    if (value === null) invalid = true;
    else parsed[argument.name] = value;
  }
  return (
    <InspectorGroup title={title} collapsible defaultOpen>
      <FieldRow label="Function" value={antenna.function} />
      {antenna.arguments.map((argument) => {
        const text = drafts[argument.name] ??
          (values[argument.name] === undefined ? "" : String(values[argument.name]));
        const error = text.trim().length > 0 && parseFiniteNumber(text) === null
          ? "Enter a finite number in SI units."
          : undefined;
        return (
          <FormField
            key={argument.name}
            label={argument.name}
            unit={argument.unit}
            hint={argument.doc}
            disabled={disabled || busy}
            value={text}
            error={error}
            invalid={Boolean(error)}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDrafts((current) => ({ ...current, [argument.name]: next }));
            }}
          />
        );
      })}
      <div className="fm-inspector-toolbar fm-toolbar-top">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          disabled={disabled || busy || invalid || missing !== null}
          disabledReason={missing ? `Give ${missing}.` : null}
          onClick={() => onBuild(parsed)}
        >
          {busy ? "Building terms…" : "Build terms"}
        </Button>
      </div>
    </InspectorGroup>
  );
}

/** List of the scene's mask antennas with the "new antenna" action. */
export function MaskAntennaListSection() {
  const kernel = useKernel();
  const resource = useMaskFieldDrivesResource();
  const drives = resource.data?.drives ?? [];
  return (
    <InspectorGroup title="Mask Antennas" collapsible defaultOpen>
      {drives.length === 0 ? (
        <FieldRow label="Antennas" value="no mask antennas authored" />
      ) : (
        drives.map((drive) => (
          <div key={drive.id} className="fm-region-override fm-section-separator">
            <FieldRow label={drive.name || drive.id} value={maskAntennaSummary(drive)} />
            <FieldRow
              label="Target"
              value={
                drive.target.kind === "region"
                  ? `${drive.target.object_id} / ${drive.target.region_id}`
                  : drive.target.kind === "object"
                    ? drive.target.object_id
                    : "global"
              }
            />
            <div className="fm-inspector-toolbar fm-toolbar-top">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => kernel.selection.set(maskAntennaSelection(drive), "inspector")}
              >
                Inspect Antenna
              </Button>
            </div>
          </div>
        ))
      )}
      <div className="fm-inspector-toolbar fm-toolbar-top-lg">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => kernel.selection.set(maskAntennaDraftSelection(), "inspector")}
        >
          New Mask Antenna
        </Button>
      </div>
    </InspectorGroup>
  );
}

export function MaskAntennaPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, resources } = kernel;
  const sessionScopeKey = kernel.commands.getSessionScopeKey?.() ?? null;
  const resource = useMaskFieldDrivesResource();
  const regional = useFieldDrivesResource();
  const readyAntennas = useReadyAntennasResource();
  const scene = useSceneResource();
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );
  const regionalIds = useMemo(
    () => (regional.data?.drives ?? []).map((drive) => drive.id),
    [regional.data],
  );
  const model = useMemo(
    () => resolveMaskAntennaPanelModel(selection, resource.data ?? null, regionalIds),
    [regionalIds, resource.data, selection],
  );
  const drive = model.drive;
  const identityKey = model.mode === "create"
    ? `${sessionScopeKey ?? "no-session"}:mask:create`
    : `${sessionScopeKey ?? "no-session"}:mask:${drive?.id ?? model.driveId ?? "none"}`;
  const identityKeyRef = useRef(identityKey);
  useLayoutEffect(() => {
    identityKeyRef.current = identityKey;
  }, [identityKey]);
  const draftKey = model.mode === "create"
    ? `${identityKey}:${resource.data ? "loaded" : "loading"}`
    : `${identityKey}:${model.sceneRevision ?? "none"}`;
  const [draftState, setDraftState] = useState<{
    key: string;
    value: MaskFieldDriveResource | null;
  }>(() => ({ key: draftKey, value: drive ? structuredClone(drive) : null }));
  const [rawState, setRawState] = useState<{ identityKey: string; values: RawInputs }>(
    () => ({ identityKey, values: {} }),
  );
  const [pendingId, setPendingId] = useState<number | null>(null);
  const nextOperationId = useRef(0);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [readyBusy, setReadyBusy] = useState<string | null>(null);
  const [newReadyFunction, setNewReadyFunction] = useState("");

  const raw = rawState.identityKey === identityKey ? rawState.values : {};
  const baseDraft = draftState.key === draftKey
    ? draftState.value
    : drive
      ? structuredClone(drive)
      : null;
  const draft = baseDraft ? applyRawInputs(baseDraft, raw) : null;
  const pending = pendingId !== null;
  const locked = !draft || pending;

  function setRaw(key: string, text: string): void {
    setRawState((current) => ({
      identityKey,
      values: {
        ...(current.identityKey === identityKey ? current.values : {}),
        [key]: text,
      },
    }));
  }
  function setDraft(
    update: (value: MaskFieldDriveResource) => MaskFieldDriveResource,
  ): void {
    setDraftState((current) => {
      const currentValue = current.key === draftKey
        ? current.value
        : drive
          ? structuredClone(drive)
          : null;
      return {
        key: draftKey,
        value: currentValue ? update(applyRawInputs(currentValue, raw)) : null,
      };
    });
    // Structural edits fold the numeric drafts into the antenna.
    setRawState({ identityKey, values: {} });
  }

  const rawErrors = Object.keys(raw).flatMap((key) => rawError(raw, key) ?? []);
  const validationErrors = [...new Set([
    ...(draft ? validateMaskAntennaDraft(draft) : []),
    ...rawErrors,
  ])];
  const dirty = Boolean(
    draft &&
      (model.mode === "create" ||
        (drive && JSON.stringify(draft) !== JSON.stringify(drive))),
  ) || rawErrors.length > 0;

  function mutationContext() {
    return captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
        sourceDetail: "MaskAntennaPanel",
      }),
    );
  }

  async function runMutation(
    label: string,
    mutate: (baseRevision: number, scopeKey: string) => Promise<{ scene_revision: number }>,
    onDone: () => void,
  ): Promise<boolean> {
    const context = mutationContext();
    const scopeKey = context.sessionScopeKey;
    if (!scopeKey || context.isCurrentSessionScope?.() !== true) {
      setFeedback({ kind: "error", message: "An active session is required to change this antenna." });
      return false;
    }
    const operationId = ++nextOperationId.current;
    const isCurrent = () =>
      identityKeyRef.current === identityKey && nextOperationId.current === operationId;
    setPendingId(operationId);
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        context,
        label,
        ({ baseRevision }) => {
          const revision = baseRevision ?? model.sceneRevision;
          if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
            throw new Error("The scene revision is unavailable. Refetch before changing the antenna.");
          }
          return mutate(revision, scopeKey);
        },
      );
      if (context.isCurrentSessionScope?.() !== true) return false;
      for (const resourceKey of maskAntennaMutationResourceKeys()) {
        resources.invalidate(resourceKey, response.scene_revision);
      }
      if (!isCurrent()) return false;
      onDone();
      return true;
    } catch (error) {
      if (context.isCurrentSessionScope?.() !== true || !isCurrent()) return false;
      // The server reports each equation error with its path, for example
      // "expr_unknown_name: drive.terms[0].mask.outputs[1] @4: ...".
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setPendingId((current) => (current === operationId ? null : current));
    }
  }

  async function save(): Promise<boolean> {
    if (!draft || (model.mode !== "create" && model.mode !== "found")) return false;
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors.join(" ") });
      return false;
    }
    const mode = model.mode;
    return runMutation(
      `${mode === "create" ? "Create" : "Update"} mask antenna ${draft.id}`,
      (baseRevision, scopeKey) =>
        commitMaskAntenna(api.model, mode, baseRevision, draft, { sessionScopeKey: scopeKey }),
      () => {
        setRawState({ identityKey, values: {} });
        if (mode === "create") kernel.selection.set(maskAntennaSelection(draft), "inspector");
        setFeedback({
          kind: "success",
          message: mode === "create" ? "Mask antenna created." : "Mask antenna saved.",
        });
      },
    );
  }

  async function removeAntenna(): Promise<void> {
    if (!drive || model.mode !== "found") return;
    await runMutation(
      `Delete mask antenna ${drive.id}`,
      (baseRevision, scopeKey) =>
        api.model.deleteMaskFieldDrive(drive.id, { base_revision: baseRevision }, { sessionScopeKey: scopeKey }),
      () => {
        kernel.selection.set({
          kind: "physics.field-drives",
          label: "Field Drives",
          nodeId: "model:physics:field-drives",
          objectId: null,
        }, "inspector");
      },
    );
  }

  async function buildReadyAntennaTerms(
    antenna: ReadyAntennaResource,
    callIndex: number | null,
    values: Record<string, number>,
  ): Promise<void> {
    const busyKey = callIndex === null ? NEW_READY_CALL : String(callIndex);
    setReadyBusy(busyKey);
    setFeedback(null);
    try {
      const response = await api.model.readyAntennaTerms(
        { arguments: values, function: antenna.function },
        sessionScopeKey ? { sessionScopeKey } : undefined,
      );
      if (identityKeyRef.current !== identityKey) return;
      setDraft((value) => replaceReadyAntennaCall(value, callIndex, response.terms));
      if (callIndex === null) setNewReadyFunction("");
    } catch (error) {
      if (identityKeyRef.current !== identityKey) return;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setReadyBusy((current) => (current === busyKey ? null : current));
    }
  }

  const resetDraft = useCallback(() => {
    setDraftState({ key: draftKey, value: drive ? structuredClone(drive) : null });
    setRawState({ identityKey, values: {} });
    setFeedback(null);
  }, [draftKey, drive, identityKey]);

  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    Boolean(draft && sessionScopeKey && model.sceneRevision !== null && validationErrors.length === 0),
    undefined,
    save,
    resetDraft,
    { historyMode: "mutation-owned", applyBlockReason: validationErrors[0] },
  );

  const target = draft?.target;
  const scope = target?.kind === "region"
    ? {
        kind: "region" as const,
        objectId: target.object_id,
        regionId: target.region_id,
        stableRef: `region:${target.object_id}:${target.region_id}`,
      }
    : target?.kind === "object"
      ? { kind: "object" as const, objectId: target.object_id, stableRef: `object:${target.object_id}` }
      : { kind: "global" as const, stableRef: "global:physics" };
  const status = model.mode === "create"
    ? "configured"
    : model.mode === "found"
      ? drive?.enabled === false ? "inactive" : "active"
      : "absent";
  const registry = readyAntennas.data?.antennas ?? [];
  const calls = draft ? readyAntennaCalls(draft) : [];
  const newReadyAntenna = registry.find((antenna) => antenna.function === newReadyFunction) ?? null;
  const shape = draft?.shape;

  return (
    <PhysicsInspectorOverview
      model={buildPhysicsInspectorOverviewModel({
        execution: { sceneRevision: model.sceneRevision },
        family: "field_drive",
        scope,
        source: { id: model.driveId ?? draft?.id ?? "none", kind: "field_drive", status },
        status,
        statusReason: model.mode === "create"
          ? "Draft is not committed."
          : model.mode === "found" ? null : "Selected mask antenna is unavailable.",
      })}
      primary={
        <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
          <InspectorGroup title="Mask antenna" collapsible defaultOpen>
            {model.mode !== "create" && model.mode !== "found"
              ? <FeedbackBanner kind="warning" message="Selected mask antenna is unavailable." />
              : null}
            {model.mode === "create"
              ? <FormField label="ID" disabled={locked} value={draft?.id ?? ""} onChange={(event) => { const id = event.currentTarget.value; setDraft((value) => ({ ...value, id })); }} />
              : <FieldRow label="ID" value={model.driveId ?? "none"} />}
            <FormField label="Name" disabled={locked} value={draft?.name ?? ""} onChange={(event) => { const name = event.currentTarget.value; setDraft((value) => ({ ...value, name })); }} />
            <FormField label="Enabled" type="checkbox" disabled={locked} checked={draft?.enabled ?? false} onChange={(event) => { const enabled = event.currentTarget.checked; setDraft((value) => ({ ...value, enabled })); }} />
            <FormField
              label="Target"
              type="select"
              disabled={locked}
              value={draft?.target.kind ?? "global"}
              onChange={(event) => {
                const kind = event.currentTarget.value;
                setDraft((value) => ({
                  ...value,
                  target: kind === "object"
                    ? { kind: "object", object_id: "" }
                    : kind === "region"
                      ? { kind: "region", object_id: "", region_id: "" }
                      : { kind: "global" },
                }));
              }}
            >
              <option value="global">Global</option>
              <option value="object">Object</option>
              <option value="region">Region</option>
            </FormField>
            {draft && draft.target.kind !== "global" ? (
              <FormField
                label="Object"
                type="select"
                disabled={pending}
                value={draft.target.object_id}
                onChange={(event) => {
                  const objectId = event.currentTarget.value;
                  setDraft((value) => value.target.kind === "global" ? value : {
                    ...value,
                    target: value.target.kind === "region"
                      ? { kind: "region", object_id: objectId, region_id: "" }
                      : { kind: "object", object_id: objectId },
                  });
                }}
              >
                <option value="">Select an object</option>
                {selectorOptions.objects.map((object) => <option key={object.id} value={object.id}>{object.label}</option>)}
              </FormField>
            ) : null}
            {draft?.target.kind === "region" ? (
              <FormField
                label="Stable region"
                type="select"
                disabled={pending}
                value={draft.target.region_id}
                onChange={(event) => {
                  const regionId = event.currentTarget.value;
                  setDraft((value) => value.target.kind === "region"
                    ? { ...value, target: { ...value.target, region_id: regionId } }
                    : value);
                }}
              >
                <option value="">Select a region</option>
                {(selectorOptions.regionsByObject[draft.target.object_id] ?? []).map((region) => <option key={region.id} value={region.id}>{region.label}</option>)}
              </FormField>
            ) : null}
            <FormField label="Frame" type="select" disabled={locked} value={draft?.frame ?? "world"} onChange={(event) => { const frame = event.currentTarget.value as "world" | "local"; setDraft((value) => ({ ...value, frame })); }}>
              <option value="world">World</option>
              <option value="local">Local (target object)</option>
            </FormField>
            <FormField label="Time origin" type="select" disabled={locked} value={draft?.time_origin ?? "stage_local"} onChange={(event) => { const origin = event.currentTarget.value as "stage_local" | "absolute"; setDraft((value) => ({ ...value, time_origin: origin })); }}>
              <option value="stage_local">Stage local</option>
              <option value="absolute">Absolute</option>
            </FormField>
            {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
          </InspectorGroup>

          <InspectorGroup title="Support shape" collapsible defaultOpen>
            <FormField label="Shape" type="select" disabled={locked} value={shape?.kind ?? "box"} onChange={(event) => { const kind = event.currentTarget.value as MaskShapeKind; setDraft((value) => ({ ...value, shape: defaultMaskShape(kind) })); }}>
              <option value="box">Box</option>
              <option value="cylinder">Cylinder</option>
              <option value="sphere">Sphere</option>
            </FormField>
            <RawVectorField raw={raw} keyPrefix="position" label="Position (m)" disabled={locked} values={draft?.position_m ?? [0, 0, 0]} onChange={setRaw} />
            {shape?.kind === "box" ? <RawVectorField raw={raw} keyPrefix="shape|size" label="Size (m)" disabled={locked} values={shape.size} onChange={setRaw} /> : null}
            {shape && shape.kind !== "box" ? <RawNumberField raw={raw} fieldKey="shape|radius" label="Radius" unit="m" disabled={locked} value={shape.radius} onChange={setRaw} /> : null}
            {shape?.kind === "cylinder" ? (
              <>
                <RawNumberField raw={raw} fieldKey="shape|height" label="Height" unit="m" disabled={locked} value={shape.height} onChange={setRaw} />
                <RawVectorField raw={raw} keyPrefix="shape|axis" label="Axis" disabled={locked} values={shape.axis} onChange={setRaw} />
              </>
            ) : null}
            {shape ? <RawVectorField raw={raw} keyPrefix="shape|center" label="Center offset (m)" disabled={locked} values={shape.center} onChange={setRaw} /> : null}
          </InspectorGroup>

          {draft ? calls.map((call) => {
            const antenna = registry.find((candidate) => candidate.function === call.function);
            return antenna ? (
              <ReadyAntennaCallFields
                key={`${call.callIndex}:${JSON.stringify(call.arguments)}`}
                antenna={antenna}
                title={`Ready antenna · terms ${call.termIndices.map((index) => index + 1).join(", ")}`}
                values={call.arguments}
                busy={readyBusy === String(call.callIndex)}
                disabled={pending}
                onBuild={(values) => void buildReadyAntennaTerms(antenna, call.callIndex, values)}
              />
            ) : (
              <InspectorGroup key={call.callIndex} title="Ready antenna" collapsible defaultOpen>
                <FieldRow label="Function" value={`${call.function} (not in this runtime)`} />
              </InspectorGroup>
            );
          }) : null}

          {draft ? draft.terms.map((term, termIndex) => {
            const maskFunction = termFunction(term, "mask");
            const timeFunction = termFunction(term, "time");
            const handlers = (role: MaskFunctionRole) => ({
              onLocalChange: (localIndex: number, expression: string) =>
                setDraft((value) => setTermLocal(value, termIndex, role, localIndex, expression)),
              onOutputChange: (outputIndex: number, expression: string) =>
                setDraft((value) => setTermOutput(value, termIndex, role, outputIndex, expression)),
              onParameterAdd: (name: string) =>
                setDraft((value) => addTermParameter(value, termIndex, role, name)),
              onParameterRemove: (name: string) =>
                setDraft((value) => removeTermParameter(value, termIndex, role, name)),
            });
            return (
              <InspectorGroup key={termIndex} title={`Term ${termIndex + 1}${term.name ? ` · ${term.name}` : ""}`} collapsible defaultOpen>
                <FormField label="Term name" disabled={pending} value={term.name ?? ""} onChange={(event) => { const name = event.currentTarget.value; setDraft((value) => setTermName(value, termIndex, name)); }} />
                {term.origin ? <FieldRow label="Origin" value={`${term.origin.function}; editing the term detaches it`} /> : null}
                {maskFunction
                  ? <FunctionFields raw={raw} role="mask" target={maskFunction} termIndex={termIndex} disabled={pending} onRawChange={setRaw} {...handlers("mask")} />
                  : term.mask.kind === "sampled" ? <ArrayMaskRows mask={term.mask} /> : null}
                <FormField label="Static (no time function)" type="checkbox" disabled={pending} checked={!timeFunction} onChange={(event) => { const isStatic = event.currentTarget.checked; setDraft((value) => setTermStatic(value, termIndex, isStatic)); }} />
                {timeFunction
                  ? <FunctionFields raw={raw} role="time" target={timeFunction} termIndex={termIndex} disabled={pending} onRawChange={setRaw} {...handlers("time")} />
                  : null}
                <div className="fm-inspector-toolbar fm-toolbar-top">
                  <Button size="sm" type="button" variant="ghost" disabled={pending || draft.terms.length <= 1} onClick={() => setDraft((value) => removeTerm(value, termIndex))}>
                    Remove term
                  </Button>
                </div>
              </InspectorGroup>
            );
          }) : null}

          <InspectorGroup title="Add" collapsible defaultOpen>
            <div className="fm-inspector-toolbar">
              <Button size="sm" type="button" variant="secondary" disabled={locked || (draft?.terms.length ?? 0) >= MAX_MASK_TERMS} onClick={() => setDraft((value) => addTerm(value))}>
                Add term
              </Button>
            </div>
            <FormField label="Ready antenna" type="select" disabled={locked || registry.length === 0} value={newReadyFunction} onChange={(event) => setNewReadyFunction(event.currentTarget.value)}>
              <option value="">Select a ready antenna</option>
              {registry.map((antenna) => <option key={antenna.function} value={antenna.function}>{antenna.function.split(".").pop()} — {antenna.summary}</option>)}
            </FormField>
          </InspectorGroup>
          {newReadyAntenna ? (
            <ReadyAntennaCallFields
              key={newReadyAntenna.function}
              antenna={newReadyAntenna}
              title="New ready antenna"
              values={readyAntennaDefaultArguments(newReadyAntenna)}
              busy={readyBusy === NEW_READY_CALL}
              disabled={pending}
              onBuild={(values) => void buildReadyAntennaTerms(newReadyAntenna, null, values)}
            />
          ) : null}

          {model.mode === "found" ? (
            <InspectorGroup title="Remove" collapsible defaultOpen={false}>
              <div className="fm-inspector-toolbar">
                <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={() => void removeAntenna()}>
                  Delete antenna
                </Button>
              </div>
            </InspectorGroup>
          ) : null}
        </div>
      }
    />
  );
}

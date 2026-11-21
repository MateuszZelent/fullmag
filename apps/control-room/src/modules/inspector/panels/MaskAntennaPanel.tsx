"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  MaskFieldDriveResource,
  MaskFunctionResource,
  MaskTermResource,
  ReadyAntennaResource,
} from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY,
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
  mergeMaskAntennaDraft,
  readyAntennaCalls,
  readyAntennaDefaultArguments,
  removeTerm,
  removeTermParameter,
  replaceReadyAntennaCall,
  resolveMaskAntennaPanelModel,
  sameJson,
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

/**
 * The local draft of one antenna. It belongs to the antenna, not to a scene
 * revision, so a newer revision keeps the draft, the focus and the scroll.
 * `value` is null while the panel follows the scene; the first edit pins it.
 * `base` is the scene version the edits started from (found antennas only);
 * the panel merges the edits onto newer scene versions (three-way merge).
 */
interface MaskAntennaDraftState {
  base: MaskFieldDriveResource | null;
  key: string;
  value: MaskFieldDriveResource | null;
}

/** A write the server acknowledged; it stands for the antenna until the list reaches its revision. */
interface AcknowledgedMaskAntenna {
  drive: MaskFieldDriveResource;
  key: string;
  revision: number;
}

const MASK_OUTPUT_LABELS = ["Bx", "By", "Bz"] as const;
const NEW_READY_CALL = "new";
const READY_TERMS_PENDING_REASON = "Wait for the ready antenna terms before applying.";
type ReadyTerms = MaskFieldDriveResource["terms"];

function readyCallTerms(drive: MaskFieldDriveResource, callIndex: number): ReadyTerms {
  return drive.terms.filter((term) => term.origin?.call_index === callIndex);
}
const SCENE_CHANGED_REASON =
  "This antenna changed in the scene in fields you also edited. Keep your values or load the scene version.";

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
    const [termKey, role, name] = rest;
    const index = termKey.startsWith("name:")
      ? drive.terms.findIndex((term) => term.name === termKey.slice(5))
      : Number(termKey);
    return index >= 0 ? setTermParameter(drive, index, role as MaskFunctionRole, name, value) : drive;
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

/** The typed numbers that still match `drive`; an unparsed text is kept as an edit. */
function consistentRawInputs(drive: MaskFieldDriveResource, raw: RawInputs): RawInputs {
  return Object.fromEntries(Object.entries(raw).filter(([key, text]) => {
    const value = parseFiniteNumber(text);
    return value === null || sameJson(applyNumericInput(drive, key, value), drive);
  }));
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
  termKey,
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
  termKey: string;
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
            fieldKey={`term|${termKey}|${role}|${parameter.name}`}
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
      {keyedOccurrences(
        target.outputs.map((output, index) => ({
          output,
          index,
          identity: role === "mask"
            ? MASK_OUTPUT_LABELS[index] ?? `B${index}`
            : "f(t)",
        })),
        (entry) => entry.identity,
      ).map(({ item, key }) => (
        <FormField
          key={key}
          label={role === "mask" ? `${item.identity} =` : "f(t) ="}
          unit={role === "mask" ? "T" : undefined}
          disabled={disabled}
          value={item.output}
          onChange={(event) => onOutputChange(item.index, event.currentTarget.value)}
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
  buildDisabled,
  busy,
  disabled,
  onBuild,
  title,
  values,
}: {
  antenna: ReadyAntennaResource;
  buildDisabled: boolean;
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
          disabled={disabled || buildDisabled || busy || invalid || missing !== null}
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
  const [acknowledged, setAcknowledged] = useState<AcknowledgedMaskAntenna | null>(null);
  // Between the ACK of a save and the refetch, the saved antenna is the baseline:
  // the draft neither flashes back to the old values nor counts as unapplied.
  const baseline = model.mode === "found" &&
    acknowledged?.key === identityKey &&
    (model.sceneRevision ?? -1) < acknowledged.revision
    ? acknowledged.drive
    : drive;
  const [draftState, setDraftState] = useState<MaskAntennaDraftState>(
    () => ({ base: null, key: identityKey, value: null }),
  );
  const [rawState, setRawState] = useState<{ identityKey: string; values: RawInputs }>(
    () => ({ identityKey, values: {} }),
  );
  // An untouched new-antenna draft counts as unapplied, so Apply can create it.
  // Once discarded it is clean until edited, so the selection guard can leave it.
  // The selection object identifies one visit of the draft.
  const [discardedSelection, setDiscardedSelection] = useState<Selection | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const nextOperationId = useRef(0);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [readyRequest, setReadyRequest] = useState<{ key: string; selection: Selection } | null>(null);
  const activeReadyRequest = useRef<typeof readyRequest>(null);
  const readyBusy = readyRequest?.selection === selection ? readyRequest.key : null;
  const [newReadyFunction, setNewReadyFunction] = useState("");

  const editable = model.mode === "create" || model.mode === "found";
  const ownRaw = rawState.identityKey === identityKey ? rawState.values : {};
  const own = draftState.key === identityKey ? draftState.value : null;
  // The draft is this panel's edits merged onto the antenna as the scene has it
  // now: a field changed only in the scene follows the scene, and a field
  // changed on both sides is a conflict.
  const merge = editable && own && model.mode === "found" && draftState.base && baseline
    ? mergeMaskAntennaDraft(draftState.base, applyRawInputs(own, ownRaw), baseline)
    : null;
  const draft = !editable
    ? null
    : merge
      ? merge.merged
      : own
        ? applyRawInputs(own, ownRaw)
        : baseline
          ? applyRawInputs(structuredClone(baseline), ownRaw)
          : null;
  // A number typed earlier that no longer matches the draft (the scene changed a
  // field this panel left as it was) gives way to the scene's value.
  const raw = draft ? consistentRawInputs(draft, ownRaw) : ownRaw;
  const conflicts = merge?.conflicts ?? [];
  const conflict = conflicts.length > 0;
  const pending = pendingId !== null;
  const locked = !draft || pending;
  const termsLocked = locked || conflict;

  /**
   * The state the next edit starts from. Edits are relative to `base` and use
   * every typed text. Without a conflict, the draft is first rebased onto the
   * scene version: the merge is folded in and only the typed texts that still
   * match it are kept, so a field the user sees from the scene is edited from
   * the scene's value. A conflict keeps its base until it is resolved.
   */
  function editStart(): { base: MaskFieldDriveResource | null; raw: RawInputs; value: MaskFieldDriveResource } | null {
    if (!own) {
      if (!baseline) return null;
      return {
        base: model.mode === "found" ? structuredClone(baseline) : null,
        raw: ownRaw,
        value: structuredClone(baseline),
      };
    }
    if (merge && baseline && merge.conflicts.length === 0 && !sameJson(draftState.base, baseline)) {
      return { base: structuredClone(baseline), raw, value: structuredClone(merge.merged) };
    }
    return { base: draftState.base, raw: ownRaw, value: own };
  }
  function setRaw(key: string, text: string): void {
    const start = editStart();
    if (!start) return;
    setDraftState({ base: start.base, key: identityKey, value: start.value });
    setRawState({ identityKey, values: { ...start.raw, [key]: text } });
  }
  function setDraft(
    update: (value: MaskFieldDriveResource) => MaskFieldDriveResource,
  ): void {
    const start = editStart();
    if (!start) return;
    // Structural edits fold the typed numbers into the antenna.
    setDraftState({ base: start.base, key: identityKey, value: update(applyRawInputs(start.value, start.raw)) });
    setRawState({ identityKey, values: {} });
  }
  // HTTP responses arrive in a later render. Apply them through the editor
  // associated with the latest committed draft, including any intervening edits.
  const applyReadyTerms = useRef<
    ((callIndex: number | null, terms: ReadyTerms, previous: ReadyTerms | null) => boolean) | null
  >(null);
  useLayoutEffect(() => {
    applyReadyTerms.current = (callIndex, terms, previous) => {
      if (!draft || termsLocked) return false;
      if (callIndex !== null && !sameJson(readyCallTerms(draft, callIndex), previous)) return false;
      setDraft((value) => replaceReadyAntennaCall(value, callIndex, terms));
      return true;
    };
    return () => { applyReadyTerms.current = null; };
  });

  const cancelReadyRequest = useCallback(() => {
    activeReadyRequest.current = null;
    setReadyRequest(null);
  }, []);
  useLayoutEffect(() => () => { activeReadyRequest.current = null; }, [selection]);

  /** Resolve the conflicts with this panel's values; other fields keep the scene's. */
  function keepDraft(): void {
    if (!merge || !baseline) return;
    setDraftState({ base: structuredClone(baseline), key: identityKey, value: structuredClone(merge.merged) });
    setRawState({ identityKey, values: raw });
    setFeedback(null);
  }
  /** Forget the local draft; the panel follows the scene again. */
  function clearDraft(): void {
    cancelReadyRequest();
    setDraftState({ base: null, key: identityKey, value: null });
    setRawState({ identityKey, values: {} });
  }

  const rawErrors = Object.keys(raw).flatMap((key) => rawError(raw, key) ?? []);
  const validationErrors = [...new Set([
    ...(draft ? validateMaskAntennaDraft(draft) : []),
    ...rawErrors,
  ])];
  const dirty = Boolean(
    draft && (model.mode === "create"
      ? own !== null || discardedSelection !== selection
      : baseline && !sameJson(draft, baseline)),
  ) || rawErrors.length > 0;

  const resetDraft = useCallback(() => {
    cancelReadyRequest();
    setDraftState({ base: null, key: identityKey, value: null });
    setRawState({ identityKey, values: {} });
    setFeedback(null);
    setDiscardedSelection(selection);
  }, [cancelReadyRequest, identityKey, selection]);

  // The selection guard reads this session synchronously: a write marks the
  // committed draft clean through `acknowledgeDraft` before moving the selection.
  const acknowledgeDraft = useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    Boolean(draft && sessionScopeKey && model.sceneRevision !== null && validationErrors.length === 0 && !readyBusy),
    undefined,
    save,
    resetDraft,
    {
      historyMode: "mutation-owned",
      applyBlockReason: conflict
        ? SCENE_CHANGED_REASON
        : readyBusy ? READY_TERMS_PENDING_REASON : validationErrors[0],
    },
  );

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
    onDone: (sceneRevision: number) => void,
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
      onDone(response.scene_revision);
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
    if (conflict) {
      setFeedback({ kind: "error", message: SCENE_CHANGED_REASON });
      return false;
    }
    if (activeReadyRequest.current?.selection === selection) {
      setFeedback({ kind: "error", message: READY_TERMS_PENDING_REASON });
      return false;
    }
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors.join(" ") });
      return false;
    }
    const mode = model.mode;
    const edits = mode === "found" && own && draftState.base
      ? { base: draftState.base, mine: applyRawInputs(own, ownRaw) }
      : null;
    const listed = baseline;
    let submitted = draft;
    return runMutation(
      `${mode === "create" ? "Create" : "Update"} mask antenna ${submitted.id}`,
      async (baseRevision, scopeKey) => {
        if (edits && listed) {
          // The list this panel shows may be older than the scene. Merge onto the
          // antenna as the server holds it at `baseRevision`, the revision the
          // write is checked against.
          const current = await api.model.maskFieldDrives({ sessionScopeKey: scopeKey });
          if (current.scene_revision !== baseRevision) {
            resources.invalidate(MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY, current.scene_revision);
            throw new Error("The scene changed while saving. Apply again.");
          }
          const server = current.drives.find((item) => item.id === submitted.id);
          if (!server) throw new Error(`Mask antenna ${submitted.id} is no longer in the scene.`);
          if (!sameJson(server, listed)) {
            resources.invalidate(MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY, current.scene_revision);
            const merged = mergeMaskAntennaDraft(edits.base, edits.mine, server);
            if (merged.conflicts.length > 0) {
              throw new Error("Not saved: this antenna changed in the scene in fields you also edited.");
            }
            submitted = merged.merged;
          }
        }
        return commitMaskAntenna(api.model, mode, baseRevision, submitted, { sessionScopeKey: scopeKey });
      },
      (sceneRevision) => {
        clearDraft();
        if (mode === "found") {
          setAcknowledged({ drive: submitted, key: identityKey, revision: sceneRevision });
        }
        const ownsSession = acknowledgeDraft();
        if (mode === "create" && ownsSession) {
          kernel.selection.set(maskAntennaSelection(submitted), "inspector");
        }
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
        // The draft of a deleted antenna is moot; it must not hold the selection.
        clearDraft();
        if (!acknowledgeDraft()) return;
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
    if (!draft || termsLocked || activeReadyRequest.current?.selection === selection) return;
    const previous = callIndex === null ? null : readyCallTerms(draft, callIndex);
    const request = { key: callIndex === null ? NEW_READY_CALL : String(callIndex), selection };
    activeReadyRequest.current = request;
    setReadyRequest(request);
    const isCurrent = () =>
      activeReadyRequest.current === request && identityKeyRef.current === identityKey;
    setFeedback(null);
    try {
      const response = await api.model.readyAntennaTerms(
        { arguments: values, function: antenna.function },
        sessionScopeKey ? { sessionScopeKey } : undefined,
      );
      if (!isCurrent()) return;
      if (!applyReadyTerms.current?.(callIndex, response.terms, previous)) {
        setFeedback({ kind: "error", message: "The antenna terms changed while building. Build them again." });
        return;
      }
      if (callIndex === null) setNewReadyFunction("");
    } catch (error) {
      if (!isCurrent()) return;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeReadyRequest.current === request) activeReadyRequest.current = null;
      setReadyRequest((current) => current === request ? null : current);
    }
  }

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
            {conflict ? (
              <>
                <FeedbackBanner
                  kind="warning"
                  message={SCENE_CHANGED_REASON}
                  detail={`Changed on both sides: ${conflicts.map((path) => path.replace(/^drive\./, "")).join(", ")}`}
                />
                <div className="fm-inspector-toolbar">
                  <Button size="sm" type="button" variant="secondary" disabled={pending} onClick={keepDraft}>
                    Keep my values
                  </Button>
                  <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={resetDraft}>
                    Load scene version
                  </Button>
                </div>
              </>
            ) : null}
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
                buildDisabled={readyBusy !== null}
                busy={readyBusy === String(call.callIndex)}
                disabled={termsLocked}
                onBuild={(values) => void buildReadyAntennaTerms(antenna, call.callIndex, values)}
              />
            ) : (
              <InspectorGroup key={call.callIndex} title="Ready antenna" collapsible defaultOpen>
                <FieldRow label="Function" value={`${call.function} (not in this runtime)`} />
              </InspectorGroup>
            );
          }) : null}

          {draft ? draft.terms.map((term, termIndex) => {
            // Named raw inputs follow their term when the scene reorders the list.
            const termKey = term.name && !term.name.includes("|") &&
              draft.terms.filter((item) => item.name === term.name).length === 1
              ? `name:${term.name}`
              : String(termIndex);
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
                <FormField label="Term name" disabled={termsLocked} value={term.name ?? ""} onChange={(event) => { const name = event.currentTarget.value; setDraft((value) => setTermName(value, termIndex, name)); }} />
                {term.origin ? <FieldRow label="Origin" value={`${term.origin.function}; editing the term detaches it`} /> : null}
                {maskFunction
                  ? <FunctionFields raw={raw} role="mask" target={maskFunction} termKey={termKey} disabled={termsLocked} onRawChange={setRaw} {...handlers("mask")} />
                  : term.mask.kind === "sampled" ? <ArrayMaskRows mask={term.mask} /> : null}
                <FormField label="Static (no time function)" type="checkbox" disabled={termsLocked} checked={!timeFunction} onChange={(event) => { const isStatic = event.currentTarget.checked; setDraft((value) => setTermStatic(value, termIndex, isStatic)); }} />
                {timeFunction
                  ? <FunctionFields raw={raw} role="time" target={timeFunction} termKey={termKey} disabled={termsLocked} onRawChange={setRaw} {...handlers("time")} />
                  : null}
                <div className="fm-inspector-toolbar fm-toolbar-top">
                  <Button size="sm" type="button" variant="ghost" disabled={termsLocked || draft.terms.length <= 1} onClick={() => setDraft((value) => removeTerm(value, termIndex))}>
                    Remove term
                  </Button>
                </div>
              </InspectorGroup>
            );
          }) : null}

          <InspectorGroup title="Add" collapsible defaultOpen>
            <div className="fm-inspector-toolbar">
              <Button size="sm" type="button" variant="secondary" disabled={termsLocked || (draft?.terms.length ?? 0) >= MAX_MASK_TERMS} onClick={() => setDraft((value) => addTerm(value))}>
                Add term
              </Button>
            </div>
            <FormField label="Ready antenna" type="select" disabled={termsLocked || registry.length === 0} value={newReadyFunction} onChange={(event) => setNewReadyFunction(event.currentTarget.value)}>
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
              buildDisabled={readyBusy !== null}
              busy={readyBusy === NEW_READY_CALL}
              disabled={termsLocked}
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

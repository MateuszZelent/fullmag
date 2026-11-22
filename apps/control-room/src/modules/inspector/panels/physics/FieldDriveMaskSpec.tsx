"use client";

import {
  Box,
  Plus,
  Radio,
  Sliders,
  Sparkles,
  Trash2,
  Waves,
} from "lucide-react";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  MODEL_MASK_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_READY_ANTENNAS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  MaskFieldDriveListResource,
  MaskFieldDriveResource,
  MaskFunctionResource,
  MaskTermResource,
  ReadyAntennaListResource,
  ReadyAntennaResource,
} from "@/kernel/api/apiTypes";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import * as maskAntennaResources from "@/kernel/resources/maskAntennaResources";
import { useResource } from "@/kernel/resources/useResource";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/Dialog";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";

import {
  formatInspectorSessionKey,
  useInspectorEditSessionStore,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  InspectorTemplate,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSectionSpec,
  type InspectorSpec,
} from "../../template";
import {
  addTerm,
  addTermParameter,
  commitMaskAntenna,
  createMaskAntennaDraft,
  defaultMaskShape,
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
  updateTerm,
  validateMaskAntennaDraft,
  type MaskFunctionRole,
  type MaskShapeKind,
} from "../MaskAntennaPanelModel";
import { buildRootSelection, fallbackRevision } from "../model-roots/SpecInspectorHost";
import { regionalFieldDriveSelectorOptions } from "../RegionalFieldDrivePanelModel";

type RawInputs = Record<string, string>;
type ReadyTerms = MaskFieldDriveResource["terms"];

interface MaskAntennaDraftState {
  base: MaskFieldDriveResource | null;
  key: string;
  value: MaskFieldDriveResource | null;
}

interface AcknowledgedMaskAntenna {
  drive: MaskFieldDriveResource;
  key: string;
  revision: number;
}

export interface MaskAntennaTemplateDraft {
  id: string;
  name: string;
  enabled: boolean;
  targetKind: "global" | "object" | "region";
  targetObjectId: string;
  targetRegionId: string;
  frame: "world" | "local";
  timeOrigin: "stage_local" | "absolute";
  shapeKind: MaskShapeKind;
  stageScopeKind: "all_time_evolution" | "stage_ids";
  selectedStageIds: readonly string[];
  termsCount: number;
  drive: MaskFieldDriveResource | null;
}

const MASK_OUTPUT_LABELS = ["Bx", "By", "Bz"] as const;
const NEW_READY_CALL = "new";
const UNSELECTED_OBJECT = "__select_object__";
const UNSELECTED_REGION = "__select_region__";
const UNSELECTED_READY_ANTENNA = "__select_ready_antenna__";
const READY_TERMS_PENDING_REASON = "Wait for the ready antenna terms before applying.";
const SCENE_CHANGED_REASON =
  "This antenna changed in the scene in fields you also edited. Keep your values or load the scene version.";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

function isValidScriptIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name) && !PYTHON_KEYWORDS.has(name);
}

function maskAntennaNodeId(driveId: string): string {
  return `model:physics:mask-antennas:${driveId}`;
}

export function buildMaskAntennaSelection(
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

function readyCallTerms(drive: MaskFieldDriveResource, callIndex: number): ReadyTerms {
  return drive.terms.filter((term) => term.origin?.call_index === callIndex);
}

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
      return {
        ...drive,
        shape: { ...shape, center: withComponent(shape.center, Number(component), value) },
      };
    }
    if (field === "size" && shape.kind === "box") {
      return {
        ...drive,
        shape: { ...shape, size: withComponent(shape.size, Number(component), value) },
      };
    }
    if (field === "axis" && shape.kind === "cylinder") {
      return {
        ...drive,
        shape: { ...shape, axis: withComponent(shape.axis, Number(component), value) },
      };
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
    if (!termKey || !role || !name) return drive;
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

function consistentRawInputs(drive: MaskFieldDriveResource, raw: RawInputs): RawInputs {
  return Object.fromEntries(
    Object.entries(raw).filter(([key, text]) => {
      const value = parseFiniteNumber(text);
      return value === null || sameJson(applyNumericInput(drive, key, value), drive);
    }),
  );
}

function addTermLocalEquation(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
  expression: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) => {
    const applyFn = (target: MaskFunctionResource): MaskFunctionResource => {
      const existingLocals = target.locals ?? [];
      const existingParams = target.parameters ?? [];
      if (
        existingLocals.some((l) => l.name === name) ||
        existingParams.some((p) => p.name === name)
      ) {
        return target;
      }
      return {
        ...target,
        locals: [...existingLocals, { name, expression: expression.trim() || "0.0" }],
      };
    };
    if (role === "time") {
      return term.time ? { ...term, time: applyFn(term.time) } : term;
    }
    return term.mask.kind === "function"
      ? { ...term, mask: { ...term.mask, function: applyFn(term.mask.function) } }
      : term;
  });
}

function removeTermLocalEquation(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) => {
    const applyFn = (target: MaskFunctionResource): MaskFunctionResource => ({
      ...target,
      locals: (target.locals ?? []).filter((l) => l.name !== name),
    });
    if (role === "time") {
      return term.time ? { ...term, time: applyFn(term.time) } : term;
    }
    return term.mask.kind === "function"
      ? { ...term, mask: { ...term.mask, function: applyFn(term.mask.function) } }
      : term;
  });
}

function validateMaskLocalsAndStageActivation(drive: MaskFieldDriveResource): string[] {
  const errors: string[] = [];
  if (drive.activation.kind === "stage_ids" && drive.activation.stage_ids.length === 0) {
    errors.push("Select at least one run stage.");
  }
  drive.terms.forEach((term, index) => {
    const label = `Term ${index + 1}`;
    for (const role of ["mask", "time"] as const) {
      const fn = termFunction(term, role);
      if (!fn) continue;
      const seen = new Set((fn.parameters ?? []).map((p) => p.name));
      for (const local of fn.locals ?? []) {
        if (!isValidScriptIdentifier(local.name)) {
          errors.push(
            `${label}: local '${local.name}' must be an identifier that is not a Python keyword.`,
          );
        }
        if (seen.has(local.name)) {
          errors.push(`${label}: local '${local.name}' duplicates another symbol.`);
        }
        seen.add(local.name);
        if (local.expression.trim().length === 0) {
          errors.push(`${label}: local '${local.name}' needs an expression.`);
        }
      }
    }
  });
  return errors;
}

function normalizeMaskListResource(
  rawData: unknown,
  fallbackRevisionNum: number | null,
): MaskFieldDriveListResource | null {
  if (!rawData || typeof rawData !== "object") return null;
  const rec = rawData as {
    drives?: MaskFieldDriveResource[];
    items?: MaskFieldDriveResource[];
    scene_revision?: number;
  };
  const drives = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  const scene_revision =
    typeof rec.scene_revision === "number"
      ? rec.scene_revision
      : (fallbackRevisionNum ?? 0);
  return { drives, scene_revision };
}

function extractDriveIds(rawData: unknown): string[] {
  if (!rawData || typeof rawData !== "object") return [];
  const rec = rawData as { drives?: Array<{ id?: unknown }>; items?: Array<{ id?: unknown }> };
  const list = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  return list.flatMap((item) => (typeof item?.id === "string" ? [item.id] : []));
}

const useFallbackReadyAntennasResource = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const kernel = useKernel();
  const hasResourceSystem = typeof kernel.resources?.subscribe === "function";
  const canLoad = hasResourceSystem && typeof kernel.api?.model?.readyAntennas === "function";
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_READY_ANTENNAS_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      kernel.api.model.readyAntennas({ sessionScopeKey, signal }),
    [kernel.api.model],
  );
  const res = useResource<ReadyAntennaListResource>({
    enabled: enabled && canLoad && sessionIdentity !== null,
    load,
    resourceKey,
  });
  if (!canLoad) {
    return { data: { antennas: [] as ReadyAntennaResource[] }, status: "ready" as const, error: null };
  }
  return res;
};

function useSafeReadyAntennasResource(options?: { enabled?: boolean }) {
  const exportedHook =
    "useReadyAntennasResource" in maskAntennaResources &&
    typeof maskAntennaResources.useReadyAntennasResource === "function"
      ? maskAntennaResources.useReadyAntennasResource
      : useFallbackReadyAntennasResource;
  return exportedHook(options);
}

function toMaskTemplateDraft(drive: MaskFieldDriveResource | null): MaskAntennaTemplateDraft {
  const target = drive?.target ?? { kind: "global" as const };
  return {
    id: drive?.id ?? "",
    name: drive?.name ?? "Mask antenna",
    enabled: drive?.enabled !== false,
    targetKind: target.kind,
    targetObjectId:
      target.kind !== "global" ? (target.object_id || UNSELECTED_OBJECT) : UNSELECTED_OBJECT,
    targetRegionId:
      target.kind === "region" ? (target.region_id || UNSELECTED_REGION) : UNSELECTED_REGION,
    frame: drive?.frame ?? "world",
    timeOrigin: drive?.time_origin ?? "stage_local",
    shapeKind: drive?.shape.kind ?? "box",
    stageScopeKind:
      drive?.activation.kind === "stage_ids" ? "stage_ids" : "all_time_evolution",
    selectedStageIds:
      drive?.activation.kind === "stage_ids" ? drive.activation.stage_ids : [],
    termsCount: drive?.terms.length ?? 0,
    drive,
  };
}

/* ── Sub-Controls Using Strictly @/shared/ui Components ── */

function MaskRawScalarField({
  disabled,
  fieldKey,
  hint,
  label,
  onChange,
  raw,
  unit,
  value,
}: {
  disabled: boolean;
  fieldKey: string;
  hint?: string;
  label: string;
  onChange: (key: string, text: string) => void;
  raw: RawInputs;
  unit?: string;
  value: number | undefined;
}) {
  const id = useId();
  const error = rawError(raw, fieldKey);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-[var(--fm-text)]" htmlFor={id}>
          {label}
        </label>
        {unit ? (
          <span className="font-mono text-xs text-[var(--fm-text-muted)]">{unit}</span>
        ) : null}
      </div>
      <Input
        aria-invalid={error ? "true" : "false"}
        aria-label={label}
        autoComplete="off"
        className="font-mono text-xs"
        disabled={disabled}
        id={id}
        inputMode="text"
        type="text"
        value={rawValue(raw, fieldKey, value)}
        onChange={(event) => onChange(fieldKey, event.target.value)}
      />
      {hint && !error ? (
        <span className="text-xs text-[var(--fm-text-muted)]">{hint}</span>
      ) : null}
      {error ? (
        <span className="text-xs text-[var(--fm-danger)]" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function MaskRawVectorField({
  disabled,
  keyPrefix,
  label,
  onChange,
  raw,
  unit,
  values,
}: {
  disabled: boolean;
  keyPrefix: string;
  label: string;
  onChange: (key: string, text: string) => void;
  raw: RawInputs;
  unit?: string;
  values: readonly number[];
}) {
  const axes = ["X", "Y", "Z"] as const;
  const keys = ([0, 1, 2] as const).map((index) => `${keyPrefix}|${index}`);
  const errors = keys.map((key) => rawError(raw, key)).filter(Boolean);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--fm-text)]">{label}</span>
        {unit ? (
          <span className="font-mono text-xs text-[var(--fm-text-muted)]">{unit}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {axes.map((axis, index) => {
          const key = keys[index]!;
          const err = rawError(raw, key);
          return (
            <div key={key} className="flex items-center gap-1">
              <span className="font-mono text-xs text-[var(--fm-text-muted)]">{axis}</span>
              <Input
                aria-invalid={err ? "true" : "false"}
                aria-label={`${label} ${axis}`}
                autoComplete="off"
                className="font-mono text-xs"
                disabled={disabled}
                inputMode="text"
                type="text"
                value={rawValue(raw, key, values[index])}
                onChange={(event) => onChange(key, event.target.value)}
              />
            </div>
          );
        })}
      </div>
      {errors[0] ? (
        <span className="text-xs text-[var(--fm-danger)]" role="alert">
          {errors[0]}
        </span>
      ) : null}
    </div>
  );
}

function ArrayMaskRows({
  mask,
}: {
  mask: Extract<MaskTermResource["mask"], { kind: "sampled" }>;
}) {
  const rows: readonly { label: string; value: string }[] = [
    { label: "Mask", value: "array (written by a loop), read-only" },
    { label: "Lattice", value: mask.size.join(" x ") },
    { label: "Cell", value: `${mask.cell_m.join(", ")} m` },
    { label: "Origin", value: `${mask.origin_m.join(", ")} m` },
    { label: "SHA-256", value: mask.sha256.slice(0, 16) },
  ];
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2"
      data-slot="mask-sampled-array-rows"
    >
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-[var(--fm-text-muted)]">{row.label}</span>
          <span className="font-mono text-[var(--fm-text)]">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function MaskFunctionFields({
  disabled,
  onLocalAdd,
  onLocalChange,
  onLocalRemove,
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
  onLocalAdd: (name: string, expression: string) => void;
  onLocalChange: (localIndex: number, expression: string) => void;
  onLocalRemove: (name: string) => void;
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
  const [newLocalName, setNewLocalName] = useState("");
  const [newLocalExpr, setNewLocalExpr] = useState("");

  const parameters = target.parameters ?? [];
  const locals = target.locals ?? [];
  const usedNames = new Set([
    ...parameters.map((p) => p.name),
    ...locals.map((l) => l.name),
  ]);
  const canAddParam =
    isValidScriptIdentifier(newParameter) && !usedNames.has(newParameter);
  const canAddLocal =
    isValidScriptIdentifier(newLocalName) &&
    !usedNames.has(newLocalName) &&
    newLocalExpr.trim().length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--fm-text)]">
          {role === "mask" ? "Mask function" : "Time function"}
        </span>
        <Badge data-tone="neutral">{target.name ?? "custom"}</Badge>
      </div>

      {/* Named scalar parameters */}
      {parameters.map((parameter) => (
        <div key={parameter.name} className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <MaskRawScalarField
              disabled={disabled}
              fieldKey={`term|${termKey}|${role}|${parameter.name}`}
              label={parameter.name}
              raw={raw}
              value={parameter.value}
              onChange={onRawChange}
            />
          </div>
          <Button
            aria-label={`Remove ${parameter.name}`}
            disabled={disabled}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => onParameterRemove(parameter.name)}
          >
            Remove {parameter.name}
          </Button>
        </div>
      ))}

      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Input
            aria-label={role === "mask" ? "New parameter" : "New time parameter"}
            autoComplete="off"
            className="font-mono text-xs"
            disabled={disabled}
            placeholder="Parameter name (e.g. B0)"
            type="text"
            value={newParameter}
            onChange={(event) => setNewParameter(event.target.value)}
          />
        </div>
        <Button
          disabled={disabled || !canAddParam}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            onParameterAdd(newParameter);
            setNewParameter("");
          }}
        >
          Add parameter
        </Button>
      </div>

      {/* Named local sub-expressions */}
      {locals.map((local, index) => (
        <div key={local.name} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-medium text-[var(--fm-text)]">
              {local.name} =
            </span>
            <Button
              aria-label={`Remove local ${local.name}`}
              disabled={disabled}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => onLocalRemove(local.name)}
            >
              Remove {local.name}
            </Button>
          </div>
          <Input
            aria-label={`${local.name} =`}
            autoComplete="off"
            className="font-mono text-xs"
            disabled={disabled}
            spellCheck={false}
            type="text"
            value={local.expression}
            onChange={(event) => onLocalChange(index, event.target.value)}
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          aria-label={role === "mask" ? "New local name" : "New time local name"}
          autoComplete="off"
          className="w-24 font-mono text-xs"
          disabled={disabled}
          placeholder="Local (k)"
          type="text"
          value={newLocalName}
          onChange={(event) => setNewLocalName(event.target.value)}
        />
        <Input
          aria-label={role === "mask" ? "New local expression" : "New time local expression"}
          autoComplete="off"
          className="min-w-0 flex-1 font-mono text-xs"
          disabled={disabled}
          placeholder="Expression (2 * pi / wavelength)"
          spellCheck={false}
          type="text"
          value={newLocalExpr}
          onChange={(event) => setNewLocalExpr(event.target.value)}
        />
        <Button
          disabled={disabled || !canAddLocal}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            onLocalAdd(newLocalName, newLocalExpr);
            setNewLocalName("");
            setNewLocalExpr("");
          }}
        >
          Add local
        </Button>
      </div>

      {/* Output vector / time equations */}
      {keyedOccurrences(
        target.outputs.map((output, index) => ({
          output,
          index,
          identity: role === "mask" ? (MASK_OUTPUT_LABELS[index] ?? `B${index}`) : "f(t)",
        })),
        (entry) => entry.identity,
      ).map(({ item, key }) => {
        const eqLabel = role === "mask" ? `${item.identity} =` : "f(t) =";
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium text-[var(--fm-text)]">
                {eqLabel}
              </span>
              {role === "mask" ? (
                <span className="font-mono text-xs text-[var(--fm-text-muted)]">T</span>
              ) : null}
            </div>
            <Input
              aria-label={eqLabel}
              autoComplete="off"
              className="font-mono text-xs"
              disabled={disabled}
              spellCheck={false}
              type="text"
              value={item.output}
              onChange={(event) => onOutputChange(item.index, event.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}

function ReadyAntennaCallFields({
  antenna,
  buildDisabled,
  busy,
  disabled,
  onBuild,
  values,
}: {
  antenna: ReadyAntennaResource;
  buildDisabled: boolean;
  busy: boolean;
  disabled: boolean;
  onBuild: (values: Record<string, number>) => void;
  values: Record<string, number>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const parsed: Record<string, number> = {};
  let missing: string | null = null;
  let invalid = false;

  for (const argument of antenna.arguments) {
    const text =
      drafts[argument.name] ??
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
    <div className="flex flex-col gap-2" data-slot="ready-antenna-call-fields">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-[var(--fm-text-muted)]">Function</span>
        <span className="font-mono text-[var(--fm-text)]">{antenna.function}</span>
      </div>
      {antenna.arguments.map((argument) => {
        const text =
          drafts[argument.name] ??
          (values[argument.name] === undefined ? "" : String(values[argument.name]));
        const error =
          text.trim().length > 0 && parseFiniteNumber(text) === null
            ? "Enter a finite number in SI units."
            : undefined;
        return (
          <div key={argument.name} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium text-[var(--fm-text)]">
                {argument.name}
              </span>
              {argument.unit ? (
                <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                  {argument.unit}
                </span>
              ) : null}
            </div>
            <Input
              aria-invalid={error ? "true" : "false"}
              aria-label={argument.name}
              autoComplete="off"
              className="font-mono text-xs"
              disabled={disabled || busy}
              inputMode="text"
              type="text"
              value={text}
              onChange={(event) => {
                const next = event.target.value;
                setDrafts((current) => ({ ...current, [argument.name]: next }));
              }}
            />
            {argument.doc && !error ? (
              <span className="text-xs text-[var(--fm-text-muted)]">{argument.doc}</span>
            ) : null}
            {error ? (
              <span className="text-xs text-[var(--fm-danger)]" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-end pt-1">
        <Button
          disabled={disabled || buildDisabled || busy || invalid || missing !== null}
          disabledReason={missing ? `Give ${missing}.` : null}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onBuild(parsed)}
        >
          {busy ? "Building terms…" : "Build terms"}
        </Button>
      </div>
    </div>
  );
}

/* ── Dedicated Mask Antenna Inspector Panel Hosted in Canonical InspectorTemplate ── */

export function FieldDriveMaskInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, resources } = kernel;
  const editSessionStore = useInspectorEditSessionStore();
  const sessionScopeKey = kernel.commands.getSessionScopeKey?.() ?? null;

  const maskResource = maskAntennaResources.useMaskFieldDrivesResource();
  const regionalResource = useFieldDrivesResource();
  const readyAntennas = useSafeReadyAntennasResource();
  const scene = useSceneResource();

  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );
  const regionalIds = useMemo(
    () => extractDriveIds(regionalResource.data),
    [regionalResource.data],
  );
  const normalizedMaskData = useMemo(
    () => normalizeMaskListResource(maskResource.data, scene.data?.revision ?? null),
    [maskResource.data, scene.data?.revision],
  );

  const normalizedSelection = useMemo<Selection>(() => {
    if (selection.ref?.type === "physics-field-drive") return selection;
    const isDraftNode = Boolean(selection.nodeId?.includes(":draft"));
    const fallbackId = !isDraftNode ? (selection.nodeId?.split(":").at(-1) ?? undefined) : undefined;
    return {
      ...selection,
      ref: {
        ...(isDraftNode ? { draft: true } : {}),
        ...(fallbackId ? { fieldDriveId: fallbackId } : {}),
        fieldDriveKind: "mask",
        kind: "physics.field-drive",
        nodeId: selection.nodeId ?? "model:physics:mask-antenna:draft",
        type: "physics-field-drive",
      },
    };
  }, [selection]);

  const model = useMemo(() => {
    const resolved = resolveMaskAntennaPanelModel(
      normalizedSelection,
      normalizedMaskData,
      regionalIds,
    );
    if (resolved.mode === "create" && !resolved.drive) {
      const sourceObj =
        normalizedSelection.ref?.type === "physics-field-drive"
          ? normalizedSelection.ref.sourceObjectId
          : undefined;
      return {
        ...resolved,
        drive: createMaskAntennaDraft(regionalIds, sourceObj),
        sceneRevision: scene.data?.revision ?? null,
      };
    }
    return {
      ...resolved,
      sceneRevision: resolved.sceneRevision ?? scene.data?.revision ?? null,
    };
  }, [normalizedMaskData, normalizedSelection, regionalIds, scene.data?.revision]);

  const drive = model.drive;
  const identityKey =
    model.mode === "create"
      ? `${sessionScopeKey ?? "no-session"}:mask:create`
      : `${sessionScopeKey ?? "no-session"}:mask:${drive?.id ?? model.driveId ?? "none"}`;
  const identityKeyRef = useRef(identityKey);
  useLayoutEffect(() => {
    identityKeyRef.current = identityKey;
  }, [identityKey]);

  const [acknowledged, setAcknowledged] = useState<AcknowledgedMaskAntenna | null>(null);
  const [serverConflictDrive, setServerConflictDrive] = useState<{
    key: string;
    drive: MaskFieldDriveResource;
  } | null>(null);

  const activeServerOverride =
    serverConflictDrive?.key === identityKey ? serverConflictDrive.drive : null;

  const sceneDrive =
    model.mode === "found" &&
    acknowledged?.key === identityKey &&
    (model.sceneRevision ?? -1) < acknowledged.revision
      ? acknowledged.drive
      : drive;
  const effectiveSceneDrive = activeServerOverride ?? sceneDrive;

  const [draftState, setDraftState] = useState<MaskAntennaDraftState>(() => ({
    base: null,
    key: identityKey,
    value: null,
  }));
  const [rawState, setRawState] = useState<{ identityKey: string; values: RawInputs }>(() => ({
    identityKey,
    values: {},
  }));
  const [discardedSelection, setDiscardedSelection] = useState<Selection | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const nextOperationId = useRef(0);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(
    null,
  );
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [readyRequest, setReadyRequest] = useState<{ key: string; selection: Selection } | null>(
    null,
  );
  const activeReadyRequest = useRef<typeof readyRequest>(null);
  const readyBusy = readyRequest?.selection === selection ? readyRequest.key : null;
  const [newReadyFunction, setNewReadyFunction] = useState(UNSELECTED_READY_ANTENNA);
  const [codePreview, setCodePreview] = useState<{
    title: string;
    language: "python" | "json";
    code: string;
  } | null>(null);

  const editable = model.mode === "create" || model.mode === "found";
  const ownRaw = rawState.identityKey === identityKey ? rawState.values : {};
  const own = draftState.key === identityKey ? draftState.value : null;

  const merge =
    editable && own && model.mode === "found" && draftState.base && effectiveSceneDrive
      ? mergeMaskAntennaDraft(draftState.base, applyRawInputs(own, ownRaw), effectiveSceneDrive)
      : null;

  const draft = !editable
    ? null
    : merge
      ? merge.merged
      : own
        ? applyRawInputs(own, ownRaw)
        : effectiveSceneDrive
          ? applyRawInputs(structuredClone(effectiveSceneDrive), ownRaw)
          : null;

  const raw = draft ? consistentRawInputs(draft, ownRaw) : ownRaw;
  const conflicts = merge?.conflicts ?? [];
  const conflict = conflicts.length > 0;
  const pending = pendingId !== null;
  const locked = !draft || pending;
  const termsLocked = locked || conflict;

  function editStart(): {
    base: MaskFieldDriveResource | null;
    raw: RawInputs;
    value: MaskFieldDriveResource;
  } | null {
    if (!own) {
      if (!effectiveSceneDrive) return null;
      return {
        base: model.mode === "found" ? structuredClone(effectiveSceneDrive) : null,
        raw: ownRaw,
        value: structuredClone(effectiveSceneDrive),
      };
    }
    if (
      merge &&
      effectiveSceneDrive &&
      merge.conflicts.length === 0 &&
      !sameJson(draftState.base, effectiveSceneDrive)
    ) {
      return {
        base: structuredClone(effectiveSceneDrive),
        raw,
        value: structuredClone(merge.merged),
      };
    }
    return { base: draftState.base, raw: ownRaw, value: own };
  }

  const setRaw = useCallback(
    (key: string, text: string): void => {
      const start = editStart();
      if (!start) return;
      setAppliedFlash(false);
      setFeedback(null);
      setDraftState({ base: start.base, key: identityKey, value: start.value });
      setRawState({ identityKey, values: { ...start.raw, [key]: text } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveSceneDrive, identityKey, merge, model.mode, own, ownRaw, raw],
  );

  const setDraft = useCallback(
    (update: (value: MaskFieldDriveResource) => MaskFieldDriveResource): void => {
      const start = editStart();
      if (!start) return;
      setAppliedFlash(false);
      setFeedback(null);
      setDraftState({
        base: start.base,
        key: identityKey,
        value: update(applyRawInputs(start.value, start.raw)),
      });
      setRawState({ identityKey, values: {} });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveSceneDrive, identityKey, merge, model.mode, own, ownRaw, raw],
  );

  const applyReadyTerms = useRef<
    ((callIndex: number | null, terms: ReadyTerms, previous: ReadyTerms | null) => boolean) | null
  >(null);
  useLayoutEffect(() => {
    applyReadyTerms.current = (callIndex, terms, previous) => {
      if (!draft || termsLocked) return false;
      if (callIndex !== null && !sameJson(readyCallTerms(draft, callIndex), previous)) {
        return false;
      }
      setDraft((value) => replaceReadyAntennaCall(value, callIndex, terms));
      return true;
    };
    return () => {
      applyReadyTerms.current = null;
    };
  });

  const cancelReadyRequest = useCallback(() => {
    activeReadyRequest.current = null;
    setReadyRequest(null);
  }, []);
  useLayoutEffect(
    () => () => {
      activeReadyRequest.current = null;
    },
    [selection],
  );

  const keepDraft = useCallback((): void => {
    if (!merge || !effectiveSceneDrive) return;
    setDraftState({
      base: structuredClone(effectiveSceneDrive),
      key: identityKey,
      value: structuredClone(merge.merged),
    });
    setRawState({ identityKey, values: raw });
    setServerConflictDrive(null);
    setFeedback(null);
  }, [effectiveSceneDrive, identityKey, merge, raw]);

  const clearDraft = useCallback((): void => {
    cancelReadyRequest();
    setDraftState({ base: null, key: identityKey, value: null });
    setRawState({ identityKey, values: {} });
    setServerConflictDrive(null);
  }, [cancelReadyRequest, identityKey]);

  const resetDraft = useCallback(() => {
    cancelReadyRequest();
    setDraftState({ base: null, key: identityKey, value: null });
    setRawState({ identityKey, values: {} });
    setServerConflictDrive(null);
    setFeedback(null);
    setAppliedFlash(false);
    setDiscardedSelection(selection);
  }, [cancelReadyRequest, identityKey, selection]);

  const rawErrors = Object.keys(raw).flatMap((key) => rawError(raw, key) ?? []);
  const existingIdsExcludingCurrent = useMemo(() => {
    const taken = new Set<string>(regionalIds);
    for (const item of normalizedMaskData?.drives ?? []) {
      if (model.mode === "found" && item.id === model.driveId) continue;
      taken.add(item.id);
    }
    return taken;
  }, [model.driveId, model.mode, normalizedMaskData?.drives, regionalIds]);

  const validationErrors = useMemo(() => {
    if (!draft) return [...new Set(rawErrors)];
    const errs = [
      ...validateMaskAntennaDraft(draft),
      ...validateMaskLocalsAndStageActivation(draft),
      ...rawErrors,
    ];
    if (model.mode === "create" && existingIdsExcludingCurrent.has(draft.id.trim())) {
      errs.push(`An antenna or field drive with ID "${draft.id.trim()}" already exists.`);
    }
    return [...new Set(errs)];
  }, [draft, existingIdsExcludingCurrent, model.mode, rawErrors]);

  const dirty =
    Boolean(
      draft &&
        (model.mode === "create"
          ? own !== null || discardedSelection !== selection
          : effectiveSceneDrive && !sameJson(draft, effectiveSceneDrive)),
    ) || rawErrors.length > 0;

  const dirtyFieldsSet = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    if (!draft) return set;
    if (model.mode === "create") {
      if (own !== null || rawErrors.length > 0) set.add("drive");
      return set;
    }
    if (!effectiveSceneDrive) return set;
    if (draft.name !== effectiveSceneDrive.name) set.add("name");
    if ((draft.enabled !== false) !== (effectiveSceneDrive.enabled !== false)) set.add("enabled");
    if (!sameJson(draft.target, effectiveSceneDrive.target)) set.add("targetKind");
    if (draft.frame !== effectiveSceneDrive.frame) set.add("frame");
    if (draft.time_origin !== effectiveSceneDrive.time_origin) set.add("timeOrigin");
    if (!sameJson(draft.shape, effectiveSceneDrive.shape) || !sameJson(draft.position_m, effectiveSceneDrive.position_m)) {
      set.add("shapeKind");
    }
    if (!sameJson(draft.activation, effectiveSceneDrive.activation)) set.add("stageScopeKind");
    if (!sameJson(draft.terms, effectiveSceneDrive.terms)) set.add("drive");
    if (rawErrors.length > 0 && set.size === 0) set.add("drive");
    return set;
  }, [draft, effectiveSceneDrive, model.mode, own, rawErrors.length]);

  const invalidFieldsMap = useMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    if (validationErrors.length === 0) return map;
    if (draft && draft.id.trim().length === 0) map.set("id", "The antenna needs an ID.");
    if (draft && draft.name.trim().length === 0) map.set("name", "The antenna needs a name.");
    if (draft && draft.target.kind !== "global" && draft.target.object_id.length === 0) {
      map.set("targetObjectId", "Select the target object.");
    }
    if (draft && draft.target.kind === "region" && draft.target.region_id.length === 0) {
      map.set("targetRegionId", "Select the target region.");
    }
    if (map.size === 0) {
      map.set("drive", validationErrors[0]!);
    }
    return map;
  }, [draft, validationErrors]);

  const selectionTargetKey =
    selection.nodeId ?? `physics.field-drive:mask:${model.driveId ?? "draft"}`;
  const registeredSessionKey = formatInspectorSessionKey(
    selectionTargetKey,
    "physics.field-drive.mask",
    "default",
  );

  const synchronousCleanRef = useRef(false);
  useLayoutEffect(() => {
    synchronousCleanRef.current = false;
  }, [dirty, identityKey, selection]);

  function mutationContext() {
    return captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
        selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
        sourceDetail: "FieldDriveMaskSpec",
      }),
    );
  }

  async function runMutation(
    label: string,
    mutate: (
      baseRevision: number,
      scopeKey: string,
    ) => Promise<{ committed_scene?: MaskFieldDriveResource | unknown; scene_revision: number }>,
    onDone: (sceneRevision: number) => void,
  ): Promise<boolean> {
    const context = mutationContext();
    const scopeKey = context.sessionScopeKey;
    if (!scopeKey || context.isCurrentSessionScope?.() !== true) {
      setFeedback({
        kind: "error",
        message: "An active session is required to change this antenna.",
      });
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
      const rev = response.scene_revision;
      if (response.committed_scene && typeof response.committed_scene === "object") {
        publishCommittedSceneResource(
          resources,
          response.committed_scene as Parameters<typeof publishCommittedSceneResource>[1],
          rev,
        );
      }
      resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, rev);
      resources.invalidate(MODEL_SCENE_PATH, rev);
      resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(rev));
      invalidateAuthoringMutationDependents(resources, "interaction", rev);
      if (!isCurrent()) return false;
      onDone(rev);
      return true;
    } catch (error) {
      if (context.isCurrentSessionScope?.() !== true || !isCurrent()) return false;
      const errStatus = (error as { status?: number } | null)?.status;
      const errMessage = error instanceof Error ? error.message : String(error);
      if (
        (errStatus === 409 || /conflict|revision/i.test(errMessage)) &&
        typeof api.model.maskFieldDrives === "function" &&
        model.mode === "found" &&
        drive
      ) {
        try {
          const latest = await api.model.maskFieldDrives({ sessionScopeKey: scopeKey });
          resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, latest.scene_revision);
          const serverItem = latest.drives.find((item) => item.id === drive.id);
          if (serverItem && isCurrent()) {
            setServerConflictDrive({ key: identityKey, drive: serverItem });
          }
        } catch {
          // Keep original error message below if refetch fails.
        }
      }
      setFeedback({ kind: "error", message: errMessage });
      return false;
    } finally {
      setPendingId((current) => (current === operationId ? null : current));
    }
  }

  const saveRef = useRef<() => Promise<boolean>>(async () => false);

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
    const edits =
      mode === "found" && own && draftState.base
        ? { base: draftState.base, mine: applyRawInputs(own, ownRaw) }
        : null;
    const listed = effectiveSceneDrive;
    let submitted = draft;

    return runMutation(
      `${mode === "create" ? "Create" : "Update"} mask antenna ${submitted.id}`,
      async (baseRevision, scopeKey) => {
        if (edits && listed && typeof api.model.maskFieldDrives === "function") {
          const current = await api.model.maskFieldDrives({ sessionScopeKey: scopeKey });
          if (current.scene_revision !== baseRevision) {
            resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, current.scene_revision);
            throw new Error("The scene changed while saving. Apply again.");
          }
          const server = current.drives.find((item) => item.id === submitted.id);
          if (!server) {
            throw new Error(`Mask antenna ${submitted.id} is no longer in the scene.`);
          }
          if (!sameJson(server, listed)) {
            resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, current.scene_revision);
            const merged = mergeMaskAntennaDraft(edits.base, edits.mine, server);
            if (merged.conflicts.length > 0) {
              setServerConflictDrive({ key: identityKey, drive: server });
              throw new Error(
                "Not saved: this antenna changed in the scene in fields you also edited.",
              );
            }
            submitted = merged.merged;
          }
        }
        return commitMaskAntenna(api.model, mode, baseRevision, submitted, {
          sessionScopeKey: scopeKey,
        });
      },
      (sceneRevision) => {
        synchronousCleanRef.current = true;
        clearDraft();
        if (mode === "found") {
          setAcknowledged({ drive: submitted, key: identityKey, revision: sceneRevision });
        }
        setAppliedFlash(true);
        setFeedback({
          kind: "success",
          message: mode === "create" ? "Mask antenna created." : "Mask antenna saved.",
        });
        if (mode === "create") {
          kernel.selection.set(buildMaskAntennaSelection(submitted), "inspector");
        }
      },
    );
  }
  useLayoutEffect(() => {
    saveRef.current = save;
  });

  async function removeAntenna(): Promise<void> {
    if (!drive || model.mode !== "found") return;
    await runMutation(
      `Delete mask antenna ${drive.id}`,
      (baseRevision, scopeKey) =>
        api.model.deleteMaskFieldDrive(
          drive.id,
          { base_revision: baseRevision },
          { sessionScopeKey: scopeKey },
        ),
      () => {
        synchronousCleanRef.current = true;
        clearDraft();
        kernel.selection.set(
          buildRootSelection("physics.field-drives", "model:physics:field-drives", "Field Drives"),
          "inspector",
        );
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
    const request = {
      key: callIndex === null ? NEW_READY_CALL : String(callIndex),
      selection,
    };
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
        setFeedback({
          kind: "error",
          message: "The antenna terms changed while building. Build them again.",
        });
        return;
      }
      if (callIndex === null) setNewReadyFunction(UNSELECTED_READY_ANTENNA);
    } catch (error) {
      if (!isCurrent()) return;
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (activeReadyRequest.current === request) activeReadyRequest.current = null;
      setReadyRequest((current) => (current === request ? null : current));
    }
  }

  const applyBlockReason = conflict
    ? SCENE_CHANGED_REASON
    : readyBusy
      ? READY_TERMS_PENDING_REASON
      : (validationErrors[0] ?? null);

  const lockReason = !editable
    ? "Selected mask antenna is not editable."
    : !sessionScopeKey
      ? "An active session is required to change this antenna."
      : readyBusy
        ? READY_TERMS_PENDING_REASON
        : conflict
          ? SCENE_CHANGED_REASON
          : null;

  const canApplySession = Boolean(
    draft &&
      sessionScopeKey &&
      model.sceneRevision !== null &&
      validationErrors.length === 0 &&
      !readyBusy &&
      !conflict,
  );

  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey: registeredSessionKey,
      nodeTitle: draft?.name || model.driveId || "Mask antenna",
      mode: "staged",
      applying: pending,
      get dirty() {
        return synchronousCleanRef.current ? false : dirty;
      },
      dirtyFields: dirtyFieldsSet,
      dirtyFieldLabels: Array.from(dirtyFieldsSet),
      invalidFields: invalidFieldsMap,
      valid: canApplySession,
      lockReason: !sessionScopeKey ? "An active session is required to change this antenna." : null,
      applyBlockReason,
      apply: () => saveRef.current(),
      revertAll: resetDraft,
      revertField: () => resetDraft(),
      focusField: () => undefined,
    }),
    [
      applyBlockReason,
      canApplySession,
      dirty,
      dirtyFieldsSet,
      draft?.name,
      invalidFieldsMap,
      model.driveId,
      pending,
      registeredSessionKey,
      resetDraft,
      sessionScopeKey,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

  // Keep store notified if synchronousCleanRef flips right before navigation.
  void editSessionStore;

  const templateBaseline = useMemo(
    () => toMaskTemplateDraft(effectiveSceneDrive),
    [effectiveSceneDrive],
  );
  const templateDraft = useMemo(() => toMaskTemplateDraft(draft), [draft]);

  const handleFieldChange = useCallback(
    <K extends keyof MaskAntennaTemplateDraft & string>(
      key: K,
      value: MaskAntennaTemplateDraft[K],
    ) => {
      if (locked) return;
      switch (key) {
        case "id":
          setDraft((d) => ({ ...d, id: String(value) }));
          break;
        case "name":
          setDraft((d) => ({ ...d, name: String(value) }));
          break;
        case "enabled":
          setDraft((d) => ({ ...d, enabled: Boolean(value) }));
          break;
        case "targetKind": {
          const kind = String(value);
          setDraft((d) => ({
            ...d,
            target:
              kind === "object"
                ? { kind: "object", object_id: "" }
                : kind === "region"
                  ? { kind: "region", object_id: "", region_id: "" }
                  : { kind: "global" },
          }));
          break;
        }
        case "targetObjectId": {
          const rawObj = String(value);
          const objectId = rawObj === UNSELECTED_OBJECT ? "" : rawObj;
          setDraft((d) =>
            d.target.kind === "global"
              ? d
              : {
                  ...d,
                  target:
                    d.target.kind === "region"
                      ? { kind: "region", object_id: objectId, region_id: "" }
                      : { kind: "object", object_id: objectId },
                },
          );
          break;
        }
        case "targetRegionId": {
          const rawReg = String(value);
          const regionId = rawReg === UNSELECTED_REGION ? "" : rawReg;
          setDraft((d) =>
            d.target.kind === "region"
              ? { ...d, target: { ...d.target, region_id: regionId } }
              : d,
          );
          break;
        }
        case "frame":
          setDraft((d) => ({ ...d, frame: value === "local" ? "local" : "world" }));
          break;
        case "timeOrigin":
          setDraft((d) => ({
            ...d,
            time_origin: value === "absolute" ? "absolute" : "stage_local",
          }));
          break;
        case "shapeKind":
          setDraft((d) => ({ ...d, shape: defaultMaskShape(value as MaskShapeKind) }));
          break;
        case "stageScopeKind":
          setDraft((d) => ({
            ...d,
            activation:
              value === "stage_ids"
                ? { kind: "stage_ids", stage_ids: [] }
                : { kind: "all_time_evolution" },
          }));
          break;
        case "selectedStageIds":
          setDraft((d) => ({
            ...d,
            activation: {
              kind: "stage_ids",
              stage_ids: [...(value as readonly string[])],
            },
          }));
          break;
        default:
          break;
      }
    },
    [locked, setDraft],
  );

  const registry = useMemo(
    () => readyAntennas.data?.antennas ?? [],
    [readyAntennas.data?.antennas],
  );
  const calls = useMemo(() => (draft ? readyAntennaCalls(draft) : []), [draft]);
  const newReadyAntenna = useMemo(
    () => registry.find((antenna) => antenna.function === newReadyFunction) ?? null,
    [newReadyFunction, registry],
  );

  const objectSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_OBJECT, label: "Select an object" }];
    const seen = new Set<string>();
    for (const obj of selectorOptions.objects) {
      seen.add(obj.id);
      opts.push({ value: obj.id, label: obj.label });
    }
    const cur =
      draft && draft.target.kind !== "global" && draft.target.object_id
        ? draft.target.object_id
        : null;
    if (cur && !seen.has(cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [draft, selectorOptions.objects]);

  const regionSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_REGION, label: "Select a region" }];
    const objId = draft && draft.target.kind !== "global" ? draft.target.object_id : "";
    const regions = selectorOptions.regionsByObject[objId] ?? [];
    const seen = new Set<string>();
    for (const reg of regions) {
      seen.add(reg.id);
      opts.push({ value: reg.id, label: reg.label });
    }
    const cur = draft?.target.kind === "region" ? draft.target.region_id : null;
    if (cur && !seen.has(cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [draft, selectorOptions.regionsByObject]);

  const stageToggleOptions = useMemo(
    () =>
      selectorOptions.timeEvolutionStages.map((st) => ({
        value: st.id,
        label: st.label,
      })),
    [selectorOptions.timeEvolutionStages],
  );

  const spec = useMemo<InspectorSpec<MaskAntennaTemplateDraft>>(() => {
    const shape = draft?.shape ?? null;

    const readyCallSections: InspectorSectionSpec<MaskAntennaTemplateDraft>[] = calls.map(
      (call) => {
        const antenna = registry.find((candidate) => candidate.function === call.function);
        return {
          id: `mask-ready-call-${call.callIndex}`,
          title: `Ready antenna · terms ${call.termIndices.map((idx) => idx + 1).join(", ")}`,
          icon: Sparkles,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () =>
                antenna ? (
                  <ReadyAntennaCallFields
                    key={`${call.callIndex}:${JSON.stringify(call.arguments)}`}
                    antenna={antenna}
                    buildDisabled={readyBusy !== null}
                    busy={readyBusy === String(call.callIndex)}
                    disabled={termsLocked}
                    values={call.arguments}
                    onBuild={(values) =>
                      void buildReadyAntennaTerms(antenna, call.callIndex, values)
                    }
                  />
                ) : (
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--fm-text-muted)]">Function</span>
                    <span className="font-mono text-[var(--fm-text)]">
                      {call.function} (not in this runtime)
                    </span>
                  </div>
                ),
            },
          ],
        };
      },
    );

    const termSections: InspectorSectionSpec<MaskAntennaTemplateDraft>[] = (
      draft?.terms ?? []
    ).map((term, termIndex) => {
      const termKey =
        term.name &&
        !term.name.includes("|") &&
        (draft?.terms ?? []).filter((item) => item.name === term.name).length === 1
          ? `name:${term.name}`
          : String(termIndex);
      const maskFn = termFunction(term, "mask");
      const timeFn = termFunction(term, "time");

      const makeHandlers = (role: MaskFunctionRole) => ({
        onLocalAdd: (name: string, expression: string) =>
          setDraft((v) => addTermLocalEquation(v, termIndex, role, name, expression)),
        onLocalChange: (localIndex: number, expression: string) =>
          setDraft((v) => setTermLocal(v, termIndex, role, localIndex, expression)),
        onLocalRemove: (name: string) =>
          setDraft((v) => removeTermLocalEquation(v, termIndex, role, name)),
        onOutputChange: (outputIndex: number, expression: string) =>
          setDraft((v) => setTermOutput(v, termIndex, role, outputIndex, expression)),
        onParameterAdd: (name: string) =>
          setDraft((v) => addTermParameter(v, termIndex, role, name)),
        onParameterRemove: (name: string) =>
          setDraft((v) => removeTermParameter(v, termIndex, role, name)),
      });

      return {
        id: `mask-term-${termIndex}`,
        title: `Term ${termIndex + 1}${term.name ? ` · ${term.name}` : ""}`,
        icon: Waves,
        defaultOpen: true,
        rows: [
          {
            type: "custom",
            wide: true,
            render: () => (
              <div className="flex flex-col gap-2.5" data-slot={`mask-term-${termIndex}`}>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-[var(--fm-text)]">Term name</span>
                  <Input
                    aria-label="Term name"
                    autoComplete="off"
                    className="font-mono text-xs"
                    disabled={termsLocked}
                    placeholder="Optional identifier (e.g. carrier)"
                    type="text"
                    value={term.name ?? ""}
                    onChange={(event) => {
                      const nextName = event.target.value;
                      setDraft((v) => setTermName(v, termIndex, nextName));
                    }}
                  />
                </div>

                {term.origin ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2 py-1.5 text-xs">
                    <span className="text-[var(--fm-text-muted)]">Origin</span>
                    <span className="font-mono text-[var(--fm-text)]">
                      {term.origin.function}; editing the term detaches it
                    </span>
                  </div>
                ) : null}

                {maskFn ? (
                  <MaskFunctionFields
                    disabled={termsLocked}
                    raw={raw}
                    role="mask"
                    target={maskFn}
                    termKey={termKey}
                    onRawChange={setRaw}
                    {...makeHandlers("mask")}
                  />
                ) : term.mask.kind === "sampled" ? (
                  <ArrayMaskRows mask={term.mask} />
                ) : null}

                <div className="flex items-center justify-between gap-2 py-0.5">
                  <span className="text-xs font-medium text-[var(--fm-text)]">
                    Static (no time function)
                  </span>
                  <Switch
                    aria-label="Static (no time function)"
                    checked={!timeFn}
                    disabled={termsLocked}
                    onCheckedChange={(isStatic) =>
                      setDraft((v) => setTermStatic(v, termIndex, isStatic))
                    }
                  />
                </div>

                {timeFn ? (
                  <MaskFunctionFields
                    disabled={termsLocked}
                    raw={raw}
                    role="time"
                    target={timeFn}
                    termKey={termKey}
                    onRawChange={setRaw}
                    {...makeHandlers("time")}
                  />
                ) : null}

                <div className="flex items-center justify-end">
                  <Button
                    disabled={termsLocked || (draft?.terms.length ?? 0) <= 1}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setDraft((v) => removeTerm(v, termIndex))}
                  >
                    <Trash2 aria-hidden="true" size={12} />
                    <span>Remove term</span>
                  </Button>
                </div>
              </div>
            ),
          },
        ],
      };
    });

    return {
      id: "physics.field-drive.mask",
      header: {
        breadcrumbs: [
          {
            id: "drives",
            label: "Field Drives",
            selection: buildRootSelection(
              "physics.field-drives",
              "model:physics:field-drives",
              "Field Drives",
            ),
          },
          { id: "drive", label: draft?.name || model.driveId || "Mask antenna" },
        ],
        searchable: true,
        ...(model.mode === "found"
          ? {
              deleteAction: {
                label: "Delete Field Drive",
                confirmTitle: (d) => `Delete mask antenna "${d.name || d.id}"?`,
                confirmDescription:
                  "Deleting this mask antenna permanently removes its support volume and all analytic/sampled field terms from the session model.",
                onDelete: async () => {
                  await removeAntenna();
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: (d) => d.name || model.driveId || "Mask antenna",
        renameFieldKey: "name",
        kindLabel: "Spatial mask field drive",
        entityId: model.driveId ?? draft?.id,
        statePill: (d) =>
          model.mode === "create"
            ? { tone: "info", label: "Configured" }
            : model.mode === "found"
              ? d.enabled
                ? { tone: "ok", label: "Active" }
                : { tone: "degraded", label: "Disabled" }
              : { tone: "warn", label: "Not in scene" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "terms", label: "Terms", value: `${d.termsCount} / ${MAX_MASK_TERMS}` },
        { id: "frame", label: "Frame", value: d.frame === "local" ? "Local" : "World" },
        {
          id: "shape",
          label: "Shape",
          value:
            d.shapeKind === "cylinder"
              ? "Cylinder"
              : d.shapeKind === "sphere"
                ? "Sphere"
                : "Box",
        },
        {
          id: "origin",
          label: "Time origin",
          value: d.timeOrigin === "absolute" ? "Absolute" : "Stage local",
        },
      ],
      notices: (): readonly InspectorNotice<MaskAntennaTemplateDraft>[] => {
        const list: InspectorNotice<MaskAntennaTemplateDraft>[] = [];
        if (model.mode !== "create" && model.mode !== "found") {
          list.push({
            id: "mask-missing",
            tone: "warn",
            title: "Mask antenna not found in scene",
            text: "Select an active mask antenna from Field Drives or create a new mask antenna.",
          });
        }
        if (conflict) {
          list.push({
            id: "mask-conflict",
            tone: "warn",
            title: "Concurrent scene edits detected",
            text: `${SCENE_CHANGED_REASON} Changed on both sides: ${conflicts
              .map((path) => path.replace(/^drive\./, ""))
              .join(", ")}`,
          });
        }
        if (feedback?.kind === "error") {
          list.push({
            id: "mask-error",
            tone: "err",
            title: "Mask antenna error",
            text: feedback.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "mask-general",
          title: "Mask antenna",
          icon: Radio,
          defaultOpen: true,
          rows: [
            ...(conflict
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div
                        className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2"
                        data-slot="mask-conflict-actions"
                      >
                        <Button
                          disabled={pending}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={keepDraft}
                        >
                          Keep my values
                        </Button>
                        <Button
                          disabled={pending}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={resetDraft}
                        >
                          Load scene version
                        </Button>
                      </div>
                    ),
                  },
                ]
              : []),
            ...(model.mode === "create"
              ? [
                  {
                    key: "id" as const,
                    type: "text" as const,
                    label: "ID",
                    mono: true,
                    disabledReason: () => (locked ? "Antenna is locked while saving." : null),
                    validate: (v: string) =>
                      v.trim().length === 0 ? "The antenna needs an ID." : null,
                  },
                ]
              : [
                  {
                    type: "readonly" as const,
                    label: "ID",
                    mono: true,
                    format: () => model.driveId ?? "—",
                  },
                ]),
            {
              key: "name",
              type: "text",
              label: "Name",
              disabledReason: () => (locked ? "Antenna is locked while saving." : null),
              validate: (v) => (v.trim().length === 0 ? "The antenna needs a name." : null),
            },
            {
              key: "enabled",
              type: "switch",
              label: "Enabled",
              disabledReason: () => (locked ? "Antenna is locked while saving." : null),
            },
            {
              key: "targetKind",
              type: "select",
              label: "Target",
              structural: true,
              options: [
                { value: "global", label: "Global" },
                { value: "object", label: "Object" },
                { value: "region", label: "Region" },
              ],
            },
            {
              key: "targetObjectId",
              type: "select",
              label: "Object",
              structural: true,
              showWhen: (d) => d.targetKind !== "global",
              options: objectSelectOptions,
              validate: (v, d) =>
                d.targetKind !== "global" && (v === UNSELECTED_OBJECT || v.trim().length === 0)
                  ? "Select the target object."
                  : null,
            },
            {
              key: "targetRegionId",
              type: "select",
              label: "Stable region",
              showWhen: (d) => d.targetKind === "region",
              options: regionSelectOptions,
              validate: (v, d) =>
                d.targetKind === "region" && (v === UNSELECTED_REGION || v.trim().length === 0)
                  ? "Select the target region."
                  : null,
            },
            {
              key: "frame",
              type: "segmented",
              label: "Frame",
              options: [
                { value: "world", label: "World" },
                { value: "local", label: "Local (target object)" },
              ],
            },
            {
              key: "timeOrigin",
              type: "segmented",
              label: "Time origin",
              options: [
                { value: "stage_local", label: "Stage local" },
                { value: "absolute", label: "Absolute" },
              ],
            },
          ],
        },
        {
          id: "mask-support-shape",
          title: "Support shape",
          icon: Box,
          defaultOpen: true,
          rows: [
            {
              key: "shapeKind",
              type: "segmented",
              label: "Shape",
              structural: true,
              options: [
                { value: "box", label: "Box" },
                { value: "cylinder", label: "Cylinder" },
                { value: "sphere", label: "Sphere" },
              ],
            },
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-col gap-2" data-slot="mask-support-shape-fields">
                  <MaskRawVectorField
                    disabled={locked}
                    keyPrefix="position"
                    label="Position (m)"
                    raw={raw}
                    unit="m"
                    values={draft?.position_m ?? [0, 0, 0]}
                    onChange={setRaw}
                  />
                  {shape?.kind === "box" ? (
                    <MaskRawVectorField
                      disabled={locked}
                      keyPrefix="shape|size"
                      label="Size (m)"
                      raw={raw}
                      unit="m"
                      values={shape.size}
                      onChange={setRaw}
                    />
                  ) : null}
                  {shape && shape.kind !== "box" ? (
                    <MaskRawScalarField
                      disabled={locked}
                      fieldKey="shape|radius"
                      label="Radius"
                      raw={raw}
                      unit="m"
                      value={shape.radius}
                      onChange={setRaw}
                    />
                  ) : null}
                  {shape?.kind === "cylinder" ? (
                    <>
                      <MaskRawScalarField
                        disabled={locked}
                        fieldKey="shape|height"
                        label="Height"
                        raw={raw}
                        unit="m"
                        value={shape.height}
                        onChange={setRaw}
                      />
                      <MaskRawVectorField
                        disabled={locked}
                        keyPrefix="shape|axis"
                        label="Axis"
                        raw={raw}
                        values={shape.axis}
                        onChange={setRaw}
                      />
                    </>
                  ) : null}
                  {shape ? (
                    <MaskRawVectorField
                      disabled={locked}
                      keyPrefix="shape|center"
                      label="Center offset (m)"
                      raw={raw}
                      unit="m"
                      values={shape.center}
                      onChange={setRaw}
                    />
                  ) : null}
                </div>
              ),
            },
          ],
        },
        ...readyCallSections,
        ...termSections,
        {
          id: "mask-add-terms",
          title: "Add terms & ready antennas",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-col gap-2.5" data-slot="mask-add-controls">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      {draft?.terms.length ?? 0} of {MAX_MASK_TERMS} terms authored
                    </span>
                    <Button
                      disabled={termsLocked || (draft?.terms.length ?? 0) >= MAX_MASK_TERMS}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => setDraft((v) => addTerm(v))}
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Add term</span>
                    </Button>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--fm-text)]">
                      Ready antenna
                    </span>
                    <Select
                      disabled={termsLocked || registry.length === 0}
                      value={newReadyFunction}
                      onValueChange={(nextVal) => setNewReadyFunction(nextVal)}
                    >
                      <SelectTrigger aria-label="Ready antenna">
                        <SelectValue placeholder="Select a ready antenna" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNSELECTED_READY_ANTENNA}>
                          Select a ready antenna
                        </SelectItem>
                        {registry.map((antenna) => (
                          <SelectItem key={antenna.function} value={antenna.function}>
                            {antenna.function.split(".").pop()} — {antenna.summary}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {newReadyAntenna ? (
                    <div className="rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
                      <div className="mb-1.5 text-xs font-medium text-[var(--fm-text)]">
                        New ready antenna
                      </div>
                      <ReadyAntennaCallFields
                        key={newReadyAntenna.function}
                        antenna={newReadyAntenna}
                        buildDisabled={readyBusy !== null}
                        busy={readyBusy === NEW_READY_CALL}
                        disabled={termsLocked}
                        values={readyAntennaDefaultArguments(newReadyAntenna)}
                        onBuild={(values) =>
                          void buildReadyAntennaTerms(newReadyAntenna, null, values)
                        }
                      />
                    </div>
                  ) : null}
                </div>
              ),
            },
          ],
        },
        {
          id: "mask-stage-activation",
          title: "Stage activation",
          icon: Sliders,
          defaultOpen: false,
          rows: [
            {
              key: "stageScopeKind",
              type: "segmented",
              label: "Active stages",
              structural: true,
              options: [
                { value: "all_time_evolution", label: "All time stages" },
                { value: "stage_ids", label: "Selected stages" },
              ],
            },
            {
              key: "selectedStageIds",
              type: "toggles",
              label: "Participating stages",
              showWhen: (d) =>
                d.stageScopeKind === "stage_ids" && stageToggleOptions.length > 0,
              options: stageToggleOptions,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: model.mode === "create" && discardedSelection !== selection,
        cleanMessage: () => "Mask antenna matches committed SceneDocument",
        lockReason: () => lockReason,
        onApply: () => saveRef.current(),
        onRevert: () => resetDraft(),
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    calls,
    conflict,
    conflicts,
    discardedSelection,
    draft,
    feedback,
    keepDraft,
    locked,
    lockReason,
    model.driveId,
    model.mode,
    newReadyAntenna,
    newReadyFunction,
    objectSelectOptions,
    pending,
    raw,
    readyBusy,
    regionSelectOptions,
    registry,
    resetDraft,
    selection,
    setDraft,
    setRaw,
    stageToggleOptions,
    termsLocked,
  ]);

  const emptyTouched = useMemo(() => new Set<string>(), []);

  return (
    <>
      <InspectorTemplate
        animationKey={`${selectionTargetKey}:mask`}
        appliedFlash={appliedFlash}
        appliedMessage={model.mode === "create" ? "Mask antenna created" : "Mask antenna saved"}
        applyError={feedback?.kind === "error" ? feedback.message : null}
        applying={pending}
        baseline={templateBaseline}
        dirtyFields={dirtyFieldsSet}
        draft={templateDraft}
        forceShowErrors={validationErrors.length > 0 && (dirty || model.mode === "create")}
        invalidFields={invalidFieldsMap}
        selection={selection}
        spec={spec}
        touchedFields={emptyTouched}
        onApply={() => saveRef.current()}
        onFieldChange={handleFieldChange}
        onFieldTouch={() => undefined}
        onFitView={(commandId) => {
          void kernel.commands.execute(
            commandId ?? "viewport-3d.fit-selection",
            createCommandContext("inspector", kernel),
          );
        }}
        onHideInspector={() => kernel.layout?.setPanelVisible?.("right", false)}
        onOpenCodePreview={(title, language, code) => setCodePreview({ title, language, code })}
        onRevertAll={resetDraft}
        onRevertField={() => resetDraft()}
        onSelectNode={(next) => kernel.selection.set(next, "inspector")}
      />

      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{codePreview?.title ?? "Code preview"}</DialogTitle>
            <DialogDescription>
              {codePreview?.language === "json" ? "JSON payload" : "Python authoring snippet"}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-3 font-mono text-xs text-[var(--fm-text)]">
            <code>{codePreview?.code ?? ""}</code>
          </pre>
          <DialogFooter>
            <Button
              size="sm"
              type="button"
              variant="primary"
              onClick={() => setCodePreview(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

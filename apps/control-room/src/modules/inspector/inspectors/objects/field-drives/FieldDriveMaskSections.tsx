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

import type {
  MaskFieldDriveResource,
  ReadyAntennaResource,
} from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import {
  addTerm,
  addTermParameter,
  MAX_MASK_TERMS,
  readyAntennaDefaultArguments,
  removeTerm,
  removeTermParameter,
  setTermLocal,
  setTermName,
  setTermOutput,
  setTermStatic,
  termFunction,
  type MaskFunctionRole,
  type ReadyAntennaCall,
} from "../../../panels/MaskAntennaPanelModel";
import {
  type InspectorFact,
  type InspectorNotice,
  type InspectorSectionSpec,
} from "../../../template";

import {
  addTermLocalEquation,
  NEW_READY_CALL,
  removeTermLocalEquation,
  SCENE_CHANGED_REASON,
  UNSELECTED_READY_ANTENNA,
  type MaskAntennaTemplateDraft,
  type RawInputs,
} from "./fieldDriveMaskShared";
import {
  ArrayMaskRows,
  MaskFunctionFields,
  MaskRawScalarField,
  MaskRawVectorField,
  ReadyAntennaCallFields,
} from "./FieldDriveMaskWidgets";
import { UNSELECTED_OBJECT, UNSELECTED_REGION } from "./fieldDriveShared";

export function buildMaskAntennaFacts(d: MaskAntennaTemplateDraft): readonly InspectorFact[] {
  return [
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
  ];
}

export function buildMaskAntennaNotices({
  conflict,
  conflicts,
  feedback,
  mode,
}: {
  conflict: boolean;
  conflicts: readonly string[];
  feedback: { kind: "error" | "success"; message: string } | null;
  mode: string;
}): readonly InspectorNotice<MaskAntennaTemplateDraft>[] {
  const list: InspectorNotice<MaskAntennaTemplateDraft>[] = [];
  if (mode !== "create" && mode !== "found") {
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
}

export interface BuildMaskAntennaSectionsParams {
  buildReadyAntennaTerms: (
    antenna: ReadyAntennaResource,
    callIndex: number | null,
    values: Record<string, number>,
  ) => Promise<void>;
  calls: readonly ReadyAntennaCall[];
  conflict: boolean;
  draft: MaskFieldDriveResource | null;
  keepDraft: () => void;
  locked: boolean;
  modelDriveId: string | null;
  modelMode: string;
  newReadyAntenna: ReadyAntennaResource | null;
  newReadyFunction: string;
  objectSelectOptions: readonly { value: string; label: string }[];
  pending: boolean;
  raw: RawInputs;
  readyBusy: string | null;
  regionSelectOptions: readonly { value: string; label: string }[];
  registry: readonly ReadyAntennaResource[];
  resetDraft: () => void;
  setDraft: (update: (value: MaskFieldDriveResource) => MaskFieldDriveResource) => void;
  setNewReadyFunction: (fn: string) => void;
  setRaw: (key: string, text: string) => void;
  stageToggleOptions: readonly { value: string; label: string }[];
  termsLocked: boolean;
}

export function buildMaskAntennaSections({
  buildReadyAntennaTerms,
  calls,
  conflict,
  draft,
  keepDraft,
  locked,
  modelDriveId,
  modelMode,
  newReadyAntenna,
  newReadyFunction,
  objectSelectOptions,
  pending,
  raw,
  readyBusy,
  regionSelectOptions,
  registry,
  resetDraft,
  setDraft,
  setNewReadyFunction,
  setRaw,
  stageToggleOptions,
  termsLocked,
}: BuildMaskAntennaSectionsParams): InspectorSectionSpec<MaskAntennaTemplateDraft>[] {
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

  return [
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
        ...(modelMode === "create"
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
                format: () => modelDriveId ?? "—",
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
  ];
}

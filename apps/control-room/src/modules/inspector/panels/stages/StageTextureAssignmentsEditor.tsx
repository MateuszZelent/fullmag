"use client";

import { Compass, Pencil, Plus, RotateCcw, Scaling, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { JsonObject, JsonValue, SceneResource } from "@/kernel/api/apiTypes";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  createDefaultMagneticTextureDraft,
  fitCharacteristicSizeToTarget,
  hydrateMagneticTextureDraftFromInitializer,
  resetDraftTransform,
  serializeMagneticTextureDraftToInitializer,
  switchDraftPresetPatch,
  validateMagneticTextureDraft,
  type MagneticTextureDraft,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  canonicalPresetKind,
  humanPresetLabel,
} from "@/shared/domain/magnetization-texture/texturePresets";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  InspectorSection,
  inspectorValuesEqual,
  type InspectorActionContext,
  type InspectorSpec,
} from "../../template";
import {
  readStageTextureAssignments,
  stageTextureAssignmentsValue,
  type StageTextureAssignment,
} from "../StudyStageAuthoringModel";
import {
  applyCoupledDraftFieldChange,
  buildMagneticTextureInspectorSections,
} from "../magnetic-texture/MagneticTextureCoreSections";
import { PresetGallery } from "../magnetic-texture/PresetGallery";
import { PresetTileIcon } from "../magnetic-texture/PresetTileIcons";
import { TexturePreviewCanvas } from "../magnetic-texture/TexturePreviewCanvas";

const MAX_ASSIGNMENTS = 4096;
const OBJECT_SCOPE_VALUE = "__object__";
const STAGE_AUTHORING_SECTION_IDS = new Set([
  "preset-parameters",
  "placement-transform",
  "coordinate-mapping",
]);

export function StageTextureAssignmentsEditor({
  disabledReason,
  onChange,
  onOpenChange,
  open,
  scene,
  value,
}: {
  disabledReason: string | null;
  onChange: (value: JsonValue | undefined) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  scene: SceneResource;
  value: JsonValue | undefined;
}) {
  const assignments = readStageTextureAssignments(value);
  const magnets = (scene.objects ?? []).filter((object) => object.role === "magnet");
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [selectedRegionId, setSelectedRegionId] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const activeEditingAssignment =
    editingIndex !== null && assignments && assignments[editingIndex]
      ? assignments[editingIndex]
      : null;

  const activeObject = selectedObjectId
    ? magnets.find((candidate) => candidate.id === selectedObjectId) ?? magnets[0]
    : magnets[0];
  const activeRegion = activeObject?.regions?.find(
    (candidate) => candidate.region_id === selectedRegionId && candidate.enabled !== false,
  );
  const disabled = disabledReason !== null;
  const addBlockedReason =
    disabledReason ??
    (!magnets.length
      ? "Add a magnetic object first."
      : editingIndex === null && assignments?.length === MAX_ASSIGNMENTS
        ? "The stage assignment limit has been reached."
        : null);

  const closeSubform = () => {
    setEditingIndex(null);
    onOpenChange(false);
  };

  return (
    <InspectorGroup title="Texture changes before this stage">
      <div className="text-xs text-fm-secondary">
        The configured Study flow applies these magnetization overrides at the entry of this stage.
      </div>

      {assignments === null ? (
        <div className="grid gap-2">
          <FeedbackBanner kind="error" message="This stage has an unreadable texture assignment list." />
          <Button
            disabled={disabled}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => onChange(undefined)}
          >
            Remove invalid texture list
          </Button>
        </div>
      ) : assignments.length > 0 ? (
        <div className="grid gap-1.5" data-slot="stage-texture-assignment-list" role="list">
          {keyedOccurrences(assignments, (assignment) =>
            JSON.stringify([
              assignment.object_id,
              assignment.region_id,
              assignment.initializer,
            ]),
          ).map(({ item: assignment, key }, index) => {
            const targetObj = magnets.find((item) => item.id === assignment.object_id);
            const targetReg = targetObj?.regions?.find(
              (item) => item.region_id === assignment.region_id,
            );
            const scope = [
              targetObj?.name || assignment.object_id,
              targetReg?.name || assignment.region_id,
            ]
              .filter(Boolean)
              .join(" / ");
            const rawPreset = assignment.initializer
              ? String(assignment.initializer.preset_kind ?? assignment.initializer.kind ?? "uniform")
              : null;
            const textureLabel = rawPreset
              ? humanPresetLabel(rawPreset, String(assignment.initializer?.kind ?? "preset_texture"))
              : assignment.region_id
                ? "Use object texture"
                : "Uniform +X";
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-2 rounded-xl border border-fm-subtle bg-fm-field px-2.5 py-1.5"
                role="listitem"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <PresetTileIcon presetKind={canonicalPresetKind(rawPreset)} size={24} />
                  <div className="grid min-w-0">
                    <span className="truncate text-xs font-medium text-fm-primary">{scope}</span>
                    <span className="text-xs text-fm-secondary">{textureLabel}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    aria-label={`Edit texture change ${index + 1} for ${scope}`}
                    disabled={disabled || open}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditingIndex(index);
                      setSelectedObjectId(assignment.object_id);
                      setSelectedRegionId(assignment.region_id ?? "");
                      onOpenChange(true);
                    }}
                  >
                    <Pencil aria-hidden="true" size={13} />
                    <span>Edit</span>
                  </Button>
                  <Button
                    aria-label={`Remove texture change ${index + 1} for ${scope}`}
                    disabled={disabled || open}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      onChange(
                        stageTextureAssignmentsValue(assignments.filter((_, i) => i !== index)),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" size={13} />
                    <span>Remove</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {!open && assignments !== null ? (
        <div className="flex items-center gap-2">
          <Button
            disabled={addBlockedReason !== null}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              setEditingIndex(null);
              onOpenChange(true);
            }}
          >
            <Plus aria-hidden="true" size={14} />
            <span>Add texture change</span>
          </Button>
        </div>
      ) : null}

      {open && assignments !== null && activeObject ? (
        <div className="grid min-w-0 gap-2.5 rounded-xl border border-fm-subtle bg-fm-panel p-2.5">
          <div className="grid gap-1.5 @[22rem]/insp:grid-cols-2">
            <div className="grid gap-1">
              <span className="text-xs font-medium text-fm-primary">Magnetic object</span>
              <Select
                disabled={disabled}
                value={activeObject.id}
                onValueChange={(nextObjId) => {
                  setSelectedObjectId(nextObjId);
                  setSelectedRegionId("");
                }}
              >
                <SelectTrigger aria-label="Magnetic object">
                  <SelectValue placeholder="Choose a magnetic object" />
                </SelectTrigger>
                <SelectContent>
                  {magnets.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name || item.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1">
              <span className="text-xs font-medium text-fm-primary">Apply to</span>
              <Select
                disabled={disabled}
                value={selectedRegionId || OBJECT_SCOPE_VALUE}
                onValueChange={(nextVal) =>
                  setSelectedRegionId(nextVal === OBJECT_SCOPE_VALUE ? "" : nextVal)
                }
              >
                <SelectTrigger aria-label="Apply to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OBJECT_SCOPE_VALUE}>
                    Object (region overrides apply)
                  </SelectItem>
                  {(activeObject.regions ?? []).flatMap((item) =>
                    item.enabled !== false && item.region_id
                      ? [
                          <SelectItem key={item.region_id} value={item.region_id}>
                            {item.name || item.region_id}
                          </SelectItem>,
                        ]
                      : [],
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <StageTextureCoreSubform
            key={`${editingIndex ?? "new"}:${activeObject.id}:${activeRegion?.region_id ?? "object"}`}
            disabled={disabled}
            initialAssignment={activeEditingAssignment}
            objectId={activeObject.id}
            objectName={activeObject.name || activeObject.id}
            regionId={activeRegion?.region_id ?? null}
            scene={scene}
            submitLabel={activeEditingAssignment ? "Save texture change" : "Add to stage"}
            onCancel={closeSubform}
            onCommit={(assignment) => {
              if (addBlockedReason !== null) return;
              if (editingIndex !== null && assignments[editingIndex]) {
                onChange(
                  stageTextureAssignmentsValue(
                    assignments.map((existing, idx) =>
                      idx === editingIndex ? assignment : existing,
                    ),
                  ),
                );
              } else {
                onChange(stageTextureAssignmentsValue([...assignments, assignment]));
              }
              closeSubform();
            }}
          />
        </div>
      ) : null}

      {addBlockedReason ? (
        <div className="text-xs text-fm-secondary" role="status">
          {addBlockedReason}
        </div>
      ) : null}
    </InspectorGroup>
  );
}

function StageTextureCoreSubform({
  scene,
  objectId,
  objectName,
  regionId,
  disabled,
  initialAssignment,
  submitLabel,
  onCommit,
  onCancel,
}: {
  scene: SceneResource;
  objectId: string;
  objectName: string;
  regionId: string | null;
  disabled: boolean;
  initialAssignment: StageTextureAssignment | null;
  submitLabel: string;
  onCommit: (assignment: StageTextureAssignment) => void;
  onCancel: () => void;
}) {
  const objectTarget = useMemo(() => ({ kind: "object" as const, objectId }), [objectId]);
  const target = useMemo(
    () =>
      regionId
        ? ({ kind: "region", objectId, regionId } as const)
        : ({ kind: "object", objectId } as const),
    [objectId, regionId],
  );
  const objectBounds = useMemo(
    () => resolveTargetBoundsMeters(scene, objectTarget),
    [objectTarget, scene],
  );
  const bounds = useMemo(() => resolveTargetBoundsMeters(scene, target), [scene, target]);

  const baselineDraft = useMemo<MagneticTextureDraft>(() => {
    const scope = regionId ? "region" : "object";
    if (initialAssignment?.initializer) {
      return hydrateMagneticTextureDraftFromInitializer(
        initialAssignment.initializer,
        bounds,
        scope,
        { inherited: false },
      );
    }
    return createDefaultMagneticTextureDraft("uniform", bounds, scope);
  }, [bounds, initialAssignment, regionId]);

  const [mode, setMode] = useState<"assign" | "reset">(() =>
    initialAssignment && initialAssignment.initializer === null ? "reset" : "assign",
  );
  const [draft, setDraft] = useState<MagneticTextureDraft>(() => baselineDraft);
  const [displayUnits, setDisplayUnits] = useState<Record<string, string>>({});
  const [touchedFields, setTouchedFields] = useState<Set<string>>(() => new Set());
  const [parseErrors, setParseErrors] = useState<Map<string, string>>(() => new Map());
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({
    "preset-parameters": true,
    "placement-transform": false,
    "coordinate-mapping": false,
  });
  const [error, setError] = useState<string | null>(null);

  const patchDraft = useCallback((partial: Partial<MagneticTextureDraft>) => {
    setError(null);
    setDraft((prev) => ({ ...prev, ...partial }));
  }, []);

  const setField = useCallback(
    <K extends keyof MagneticTextureDraft & string>(
      key: K,
      value: MagneticTextureDraft[K],
    ) => {
      setError(null);
      setDraft((prev) => ({
        ...prev,
        ...applyCoupledDraftFieldChange(prev, key, value, bounds),
      }));
    },
    [bounds],
  );

  const revertField = useCallback(
    (fieldKey: string) => {
      setError(null);
      setDraft((prev) => ({
        ...prev,
        [fieldKey]: (baselineDraft as unknown as Record<string, unknown>)[fieldKey],
      }));
    },
    [baselineDraft],
  );

  const authoringSections = useMemo(
    () =>
      buildMagneticTextureInspectorSections({
        hostContext: "object",
        bounds,
        objectBounds,
        parentObjectName: objectName,
        parentPresetLabel: "Uniform",
        parentPreviewSpec: null,
        supportedFieldFormats: ["field_state_json"],
        inspectionSummary: null,
        inspectingFieldFile: false,
        onInspectFieldFile: () => undefined,
      }).filter((section) => STAGE_AUTHORING_SECTION_IDS.has(section.id)),
    [bounds, objectBounds, objectName],
  );

  const subformSpec = useMemo<InspectorSpec<MagneticTextureDraft>>(
    () => ({
      id: "study.stage.texture-subform",
      header: { breadcrumbs: [{ id: "stage", label: "Stage" }] },
      identity: {
        domain: "material",
        icon: Compass,
        title: () => "Stage texture",
        kindLabel: "Stage assignment",
        statePill: () => ({ tone: "ok", label: "Analytical v2" }),
      },
      facts: () => [],
      sections: authoringSections,
      commitBar: { mode: "staged", onApply: async () => true },
    }),
    [authoringSections],
  );

  const dirtyFields = useMemo<ReadonlySet<string>>(() => {
    const dirty = new Set<string>();
    const cur = draft as unknown as Record<string, unknown>;
    const base = baselineDraft as unknown as Record<string, unknown>;
    for (const key of Object.keys(cur)) {
      if (!inspectorValuesEqual(cur[key], base[key])) {
        dirty.add(key);
      }
    }
    return dirty;
  }, [baselineDraft, draft]);

  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const merged = new Map<string, string>(
      validateMagneticTextureDraft({ ...draft, inheritanceMode: "override" }),
    );
    for (const [k, msg] of parseErrors.entries()) {
      merged.set(k, msg);
    }
    return merged;
  }, [draft, parseErrors]);

  const actionCtx = useMemo<InspectorActionContext<MagneticTextureDraft>>(
    () => ({
      specId: subformSpec.id,
      selection: {
        kind: "study.stage",
        label: objectName,
        moduleSource: "inspector",
        nodeId: `stage:${objectId}`,
        objectId,
        ref: null,
      },
      draft,
      baseline: baselineDraft,
      dirty: dirtyFields.size > 0,
      valid: invalidFields.size === 0,
      setField,
      patchDraft,
      revertField,
      requestApply: async () => true,
      focusField: () => undefined,
      selectNode: () => undefined,
      fitView: () => undefined,
      openCodePreview: () => undefined,
      notify: () => undefined,
    }),
    [
      baselineDraft,
      dirtyFields.size,
      draft,
      invalidFields.size,
      objectId,
      objectName,
      patchDraft,
      revertField,
      setField,
      subformSpec.id,
    ],
  );

  return (
    <TooltipProvider delayDuration={250}>
      <div className="grid min-w-0 gap-2.5" data-slot="stage-texture-subform">
        <SegmentedControl<"assign" | "reset">
          aria-label="Stage texture action"
          columns={2}
          disabled={disabled}
          options={[
            { value: "assign", label: "Assign preset" },
            { value: "reset", label: regionId ? "Use object texture" : "Reset to uniform +X" },
          ]}
          value={mode}
          onValueChange={setMode}
        />

        {mode === "assign" ? (
          <>
            <PresetGallery
              disabled={disabled}
              value={draft.presetKind}
              onSelect={(nextPreset) =>
                patchDraft(switchDraftPresetPatch(draft, nextPreset, bounds))
              }
            />
            <TexturePreviewCanvas
              bounds={bounds}
              draft={draft}
              interactiveCenterDrag={!disabled}
              onTranslateInSlice={(nextTranslation) =>
                patchDraft({ translationM: nextTranslation })
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <Badge className="text-xs tabular-nums">
                {`Scale [${draft.scale.map((s) => Number(s.toFixed(2))).join(", ")}]`}
              </Badge>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  disabled={disabled}
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => patchDraft(fitCharacteristicSizeToTarget(draft, bounds))}
                >
                  <Scaling aria-hidden="true" size={13} />
                  <span>Fit characteristic size</span>
                </Button>
                <Button
                  disabled={disabled}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => patchDraft(resetDraftTransform(draft, bounds))}
                >
                  <RotateCcw aria-hidden="true" size={13} />
                  <span>Reset transform</span>
                </Button>
              </div>
            </div>

            {authoringSections.map((section) => (
              <InspectorSection
                key={section.id}
                ctx={actionCtx}
                dirtyFields={dirtyFields}
                displayUnits={displayUnits}
                forceShowErrors={Boolean(error)}
                invalidFields={invalidFields}
                open={sectionOpen[section.id] ?? Boolean(section.defaultOpen)}
                section={section}
                spec={subformSpec}
                touchedFields={touchedFields}
                onDisplayUnitChange={(fieldKey, unit) =>
                  setDisplayUnits((prev) => ({ ...prev, [fieldKey]: unit }))
                }
                onOpenChange={(nextOpen) =>
                  setSectionOpen((prev) => ({ ...prev, [section.id]: nextOpen }))
                }
                onParseErrorChange={(fieldKey, parseErr) =>
                  setParseErrors((prev) => {
                    const next = new Map(prev);
                    if (parseErr) next.set(fieldKey, parseErr);
                    else next.delete(fieldKey);
                    return next;
                  })
                }
                onTouchField={(fieldKey) =>
                  setTouchedFields((prev) => {
                    if (prev.has(fieldKey)) return prev;
                    const next = new Set(prev);
                    next.add(fieldKey);
                    return next;
                  })
                }
              />
            ))}
          </>
        ) : null}

        {error ? <FeedbackBanner kind="error" message={error} /> : null}

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
            Cancel texture change
          </Button>
          <Button
            disabled={disabled}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => {
              if (mode === "reset") {
                onCommit({
                  object_id: objectId,
                  region_id: regionId,
                  initializer: regionId
                    ? null
                    : ({
                        kind: "preset_texture",
                        preset_kind: "uniform",
                        preset_version: 2,
                        preset_params: { direction: [1, 0, 0] },
                      } as JsonObject),
                });
                return;
              }
              if (invalidFields.size > 0) {
                const firstMsg = invalidFields.values().next().value;
                setError(firstMsg ?? "Invalid texture parameters.");
                return;
              }
              const initializer = serializeMagneticTextureDraftToInitializer(
                { ...draft, inheritanceMode: "override" },
                bounds,
              );
              onCommit({
                object_id: objectId,
                region_id: regionId,
                initializer,
              });
            }}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}

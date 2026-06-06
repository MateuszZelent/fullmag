"use client";

import { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useModelMaterialFieldsResource,
  useModelRegionDiagnosticsResource,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildObjectRegionPatch,
  clampObjectRegionDraftShapeToOwnerBounds,
  defaultMaterialOverrideDraft,
  defaultMaterialOverrideUnit,
  formatRegionPhysicalScalar,
  objectRegionDraftFromModel,
  objectRegionDraftKey,
  parseRegionPhysicalScalar,
  resolveObjectRegionPanelModel,
  validateObjectRegionDraft,
  type ObjectRegionDraft,
  type RegionEditRealizationPolicy,
  type RegionMaterialConflictPolicy,
  type RegionMaterialParameter,
  type RegionEditShapeKind,
  type RegionMeshPolicyDraft,
  type RegionShapeDraft,
} from "./ObjectRegionsPanelModel";
import { findLastRegionSelection, regionNodeId } from "./RegionsListPanelModel";
import { publishRegionAuthoringScene } from "./regionAuthoringInvalidation";

interface DraftState {
  draft: ObjectRegionDraft;
  key: string;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function PhysicalScalarField({
  disabled,
  label,
  unit,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  label: string;
  unit?: string;
  value: number;
  onValueChange: (next: number) => void;
}) {
  const formatted = formatRegionPhysicalScalar(value);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatted);
  const displayValue = editing ? text : formatted;

  return (
    <FormField
      label={label}
      inputMode="decimal"
      type="text"
      unit={unit}
      value={displayValue}
      disabled={disabled}
      onBlur={() => {
        setEditing(false);
        setText(formatRegionPhysicalScalar(value));
      }}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        const parsed = parseRegionPhysicalScalar(nextText);
        if (parsed !== null) {
          onValueChange(parsed);
        }
      }}
      onFocus={() => {
        setText(formatted);
        setEditing(true);
      }}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function revisionFromScene(scene: unknown): number {
  if (scene && typeof scene === "object" && "revision" in scene) {
    const revision = (scene as { revision?: unknown }).revision;
    if (typeof revision === "number" && Number.isFinite(revision)) {
      return revision;
    }
  }
  return Date.now();
}

function regionInspectorSections(selectionKind: string | null): string[] {
  switch (selectionKind) {
    case "object.region.geometry":
    case "object.region.shape":
      return ["regions", "shape", "actions"];
    case "object.region.mesh":
      return ["regions", "mesh", "actions"];
    case "object.region.magnetic-parameters":
    case "object.region.material":
      return ["regions", "material", "actions"];
    case "object.region.regions":
      return ["regions"];
    case "object.region.texture":
      return ["regions", "texture", "actions"];
    case "object.region.diagnostics":
      return ["regions", "diagnostics"];
    default:
      return [
        "regions",
        "identity",
        "shape",
        "material",
        "mesh",
        "texture",
        "diagnostics",
        "actions",
      ];
  }
}

export function ObjectRegionsPanel({ selection }: InspectorPanelProps) {
  const { api, resources, selection: selectionController } = useKernel();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
  const materialFields = useModelMaterialFieldsResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const model = useMemo(
    () =>
      resolveObjectRegionPanelModel(
        selection,
        scene.data,
        regions.data ?? null,
        materialFields.data ?? null,
        regionDiagnostics.data ?? null,
      ),
    [materialFields.data, regionDiagnostics.data, regions.data, scene.data, selection],
  );
  const baseDraft = useMemo(() => objectRegionDraftFromModel(model), [model]);
  const draftKey = objectRegionDraftKey(model);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const canWriteRegion =
    model.mode === "committed" && model.source === "authored_object_region";
  const sections = regionInspectorSections(selection.kind ?? "object.region");
  const showSection = (section: string) => sections.includes(section);

  function updateDraft(patch: Partial<ObjectRegionDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  function updateShape(patch: Partial<RegionShapeDraft>): void {
    const nextShape = {
      ...draft.shape,
      ...patch,
    };
    updateDraft({
      shape: clampObjectRegionDraftShapeToOwnerBounds(
        nextShape,
        draft.ownerBounds,
      ),
    });
  }

  function updateMeshPolicy(patch: Partial<RegionMeshPolicyDraft>): void {
    updateDraft({
      meshPolicy: {
        ...draft.meshPolicy,
        ...patch,
      },
    });
  }

  function updateMaterialOverride(
    index: number,
    patch: Partial<ObjectRegionDraft["materialOverrides"][number]>,
  ): void {
    const next = draft.materialOverrides.map((override, overrideIndex) =>
      overrideIndex === index ? { ...override, ...patch } : override,
    );
    updateDraft({ materialOverrides: next });
  }

  function addMaterialOverride(): void {
    updateDraft({
      materialOverrides: [
        ...draft.materialOverrides,
        defaultMaterialOverrideDraft(draft.priority),
      ],
    });
  }

  function removeMaterialOverride(index: number): void {
    updateDraft({
      materialOverrides: draft.materialOverrides.filter(
        (_override, overrideIndex) => overrideIndex !== index,
      ),
    });
  }

  function updateShapeVector(
    key: "axis" | "center" | "size",
    index: 0 | 1 | 2,
    value: number,
  ): void {
    const next = [...draft.shape[key]] as [number, number, number];
    next[index] = value;
    updateShape({ [key]: next });
  }

  function selectRegion(regionId: string, name: string): void {
    const nodeId = regionNodeId(model.objectId, regionId);
    selectionController.set(
      {
        kind: "object.region",
        label: name,
        nodeId,
        objectId: model.objectId,
        ref: {
          kind: "object.region",
          nodeId,
          objectId: model.objectId,
          regionId,
          type: "scene-object",
          visualizationTargetId: visualizationTargetIdForSceneObject(
            model.objectId,
            regionId,
          ),
        },
      },
      "inspector",
    );
  }

  async function applyRegion(): Promise<void> {
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }
    const validationErrors = validateObjectRegionDraft(draft);
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors[0] ?? "Invalid region draft." });
      return;
    }

    setPending(true);
    try {
      const response = await api.model.patchObjectRegionResource(
        model.objectId,
        model.regionId,
        buildObjectRegionPatch(draft),
        { baseRevision: model.revision ?? undefined },
      );
      const revision = revisionFromScene(response);
      publishRegionAuthoringScene(resources, response, revision);
      setFeedback({ kind: "success", message: "Object region updated." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function duplicateRegion(): Promise<void> {
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }

    setPending(true);
    try {
      const response = await api.model.duplicateObjectRegion(
        model.objectId,
        model.regionId,
        {},
        { baseRevision: model.revision ?? undefined },
      );
      const revision = revisionFromScene(response);
      publishRegionAuthoringScene(resources, response, revision);
      const duplicated = findLastRegionSelection(
        response,
        model.objectId,
        model.regionId,
      );
      if (duplicated) {
        selectRegion(duplicated.regionId, duplicated.name);
      }
      setFeedback({ kind: "success", message: "Object region duplicated." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function deleteRegion(): Promise<void> {
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }

    setPending(true);
    try {
      const response = await api.model.deleteRegion(model.objectId, model.regionId);
      const revision = revisionFromScene(response);
      publishRegionAuthoringScene(resources, response, revision);
      const fallback = findLastRegionSelection(
        response,
        model.objectId,
        model.regionId,
      );
      if (fallback) {
        selectRegion(fallback.regionId, fallback.name);
      } else {
        selectionController.set(
          {
            kind: "object.regions",
            label: "Regions",
            nodeId: `model:object:${model.objectId}:regions`,
            objectId: model.objectId,
            ref: {
              kind: "object.regions",
              nodeId: `model:object:${model.objectId}:regions`,
              objectId: model.objectId,
              type: "scene-object",
              visualizationTargetId: visualizationTargetIdForSceneObject(
                model.objectId,
              ),
            },
          },
          "inspector",
        );
      }
      setFeedback({ kind: "success", message: "Object region deleted." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      <InspectorSection value="regions" title="Object Regions" collapsible defaultCollapsed={false}>
        <FieldRow label="Object ID" value={model.objectId} />
        <FieldRow label="Region ID" value={model.regionId} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow label="Material ref" value={model.materialRef} />
        <FieldRow label="Magnetization ref" value={model.magnetizationRef} />
        <FieldRow
          label="Material overrides"
          value={String(model.materialOverrideCount)}
        />
        <FieldRow label="Parameter fields" value={String(model.materialFieldCount)} />
        <FieldRow
          label="Priority"
          value={model.priority === null ? "default" : String(model.priority)}
        />
        <FieldRow
          label="Realization"
          value={
            model.realizationStatus ??
            model.realizationPolicy ??
            "inherits object"
          }
        />
        <FieldRow label="Scene fetch" value={scene.status} />
        <FieldRow label="Regions fetch" value={regions.status} />
        <FieldRow label="Material fields fetch" value={materialFields.status} />
        <FieldRow label="Diagnostics fetch" value={regionDiagnostics.status} />
      </InspectorSection>

      {showSection("identity") ? (
      <InspectorSection value="identity" title="Region Identity">
        <FormField
          label="Region name"
          mono={false}
          type="text"
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.target.value })}
        />
        <FormField
          label="Enabled"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => updateDraft({ enabled: event.target.checked })}
        />
        <FormField
          label="Priority"
          type="number"
          step={1}
          value={String(draft.priority)}
          onChange={(event) => updateDraft({ priority: Number(event.target.value) })}
        />
        <FormField
          label="Frame"
          type="select"
          value={draft.frame}
          onChange={(event) => updateDraft({ frame: event.target.value })}
        >
          <option value="object">Object</option>
          <option value="world">World</option>
        </FormField>
        <FormField
          label="Realization"
          type="select"
          value={draft.realizationPolicy}
          onChange={(event) =>
            updateDraft({
              realizationPolicy: event.target.value as RegionEditRealizationPolicy,
            })
          }
        >
          <option value="inherit">Inherit</option>
          <option value="conformal">Conformal</option>
          <option value="project">Project</option>
        </FormField>
      </InspectorSection>
      ) : null}

      {showSection("shape") ? (
      <InspectorSection value="shape" title="Shape">
        <FormField
          label="Kind"
          type="select"
          value={draft.shape.kind}
          onChange={(event) =>
            updateShape({ kind: event.target.value as RegionEditShapeKind })
          }
        >
          <option value="box">Box</option>
          <option value="cylinder">Cylinder</option>
          <option value="sphere">Sphere</option>
        </FormField>
        <PhysicalScalarField
          label="Center X"
          unit="m"
          value={draft.shape.center[0]}
          onValueChange={(next) => updateShapeVector("center", 0, next)}
        />
        <PhysicalScalarField
          label="Center Y"
          unit="m"
          value={draft.shape.center[1]}
          onValueChange={(next) => updateShapeVector("center", 1, next)}
        />
        <PhysicalScalarField
          label="Center Z"
          unit="m"
          value={draft.shape.center[2]}
          onValueChange={(next) => updateShapeVector("center", 2, next)}
        />
        {draft.shape.kind === "box" ? (
          <>
            <PhysicalScalarField
              label="Size X"
              unit="m"
              value={draft.shape.size[0]}
              onValueChange={(next) => updateShapeVector("size", 0, next)}
            />
            <PhysicalScalarField
              label="Size Y"
              unit="m"
              value={draft.shape.size[1]}
              onValueChange={(next) => updateShapeVector("size", 1, next)}
            />
            <PhysicalScalarField
              label="Size Z"
              unit="m"
              value={draft.shape.size[2]}
              onValueChange={(next) => updateShapeVector("size", 2, next)}
            />
          </>
        ) : null}
        {draft.shape.kind === "cylinder" || draft.shape.kind === "sphere" ? (
          <PhysicalScalarField
            label="Radius"
            unit="m"
            value={draft.shape.radius}
            onValueChange={(next) => updateShape({ radius: next })}
          />
        ) : null}
        {draft.shape.kind === "cylinder" ? (
          <>
            <PhysicalScalarField
              label="Height"
              unit="m"
              value={draft.shape.height}
              onValueChange={(next) => updateShape({ height: next })}
            />
            <PhysicalScalarField
              label="Axis X"
              value={draft.shape.axis[0]}
              onValueChange={(next) => updateShapeVector("axis", 0, next)}
            />
            <PhysicalScalarField
              label="Axis Y"
              value={draft.shape.axis[1]}
              onValueChange={(next) => updateShapeVector("axis", 1, next)}
            />
            <PhysicalScalarField
              label="Axis Z"
              value={draft.shape.axis[2]}
              onValueChange={(next) => updateShapeVector("axis", 2, next)}
            />
          </>
        ) : null}
      </InspectorSection>
      ) : null}

      {showSection("mesh") ? (
      <InspectorSection value="mesh" title="Mesh Policy">
        <FormField
          label="Enable mesh policy"
          type="checkbox"
          checked={draft.meshPolicy.enabled}
          onChange={(event) => updateMeshPolicy({ enabled: event.target.checked })}
        />
        <PhysicalScalarField
          label="Max element size"
          unit="m"
          value={draft.meshPolicy.maximumElementSize}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ maximumElementSize: next })}
        />
        <PhysicalScalarField
          label="Min element size"
          unit="m"
          value={draft.meshPolicy.minimumElementSize}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ minimumElementSize: next })}
        />
        <PhysicalScalarField
          label="Transition distance"
          unit="m"
          value={draft.meshPolicy.transitionDistance}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ transitionDistance: next })}
        />
        <FormField
          label="Order"
          type="number"
          step={1}
          value={String(draft.meshPolicy.order)}
          disabled={!draft.meshPolicy.enabled}
          onChange={(event) => updateMeshPolicy({ order: Number(event.target.value) })}
        />
      </InspectorSection>
      ) : null}

      {showSection("material") ? (
      <InspectorSection value="material" title="Material Overrides">
        <FieldRow label="Overrides" value={model.materialOverrideCount} />
        <FieldRow label="Parameter fields" value={model.materialFieldCount} />
        {draft.materialOverrides.length === 0 ? (
          <FieldRow label="Local overrides" value="inherits object material" />
        ) : null}
        {draft.materialOverrides.map((override, index) => (
          <div className="fm-region-override" key={`${override.parameter}:${index}`}>
            <FormField
              label={`Override ${index + 1}`}
              type="select"
              value={override.parameter}
              onChange={(event) => {
                const parameter = event.target.value as RegionMaterialParameter;
                updateMaterialOverride(index, {
                  parameter,
                  unit: defaultMaterialOverrideUnit(parameter),
                });
              }}
            >
              <option value="Ms">Ms</option>
              <option value="Aex">Aex</option>
              <option value="alpha">alpha</option>
              <option value="Ku1">Ku1</option>
            </FormField>
            <PhysicalScalarField
              label="Value"
              unit={override.unit}
              value={override.value}
              onValueChange={(next) => updateMaterialOverride(index, { value: next })}
            />
            <FormField
              label="Unit"
              mono={false}
              type="text"
              value={override.unit}
              onChange={(event) =>
                updateMaterialOverride(index, { unit: event.target.value })
              }
            />
            <FormField
              label="Override priority"
              type="number"
              step={1}
              value={String(override.priority)}
              onChange={(event) =>
                updateMaterialOverride(index, { priority: Number(event.target.value) })
              }
            />
            <FormField
              label="Conflict"
              type="select"
              value={override.conflictPolicy}
              onChange={(event) =>
                updateMaterialOverride(index, {
                  conflictPolicy: event.target.value as RegionMaterialConflictPolicy,
                })
              }
            >
              <option value="error">Error</option>
              <option value="higher_priority_wins">Higher Priority Wins</option>
            </FormField>
            <div className="fm-inspector-toolbar">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => removeMaterialOverride(index)}
              >
                Remove Override
              </Button>
            </div>
          </div>
        ))}
        <div className="fm-inspector-toolbar">
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={addMaterialOverride}
          >
            Add Override
          </Button>
        </div>
      </InspectorSection>
      ) : null}

      {showSection("texture") ? (
      <InspectorSection value="texture" title="Texture Override">
        <FieldRow label="Assignment" value={model.textureAssignment} />
        <FieldRow label="Effective texture ref" value={model.effectiveMagnetizationRef} />
        <FieldRow label="Region texture ref" value={model.regionMagnetizationRef} />
        <FieldRow label="Texture override" value={model.textureOverrideKind} />
        <FieldRow
          label="Editor"
          value="Use the region Texture node for preset and transform edits"
        />
      </InspectorSection>
      ) : null}

      {showSection("diagnostics") ? (
      <InspectorSection value="diagnostics" title="Diagnostics">
        <FieldRow label="Mode" value={model.mode} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow
          label="Realization policy"
          value={model.realizationPolicy ?? "inherit"}
        />
        <FieldRow
          label="Realization status"
          value={model.realizationStatus ?? "authored"}
        />
        <FieldRow label="Scene revision" value={model.revision ?? "unknown"} />
        <FieldRow label="Region diagnostics" value={String(model.diagnosticCount)} />
        <FieldRow label="Warnings" value={String(model.warningCount)} />
        <FieldRow label="Errors" value={String(model.errorCount)} />
        {model.diagnostics.length === 0 ? (
          <FieldRow label="Messages" value="none" />
        ) : (
          model.diagnostics.map((diagnostic) => (
            <FieldRow
              key={diagnostic.diagnosticId}
              label={diagnostic.severity}
              value={`${diagnostic.code}: ${diagnostic.message}`}
            />
          ))
        )}
      </InspectorSection>
      ) : null}

      {showSection("actions") ? (
      <InspectorSection value="actions" title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || !canWriteRegion}
            size="sm"
            type="button"
            variant="primary"
            title={canWriteRegion ? undefined : "Select an authored object region"}
            onClick={() => void applyRegion()}
          >
            Apply Region
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setDraftState({ draft: baseDraft, key: draftKey });
              setFeedback(null);
            }}
          >
            Revert
          </Button>
          <Button
            disabled={pending || !canWriteRegion}
            size="sm"
            type="button"
            variant="ghost"
            title={canWriteRegion ? undefined : "Select an authored object region"}
            onClick={() => void duplicateRegion()}
          >
            Duplicate Region
          </Button>
          <span className="fm-inspector-toolbar__spacer" />
          <Button
            disabled={pending || !canWriteRegion}
            size="sm"
            type="button"
            variant="danger"
            title={canWriteRegion ? undefined : "Select an authored object region"}
            onClick={() => void deleteRegion()}
          >
            Delete Region
          </Button>
        </div>
        <FieldRow
          label="Write actions"
          value={canWriteRegion ? "available" : "authored regions only"}
        />
        {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      </InspectorSection>
      ) : null}
    </Accordion>
  );
}

export function ObjectRegionOverviewPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionGeometryPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionMagneticParametersPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionMeshPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionTexturePanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionNestedRegionsPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionDiagnosticsPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

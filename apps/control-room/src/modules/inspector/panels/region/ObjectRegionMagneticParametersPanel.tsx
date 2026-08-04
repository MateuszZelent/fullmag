"use client";

import type { ChangeEvent } from "react";
import { useMemo, useState } from "react";
import type { MaterialParameterFieldListResource, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { RegionMaterialParameter, RegionMaterialConflictPolicy } from "../ObjectRegionsPanelModel";
import { PhysicalScalarField } from "../ObjectRegionsPanel";
import { publishRegionAuthoringScene } from "../regionAuthoringInvalidation";
import {
  ObjectRegionMetadataSection,
  ObjectRegionActionsSection,
  ObjectRegionInlineDiagnostics,
  type RegionSubPanelProps,
} from "./shared";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  defaultMaterialOverrideUnit,
  defaultMaterialOverrideValue,
} from "../ObjectRegionsPanelModel";

const REGION_MATERIAL_PARAMETERS: RegionMaterialParameter[] = [
  "ms",
  "aex",
  "alpha",
  "ku1",
];
import {
  defaultMaterialFieldDraft,
  isEditableMaterialField,
  materialFieldDraftFromAssignment,
  materialFieldDraftKey,
  materialFieldRealizationRows,
  materialFieldFromDraft,
  MATERIAL_FIELD_PARAMETERS,
  sceneObjectMaterialFields,
  unitForMaterialParameter,
  type MaterialFieldDraft,
  type MaterialFieldDraftState,
  type MaterialFieldKind,
  type SceneMaterialParameterName,
  type SceneRegionConflictPolicy,
  type SceneRegionFrame,
} from "./ObjectRegionMaterialFieldsModel";

type LocalFeedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getParentParamInfo(
  param: RegionMaterialParameter,
  objectId: string,
  materialRef: string,
  materialFields: MaterialParameterFieldListResource | null,
  sceneData: SceneResource | null | undefined,
): { unit: string; value: number | string } {
  if (materialFields?.fields) {
    const field = materialFields.fields.find(
      (f) =>
        f.owner_object_id === objectId &&
        !f.source_region_id &&
        f.parameter.toLowerCase() === param.toLowerCase()
    );
    if (field) {
      const unit = field.unit ?? defaultMaterialOverrideUnit(param);
      if (
        field.field?.kind === "constant" &&
        typeof field.field.value === "number"
      ) {
        return { value: field.field.value, unit };
      }
      return { value: `${field.field?.kind ?? "authored"} field`, unit };
    }
  }
  
  if (sceneData?.materials) {
    const material = sceneData.materials.find((m) => m.id === materialRef);
    if (material?.properties) {
      let matVal: unknown;
      const paramLower = param.toLowerCase();
      const props = material.properties as Record<string, unknown>;
      if (paramLower === "ms") matVal = props.Ms;
      else if (paramLower === "aex") matVal = props.Aex;
      else if (paramLower === "dind") matVal = props.Dind;
      else if (paramLower === "dbulk") matVal = props.Dbulk;
      else matVal = props[param];

      if (typeof matVal === "number") {
        return { value: matVal, unit: defaultMaterialOverrideUnit(param) };
      }
    }
  }

  return {
    value: defaultMaterialOverrideValue(param),
    unit: defaultMaterialOverrideUnit(param),
  };
}

export function ObjectRegionMagneticParametersPanel(props: RegionSubPanelProps) {
  return useObjectRegionMagneticParametersPanelView(props);
}

function useObjectRegionMagneticParametersPanelView({
  model,
  draft,
  pending,
  draftDirty,
  buildRegion,
  regionMeshLifecycle,
  canWriteRegion,
  canWriteMeshRegion,
  meshLane = "unknown",
  couplingDependencies,
  updateMaterialOverride,
  addMaterialOverride,
  removeMaterialOverride,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
  materialFields,
}: RegionSubPanelProps) {
  const { api, resources } = useKernel();
  const { data: sceneData } = useSceneResource();
  const [fieldPending, setFieldPending] = useState(false);
  const [fieldFeedback, setFieldFeedback] = useState<LocalFeedback>(null);
  const objectMaterialFields = useMemo(
    () => sceneObjectMaterialFields(sceneData, model.objectId),
    [model.objectId, sceneData],
  );
  const editableRegionAssignments = useMemo(
    () =>
      objectMaterialFields.filter(
        (field) => field.region_id === model.regionId && isEditableMaterialField(field),
      ),
    [model.regionId, objectMaterialFields],
  );
  const unsupportedRegionFieldCount = useMemo(
    () =>
      objectMaterialFields.filter(
        (field) => field.region_id === model.regionId && !isEditableMaterialField(field),
      ).length,
    [model.regionId, objectMaterialFields],
  );
  const fieldDraftKey = materialFieldDraftKey(editableRegionAssignments);
  const baseFieldDrafts = useMemo(
    () =>
      editableRegionAssignments.flatMap((assignment) => {
        const field = materialFieldDraftFromAssignment(assignment);
        return field === null ? [] : [field];
      }),
    [editableRegionAssignments],
  );
  const [fieldDraftState, setFieldDraftState] = useState<MaterialFieldDraftState>({
    fields: baseFieldDrafts,
    key: fieldDraftKey,
  });
  const fieldDrafts =
    fieldDraftState.key === fieldDraftKey
      ? fieldDraftState.fields
      : baseFieldDrafts;

  function updateMaterialFieldDraft(
    index: number,
    patch: Partial<MaterialFieldDraft>,
  ): void {
    setFieldDraftState((current) => {
      const fields = current.key === fieldDraftKey ? current.fields : baseFieldDrafts;
      return {
        fields: fields.map((field, fieldIndex) =>
          fieldIndex === index
            ? {
                ...field,
                ...patch,
                unit: patch.parameter
                  ? unitForMaterialParameter(patch.parameter)
                  : (patch.unit ?? field.unit),
              }
            : field,
        ),
        key: fieldDraftKey,
      };
    });
    setFieldFeedback(null);
  }

  function updateMaterialFieldVector(
    index: number,
    key: "center" | "gradient",
    componentIndex: 0 | 1 | 2,
    value: number,
  ): void {
    const field = fieldDrafts[index];
    if (!field) return;
    const next = [...field[key]] as [number, number, number];
    next[componentIndex] = value;
    updateMaterialFieldDraft(index, { [key]: next });
  }

  function addMaterialField(): void {
    setFieldDraftState((current) => {
      const fields = current.key === fieldDraftKey ? current.fields : baseFieldDrafts;
      return {
        fields: [...fields, defaultMaterialFieldDraft(model)],
        key: fieldDraftKey,
      };
    });
    setFieldFeedback(null);
  }

  function removeMaterialField(index: number): void {
    setFieldDraftState((current) => {
      const fields = current.key === fieldDraftKey ? current.fields : baseFieldDrafts;
      return {
        fields: fields.filter((_field, fieldIndex) => fieldIndex !== index),
        key: fieldDraftKey,
      };
    });
    setFieldFeedback(null);
  }

  async function applyMaterialFields(): Promise<void> {
    if (!canWriteRegion) {
      setFieldFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }
    const invalid = fieldDrafts.find(
      (field) =>
        !Number.isFinite(field.priority) ||
        (field.kind === "radial" && (!Number.isFinite(field.radius) || field.radius <= 0)),
    );
    if (invalid) {
      setFieldFeedback({
        kind: "error",
        message: "Material field priority and radial radius must be finite values.",
      });
      return;
    }

    setFieldPending(true);
    try {
      const retainedFields = objectMaterialFields.filter(
        (field) =>
          field.region_id !== model.regionId || !isEditableMaterialField(field),
      );
      const response = await api.model.patchObjectMaterialFields(
        model.objectId,
        [
          ...retainedFields,
          ...fieldDrafts.map((field) => materialFieldFromDraft(field, model)),
        ],
        { baseRevision: model.revision ?? undefined },
      );
      publishRegionAuthoringScene(
        resources,
        response.committed_scene,
        response.scene_revision,
      );
      setFieldFeedback({ kind: "success", message: "Material fields updated." });
    } catch (error) {
      setFieldFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setFieldPending(false);
    }
  }

  const overriddenParams = new Set(
    draft.materialOverrides.map((override) => override.parameter),
  );
  const inheritedParams = REGION_MATERIAL_PARAMETERS.filter(
    (parameter) => !overriddenParams.has(parameter),
  );
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} meshLane={meshLane} />

      <InspectorGroup title="Material Overrides">
        <ObjectRegionInlineDiagnostics
          capabilityGates={["regions.material_override"]}
          model={model}
        />
        <FieldRow label="Overrides" value={model.materialOverrideCount} />
        <FieldRow label="Parameter fields" value={model.materialFieldCount} />

        {inheritedParams.length > 0 && (
          <div className="fm-region-inherited-parameters fm-mt-2 fm-mb-2">
            {inheritedParams.map((param) => {
              const info = getParentParamInfo(param, model.objectId, model.materialRef, materialFields, sceneData);
              return (
                <FieldRow
                  key={`inherited:${param}`}
                  label={param}
                  value={`${info.value} ${info.unit ? info.unit + " " : ""}(inherits parent)`}
                />
              );
            })}
          </div>
        )}

        {draft.materialOverrides.length === 0 ? (
          <FieldRow label="Local overrides" value="inherits object material" />
        ) : null}

        {draft.materialOverrides.map((override, index) => {
          const parentInfo = getParentParamInfo(
            override.parameter,
            model.objectId,
            model.materialRef,
            materialFields,
            sceneData,
          );
          return (
            <div className="fm-region-override fm-section-separator" key={`override:${index}`}>
              <FormField
                label={`Override ${index + 1}`}
                type="select"
                value={override.parameter}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  updateMaterialOverride(index, {
                    parameter: event.target.value as RegionMaterialParameter,
                  })
                }
              >
                <option value="ms">Ms</option>
                <option value="aex">Aex</option>
                <option value="alpha">alpha</option>
                <option value="ku1">Ku1</option>
              </FormField>
              <FieldRow
                label="Inherited parent"
                value={`${parentInfo.value} ${parentInfo.unit}`.trim()}
              />
              <PhysicalScalarField
                label="Local override"
                unit={override.unit}
                value={override.value}
                onValueChange={(next) => updateMaterialOverride(index, { value: next })}
              />
              <FormField
                label="Unit"
                mono={false}
                type="text"
                value={override.unit}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateMaterialOverride(index, { unit: event.target.value })
                }
              />
              <FormField
                label="Override priority"
                type="number"
                step={1}
                value={String(override.priority)}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateMaterialOverride(index, { priority: Number(event.target.value) })
                }
              />
              <FormField
                label="Conflict"
                type="select"
                value={override.conflictPolicy}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  updateMaterialOverride(index, {
                    conflictPolicy: event.target.value as RegionMaterialConflictPolicy,
                  })
                }
              >
                <option value="error">Error</option>
                <option value="higher_priority_wins">Higher Priority Wins</option>
              </FormField>
              <div className="fm-inspector-toolbar fm-toolbar-top">
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
          );
        })}
        <div className="fm-inspector-toolbar fm-toolbar-top-lg">
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={addMaterialOverride}
          >
            Add Override
          </Button>
        </div>
      </InspectorGroup>

      <InspectorGroup title="Material Fields">
        <FieldRow label="Editable fields" value={fieldDrafts.length} />
        <FieldRow label="Unsupported fields" value={unsupportedRegionFieldCount} />
        {fieldDrafts.length === 0 ? (
          <FieldRow label="Region fields" value="no local parameter fields" />
        ) : null}
        {fieldDrafts.map((field, index) => {
          const realizationRows = materialFieldRealizationRows(
            field.assignmentId,
            materialFields,
          );
          return (
          <div
            className="fm-region-override fm-section-separator"
            key={field.assignmentId}
          >
            <FormField
              label={`Field ${index + 1}`}
              type="select"
              value={field.parameter}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                updateMaterialFieldDraft(index, {
                  parameter: event.target.value as SceneMaterialParameterName,
                })
              }
            >
              {MATERIAL_FIELD_PARAMETERS.map((parameter) => (
                <option key={parameter} value={parameter}>
                  {parameter}
                </option>
              ))}
            </FormField>
            <FormField
              label="Field kind"
              type="select"
              value={field.kind}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                updateMaterialFieldDraft(index, {
                  kind: event.target.value as MaterialFieldKind,
                })
              }
            >
              <option value="constant">Constant</option>
              <option value="linear">Linear gradient</option>
              <option value="radial">Radial gradient</option>
            </FormField>
            {realizationRows.map((row, rowIndex) => (
              <FieldRow
                key={`realization:${field.assignmentId}:${rowIndex}`}
                label={row.label}
                value={row.value}
              />
            ))}
            {field.kind === "constant" ? (
              <PhysicalScalarField
                label="Value"
                unit={field.unit}
                value={field.scalar}
                onValueChange={(next) => updateMaterialFieldDraft(index, { scalar: next })}
              />
            ) : null}
            {field.kind === "linear" ? (
              <>
                <PhysicalScalarField
                  label="Base"
                  unit={field.unit}
                  value={field.base}
                  onValueChange={(next) => updateMaterialFieldDraft(index, { base: next })}
                />
                <PhysicalScalarField
                  label="Gradient X"
                  unit={`${field.unit}/m`}
                  value={field.gradient[0]}
                  onValueChange={(next) => updateMaterialFieldVector(index, "gradient", 0, next)}
                />
                <PhysicalScalarField
                  label="Gradient Y"
                  unit={`${field.unit}/m`}
                  value={field.gradient[1]}
                  onValueChange={(next) => updateMaterialFieldVector(index, "gradient", 1, next)}
                />
                <PhysicalScalarField
                  label="Gradient Z"
                  unit={`${field.unit}/m`}
                  value={field.gradient[2]}
                  onValueChange={(next) => updateMaterialFieldVector(index, "gradient", 2, next)}
                />
              </>
            ) : null}
            {field.kind === "radial" ? (
              <>
                <PhysicalScalarField
                  label="Inside"
                  unit={field.unit}
                  value={field.inside}
                  onValueChange={(next) => updateMaterialFieldDraft(index, { inside: next })}
                />
                <PhysicalScalarField
                  label="Outside"
                  unit={field.unit}
                  value={field.outside}
                  onValueChange={(next) => updateMaterialFieldDraft(index, { outside: next })}
                />
                <PhysicalScalarField
                  label="Radius"
                  unit="m"
                  value={field.radius}
                  onValueChange={(next) => updateMaterialFieldDraft(index, { radius: next })}
                />
                <PhysicalScalarField
                  label="Center X"
                  unit="m"
                  value={field.center[0]}
                  onValueChange={(next) => updateMaterialFieldVector(index, "center", 0, next)}
                />
                <PhysicalScalarField
                  label="Center Y"
                  unit="m"
                  value={field.center[1]}
                  onValueChange={(next) => updateMaterialFieldVector(index, "center", 1, next)}
                />
                <PhysicalScalarField
                  label="Center Z"
                  unit="m"
                  value={field.center[2]}
                  onValueChange={(next) => updateMaterialFieldVector(index, "center", 2, next)}
                />
              </>
            ) : null}
            {field.kind !== "constant" ? (
              <FormField
                label="Frame"
                type="select"
                value={field.frame}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  updateMaterialFieldDraft(index, {
                    frame: event.target.value as SceneRegionFrame,
                  })
                }
              >
                <option value="object">Object</option>
                <option value="world">World</option>
              </FormField>
            ) : null}
            <FormField
              label="Unit"
              mono={false}
              type="text"
              value={field.unit}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateMaterialFieldDraft(index, { unit: event.target.value })
              }
            />
            <FormField
              label="Priority"
              type="number"
              step={1}
              value={String(field.priority)}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateMaterialFieldDraft(index, { priority: Number(event.target.value) })
              }
            />
            <FormField
              label="Conflict"
              type="select"
              value={field.conflictPolicy}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                updateMaterialFieldDraft(index, {
                  conflictPolicy: event.target.value as SceneRegionConflictPolicy,
                })
              }
            >
              <option value="error">Error</option>
              <option value="higher_priority_wins">Higher Priority Wins</option>
              <option value="min_mesh_size_wins">Min Mesh Size Wins</option>
            </FormField>
            <div className="fm-inspector-toolbar fm-toolbar-top">
              <Button
                disabled={fieldPending}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => removeMaterialField(index)}
              >
                Remove Field
              </Button>
            </div>
          </div>
          );
        })}
        <div className="fm-inspector-toolbar fm-toolbar-top-lg">
          <Button
            disabled={fieldPending || !canWriteRegion}
            size="sm"
            type="button"
            variant="ghost"
            onClick={addMaterialField}
          >
            Add Field
          </Button>
          <Button
            disabled={fieldPending || !canWriteRegion}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyMaterialFields()}
          >
            Apply Fields
          </Button>
          <Button
            disabled={fieldPending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setFieldDraftState({ fields: baseFieldDrafts, key: fieldDraftKey });
              setFieldFeedback(null);
            }}
          >
            Revert Fields
          </Button>
        </div>
        {fieldFeedback ? (
          <FeedbackBanner kind={fieldFeedback.kind} message={fieldFeedback.message} />
        ) : null}
      </InspectorGroup>

      <ObjectRegionActionsSection
        pending={pending}
        draftDirty={draftDirty}
        buildRegion={buildRegion}
        regionMeshLifecycle={regionMeshLifecycle}
        canWriteRegion={canWriteRegion}
        canWriteMeshRegion={canWriteMeshRegion}
        meshLane={meshLane}
        couplingDependencies={couplingDependencies}
        applyRegion={applyRegion}
        revert={revert}
        duplicateRegion={duplicateRegion}
        deleteRegion={deleteRegion}
        feedback={feedback}
      />
    </div>
  );
}

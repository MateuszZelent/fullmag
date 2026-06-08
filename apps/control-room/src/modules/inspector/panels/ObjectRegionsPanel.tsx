"use client";

import { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useModelCouplingsResource,
  useModelMaterialFieldsResource,
  useModelRegionDiagnosticsResource,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FormField } from "../primitives/FormField";
import {
  buildObjectRegionPatch,
  clampObjectRegionDraftShapeToOwnerBounds,
  defaultMaterialOverrideDraft,
  formatRegionPhysicalScalar,
  objectRegionDraftFromModel,
  objectRegionDraftKey,
  parseRegionPhysicalScalar,
  resolveRegionCouplingDependencies,
  resolveObjectRegionPanelModel,
  validateObjectRegionDraft,
  type ObjectRegionDraft,
  type RegionMeshPolicyDraft,
  type RegionShapeDraft,
} from "./ObjectRegionsPanelModel";
import { syncAuthoringScriptBestEffort } from "./ObjectMagneticTexturePanelViewModel";
import { findLastRegionSelection, regionNodeId } from "./RegionsListPanelModel";
import { publishRegionAuthoringScene } from "./regionAuthoringInvalidation";

import { ObjectRegionDiagnosticsPanel as ObjectRegionDiagnosticsPanelImpl } from "./region/ObjectRegionDiagnosticsPanel";
import { ObjectRegionGeometryPanel as ObjectRegionGeometryPanelImpl } from "./region/ObjectRegionGeometryPanel";
import { ObjectRegionMagneticParametersPanel as ObjectRegionMagneticParametersPanelImpl } from "./region/ObjectRegionMagneticParametersPanel";
import { ObjectRegionMeshPanel as ObjectRegionMeshPanelImpl } from "./region/ObjectRegionMeshPanel";
import { ObjectRegionNestedRegionsPanel as ObjectRegionNestedRegionsPanelImpl } from "./region/ObjectRegionNestedRegionsPanel";
import { ObjectRegionOverviewPanel as ObjectRegionOverviewPanelImpl } from "./region/ObjectRegionOverviewPanel";
import { ObjectRegionTexturePanel as ObjectRegionTexturePanelImpl } from "./region/ObjectRegionTexturePanel";
import { ObjectRegionVisualizationPanel as ObjectRegionVisualizationPanelImpl } from "./region/ObjectRegionVisualizationPanel";
import type { RegionSubPanelProps } from "./region/shared";

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

export function PhysicalScalarField({
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

export function ObjectRegionsPanel({ selection }: InspectorPanelProps) {
  const { api, resources, selection: selectionController } = useKernel();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
  const materialFields = useModelMaterialFieldsResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const couplings = useModelCouplingsResource();

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
  const couplingDependencies = useMemo(
    () =>
      resolveRegionCouplingDependencies(
        model.objectId,
        model.regionId,
        couplings.data ?? null,
      ),
    [couplings.data, model.objectId, model.regionId],
  );

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
        draft.frame,
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
      const syncWarning = await syncAuthoringScriptBestEffort(api);
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region updated. Authoring script sync skipped: ${syncWarning}`
          : "Object region updated.",
      });
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
      const syncWarning = await syncAuthoringScriptBestEffort(api);
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region duplicated. Authoring script sync skipped: ${syncWarning}`
          : "Object region duplicated.",
      });
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
      const syncWarning = await syncAuthoringScriptBestEffort(api);
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region deleted. Authoring script sync skipped: ${syncWarning}`
          : "Object region deleted.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  const subProps: RegionSubPanelProps = {
    model,
    draft,
    pending,
    canWriteRegion,
    updateDraft,
    updateShape,
    updateShapeVector,
    updateMeshPolicy,
    updateMaterialOverride,
    addMaterialOverride,
    removeMaterialOverride,
    applyRegion,
    duplicateRegion,
    deleteRegion,
    revert: () => {
      setDraftState({ draft: baseDraft, key: draftKey });
      setFeedback(null);
    },
    feedback,
    materialFields: materialFields.data ?? null,
    couplingDependencies,
  };

  switch (selection.kind) {
    case "object.region.geometry":
    case "object.region.shape":
      return <ObjectRegionGeometryPanelImpl {...subProps} />;
    case "object.region.magnetic-parameters":
    case "object.region.material":
      return <ObjectRegionMagneticParametersPanelImpl {...subProps} />;
    case "object.region.mesh":
      return <ObjectRegionMeshPanelImpl {...subProps} />;
    case "object.region.regions":
      return <ObjectRegionNestedRegionsPanelImpl {...subProps} />;
    case "object.region.diagnostics":
      return <ObjectRegionDiagnosticsPanelImpl {...subProps} />;
    case "object.region.texture":
      return <ObjectRegionTexturePanelImpl {...subProps} />;
    case "object.region.visualization":
      return <ObjectRegionVisualizationPanelImpl {...subProps} />;
    case "object.region":
    default:
      return <ObjectRegionOverviewPanelImpl {...subProps} />;
  }
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

export function ObjectRegionVisualizationPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionNestedRegionsPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionDiagnosticsPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

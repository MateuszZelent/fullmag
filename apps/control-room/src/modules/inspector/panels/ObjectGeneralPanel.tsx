import { useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  deleteObjectTransaction,
  patchObjectTransaction,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  publishCommittedSceneResource,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useObjectMetricsResource } from "@/kernel/resources/studyRuntimeResources";
import {
  resolveVisualizationSettings,
  type ObjectVisualizationSnapshot,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { ObjectExtensionsSection } from "../extensions/ObjectExtensionsSection";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  resolveObjectGeneralPanelModel,
  resolveObjectMetricsPanelModel,
  summarizeGeometryValidationMessages,
} from "./objectGeneralPanelModel";

type Feedback = {
  kind: "error" | "success";
  message: string;
};

interface DraftState {
  name: string;
  notes: string;
  key: string;
}

interface FeedbackState {
  feedback: Feedback | null;
  key: string;
}

type GeometryObjectVisualizationColors = Pick<
  VisualizationTargetSettings,
  "shaderMonoColor" | "wireframeColor"
>;

function resolveGeometryObjectVisualizationColors(
  snapshot: ObjectVisualizationSnapshot,
  target: VisualizationTargetRef | null,
): GeometryObjectVisualizationColors | null {
  if (!target) return null;
  const settings = resolveVisualizationSettings(snapshot, target);
  return {
    shaderMonoColor: settings.shaderMonoColor,
    wireframeColor: settings.wireframeColor,
  };
}

function geometryObjectVisualizationColorsEquals(
  previous: GeometryObjectVisualizationColors | null,
  next: GeometryObjectVisualizationColors | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.shaderMonoColor === next.shaderMonoColor &&
    previous.wireframeColor === next.wireframeColor
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidateAuthoringResources(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number,
  committedScene?: SceneResource,
): void {
  if (committedScene) {
    publishCommittedSceneResource(resources, committedScene, revision);
  } else {
    resources.invalidate(MODEL_SCENE_PATH, revision);
  }
  resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
  resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
  resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
  resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
}

export function ObjectGeneralPanel({ selection }: InspectorPanelProps) {
  const { api, resources, selection: selectionController } = useKernel();
  const visualization = useObjectVisualizationController();
  const scene = useSceneResource();
  const validation = useGeometryValidationResource();
  const object = resolveObjectGeneralPanelModel(selection, scene.data);
  const objectMetrics = useObjectMetricsResource(
    object.mode === "committed" ? object.objectId : null,
  );

  const draftKey = `${object.mode}:${object.objectId}:${object.revision}`;
  const [draftState, setDraftState] = useState<DraftState>({
    name: object.name,
    notes: object.notes,
    key: draftKey,
  });
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: draftKey,
  });
  const [pending, setPending] = useState(false);

  const draftName = draftState.key === draftKey ? draftState.name : object.name;
  const draftNotes = draftState.key === draftKey ? draftState.notes : object.notes;
  const feedback = feedbackState.key === draftKey ? feedbackState.feedback : null;

  const validationMessages = summarizeGeometryValidationMessages(
    validation.data,
    object.objectId,
  );

  const visualizationTarget: VisualizationTargetRef | null =
    object.mode === "committed"
      ? { id: object.objectId, kind: "object", label: object.name }
      : null;

  const visualizationSettings = useObjectVisualizationSelector(
    (snapshot) => resolveGeometryObjectVisualizationColors(snapshot, visualizationTarget),
    { isEqual: geometryObjectVisualizationColorsEquals },
  );

  const metricsModel = resolveObjectMetricsPanelModel(objectMetrics.data);

  function updateDraft(field: "name" | "notes", value: string): void {
    setDraftState((current) => ({
      ...current,
      [field]: value,
      key: draftKey,
    }));
  }

  function setFeedback(feedbackValue: Feedback | null): void {
    setFeedbackState({
      feedback: feedbackValue,
      key: draftKey,
    });
  }

  async function applyIdentityPatch(): Promise<void> {
    if (object.mode !== "committed") return;
    setPending(true);
    try {
      const response = await patchObjectTransaction(api, object.objectId, {
        base_revision: object.revision,
        name: draftName,
        notes: draftNotes,
      });
      const nextRevision =
        typeof response.revision === "number"
          ? response.revision
          : (object.revision ?? 0) + 1;
      invalidateAuthoringResources(resources, nextRevision);
      setFeedback({ kind: "success", message: "Object identity committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function deleteObject(): Promise<void> {
    if (object.mode !== "committed") return;
    setPending(true);
    try {
      const response = await deleteObjectTransaction(api, object.objectId, {
        base_revision: object.revision,
      });
      invalidateAuthoringResources(
        resources,
        response.scene_revision,
        response.committed_scene,
      );
      selectionController.clear("geometry-authoring");
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  function revertDraft(): void {
    setDraftState({ name: object.name, notes: object.notes, key: draftKey });
    setFeedback(null);
  }

  function patchObjectColor(
    field: "primitiveColor" | "frameColor",
    value: string,
  ): void {
    if (!visualizationTarget) return;
    if (field === "primitiveColor") {
      visualization.patchTarget(visualizationTarget, {
        shaderColorMode: "monochrome",
        shaderMonoColor: value,
      });
      return;
    }
    visualization.patchTarget(visualizationTarget, { wireframeColor: value });
  }

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-[var(--fm-inspector-group-gap)]">
      <InspectorGroup title="Ferromagnet Object" collapsible defaultOpen>
        {object.mode === "committed" ? (
          <>
            <FormField
              label="Name"
              mono={false}
              type="text"
              value={draftName}
              onChange={(event) => updateDraft("name", event.target.value)}
            />
            <FormField
              label="Notes"
              type="textarea"
              value={draftNotes}
              onChange={(event) => updateDraft("notes", event.target.value)}
            />
          </>
        ) : (
          <FieldRow label="Name" value={object.name} />
        )}
        <FieldRow label="Object ID" value={object.objectId} />
        <FieldRow label="Shape" value={object.shape} />
        <FieldRow label="Material" value={object.material} />
        <FieldRow label="Region" value={object.region} />
        {object.mode === "committed" && visualizationSettings ? (
          <>
            <FormField
              label="Primitive color"
              mono={false}
              type="text"
              value={visualizationSettings.shaderMonoColor}
              onChange={(event) => patchObjectColor("primitiveColor", event.target.value)}
            />
            <FormField
              label="Frame color"
              mono={false}
              type="text"
              value={visualizationSettings.wireframeColor}
              onChange={(event) => patchObjectColor("frameColor", event.target.value)}
            />
          </>
        ) : null}
      </InspectorGroup>

      <InspectorGroup title="Energies" badge={metricsModel.status} collapsible defaultOpen>
        <FieldRow label="Fetch state" value={objectMetrics.status} />
        <FieldRow label="Sample" value={metricsModel.sample} />
        <FieldRow label="Source" value={metricsModel.source} />
        <FieldRow label="Average m" value={metricsModel.magnetization} />
        <FieldRow label="Exchange" value={metricsModel.exchange} />
        <FieldRow label="Demag" value={metricsModel.demag} />
        <FieldRow label="Zeeman" value={metricsModel.zeeman} />
        <FieldRow label="Anisotropy" value={metricsModel.anisotropy} />
        <FieldRow label="DMI" value={metricsModel.dmi} />
        <FieldRow label="Total" value={metricsModel.total} />
      </InspectorGroup>

      <InspectorGroup title="Resource State" collapsible defaultOpen>
        <FieldRow label="Source" value={object.source} />
        <FieldRow label="Mode" value={object.mode} />
        <FieldRow label="Mesh" value={object.meshStatus} />
        <FieldRow
          label="Scene revision"
          value={object.revision === null ? "unknown" : String(object.revision)}
        />
        <FieldRow label="Fetch state" value={scene.status} />
      </InspectorGroup>

      <InspectorGroup title="Actions">
        <div className="fm-inspector-toolbar">
          {object.mode === "committed" && (
            <>
              <Button
                disabled={pending}
                size="sm"
                type="button"
                onClick={() => void applyIdentityPatch()}
              >
                Apply Identity
              </Button>
              <Button
                disabled={pending}
                size="sm"
                type="button"
                variant="ghost"
                onClick={revertDraft}
              >
                Revert
              </Button>
              <span className="fm-inspector-toolbar__spacer" />
              <Button
                disabled={pending}
                size="sm"
                type="button"
                variant="danger"
                onClick={() => void deleteObject()}
              >
                Delete
              </Button>
            </>
          )}
        </div>
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} />
        ) : null}
      </InspectorGroup>

      <InspectorGroup
        title="Validation"
        badge={validationMessages.length > 0 ? String(validationMessages.length) : undefined}
        collapsible
        defaultOpen={validationMessages.length > 0}
      >
        <FieldRow label="Fetch state" value={validation.status} />
        {validationMessages.length > 0 ? (
          <ul className="fm-inspector-validation-list">
            {validationMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : (
          <FieldRow label="Backend validation" value="no object issues" />
        )}
      </InspectorGroup>

      <ObjectExtensionsSection
        objectId={object.objectId}
        selection={selection}
      />
    </div>
  );
}

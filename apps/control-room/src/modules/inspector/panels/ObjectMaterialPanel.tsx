"use client";

import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  resolveMaterialResourceKey,
  SCENE_RESOURCE_KEY,
  useMaterialResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import { resolveGeometryObjectDraft } from "./geometryObjectPanelModel";
import {
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  magneticParametersDraftFromResource,
  materialParametersDraftKey,
  normalizeMaterialRef,
  type MagneticParametersDraft,
} from "./ObjectMaterialPanelModel";

interface DraftState {
  draft: MagneticParametersDraft;
  key: string;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextLocalRevision(
  ...revisions: Array<number | string | null | undefined>
): number {
  const numericRevisions = revisions.filter(
    (revision): revision is number =>
      typeof revision === "number" && Number.isFinite(revision),
  );
  return numericRevisions.length > 0 ? Math.max(...numericRevisions) + 1 : 0;
}

function resolveMutationRevision(
  value: unknown,
  ...fallbacks: Array<number | string | null | undefined>
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : nextLocalRevision(...fallbacks);
}

export function ObjectMaterialPanel({ selection }: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const object = resolveGeometryObjectDraft(selection, scene.data);
  const materialId = normalizeMaterialRef(object.material);
  const material = useMaterialResource(materialId);
  const baseDraft = useMemo(
    () =>
      magneticParametersDraftFromResource(
        object.material,
        material.data ?? null,
      ),
    [material.data, object.material],
  );
  const assignmentKey = [
    object.mode,
    object.objectId,
    object.baseRevision ?? "unknown",
    object.material,
  ].join(":");
  const draftKey = `${assignmentKey}:${materialParametersDraftKey(
    object.material,
    material.data ?? null,
  )}`;
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const draftMaterialId = normalizeMaterialRef(draft.materialRef);
  const parametersTargetChanged = draftMaterialId !== materialId;

  function updateDraft(patch: Partial<MagneticParametersDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyMaterial(): Promise<void> {
    if (object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }

    setPending(true);
    try {
      const sceneResponse = await api.model.patchObject(
        object.objectId,
        buildMaterialAssignmentPatch(draft, object.baseRevision),
      );
      const revision = resolveMutationRevision(
        sceneResponse.revision,
        object.baseRevision,
      );
      invalidateMagneticParameterResources(revision);
      setFeedback({
        kind: "success",
        message: "Object material assignment updated.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function applyParameters(): Promise<void> {
    if (!materialId || !material.data) {
      setFeedback({
        kind: "error",
        message: "No committed material asset is assigned to this object.",
      });
      return;
    }
    if (parametersTargetChanged) {
      setFeedback({
        kind: "error",
        message: "Apply the material assignment before editing its parameters.",
      });
      return;
    }

    const result = buildMaterialParametersPatch(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setPending(true);
    try {
      await api.model.patchMaterial(materialId, result.patch);
      const revision = nextLocalRevision(material.revision, object.baseRevision);
      resources.invalidate(resolveMaterialResourceKey(materialId), revision);
      invalidateMagneticParameterResources(revision);
      setFeedback({
        kind: "success",
        message: "Magnetic parameters updated.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  function invalidateMagneticParameterResources(revision: number): void {
    resources.invalidate(SCENE_RESOURCE_KEY, revision);
    resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
    resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
    resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
    resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
  }

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={["parameters", "assignment", "material-parameters", "actions"]}
    >
      <InspectorSection value="parameters" title="Magnetic Parameters" collapsible defaultCollapsed={false}>
        <FieldRow label="Object ID" value={object.objectId} />
        <FieldRow label="Current material" value={object.material} />
        <FieldRow
          label="Material resource"
          value={material.data?.name ?? materialId ?? "unassigned"}
        />
        <FieldRow label="Mode" value={object.mode} />
        <FieldRow
          label="Scene revision"
          value={object.baseRevision === null ? "unknown" : String(object.baseRevision)}
        />
        <FieldRow label="Scene fetch" value={scene.status} />
        <FieldRow label="Material fetch" value={material.status} />
      </InspectorSection>

      <InspectorSection value="assignment" title="Assignment">
        <FormField
          label="Material ref"
          mono={false}
          type="text"
          value={draft.materialRef}
          onChange={(event) => updateDraft({ materialRef: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection value="material-parameters" title="Material Parameters">
        <FormField
          label="Name"
          mono={false}
          type="text"
          disabled={!material.data}
          value={draft.materialName}
          onChange={(event) => updateDraft({ materialName: event.target.value })}
        />
        <FormField
          label="Ms"
          type="number"
          unit="A/m"
          disabled={!material.data}
          value={draft.ms}
          onChange={(event) => updateDraft({ ms: event.target.value })}
        />
        <FormField
          label="Aex"
          type="number"
          unit="J/m"
          disabled={!material.data}
          value={draft.aex}
          onChange={(event) => updateDraft({ aex: event.target.value })}
        />
        <FormField
          label="alpha"
          type="number"
          disabled={!material.data}
          value={draft.alpha}
          onChange={(event) => updateDraft({ alpha: event.target.value })}
        />
        <FormField
          label="Dind"
          type="number"
          unit="J/m²"
          disabled={!material.data}
          value={draft.dind}
          onChange={(event) => updateDraft({ dind: event.target.value })}
        />
        <FormField
          label="Dbulk"
          type="number"
          unit="J/m³"
          disabled={!material.data}
          value={draft.dbulk}
          onChange={(event) => updateDraft({ dbulk: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection value="actions" title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || object.mode !== "committed"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyMaterial()}
          >
            Apply Assignment
          </Button>
          <Button
            disabled={pending || !material.data || parametersTargetChanged}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyParameters()}
          >
            Apply Parameters
          </Button>
          <Button
            disabled={pending}
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
        </div>
        {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      </InspectorSection>
    </Accordion>
  );
}

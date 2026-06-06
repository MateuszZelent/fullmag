"use client";

import { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
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
  buildNewRegionPayload,
  defaultNewRegionDraft,
  findRegionIdByName,
  regionNodeId,
  resolveRegionsListPanelModel,
  validateNewRegionDraft,
  type NewRegionDraft,
  type RegionShapeKind,
  type RegionsListItem,
} from "./RegionsListPanelModel";
import { publishRegionAuthoringScene } from "./regionAuthoringInvalidation";

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

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

function regionSummary(item: RegionsListItem): string {
  return [
    `priority: ${item.priority}`,
    item.realizationPolicy,
    `shape: ${item.shapeKind}`,
  ].join(" · ");
}

export function RegionsListPanel({ selection }: InspectorPanelProps) {
  const { api, resources, selection: selectionController } = useKernel();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
  const model = useMemo(
    () => resolveRegionsListPanelModel(selection, scene.data, regions.data ?? null),
    [regions.data, scene.data, selection],
  );
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NewRegionDraft>(defaultNewRegionDraft);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);

  function updateDraft(patch: Partial<NewRegionDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function selectRegion(item: RegionsListItem): void {
    const nodeId = regionNodeId(item.objectId, item.regionId);
    selectionController.set(
      {
        kind: "object.region",
        label: item.name,
        nodeId,
        objectId: item.objectId,
        ref: {
          kind: "object.region",
          nodeId,
          objectId: item.objectId,
          regionId: item.regionId,
          type: "scene-object",
          visualizationTargetId: visualizationTargetIdForSceneObject(
            item.objectId,
            item.regionId,
          ),
        },
      },
      "inspector",
    );
  }

  async function createRegion(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    const validationErrors = validateNewRegionDraft(draft);
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors[0] ?? "Invalid region draft." });
      return;
    }

    setPending(true);
    try {
      const response = await api.model.createRegion(
        model.objectId,
        buildNewRegionPayload(draft, model.ownerBounds),
        { baseRevision: model.revision ?? undefined },
      );
      const revision = revisionFromScene(response);
      publishRegionAuthoringScene(resources, response, revision);
      const createdRegionId = findRegionIdByName(
        response,
        model.objectId,
        draft.name,
      );
      if (createdRegionId) {
        selectRegion({
          colorIndex: 0,
          enabled: true,
          name: draft.name.trim(),
          objectId: model.objectId,
          priority: draft.priority,
          realizationPolicy: "inherit",
          realizationStatus: "authored_pending",
          regionId: createdRegionId,
          shapeKind: draft.shapeKind,
        });
      }
      setDraft(defaultNewRegionDraft());
      setAdding(false);
      setFeedback({ kind: "success", message: "Object region created." });
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
      defaultValue={["regions", "create", "summary"]}
    >
      <InspectorSection value="regions" title="Object Regions" collapsible defaultCollapsed={false}>
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || model.mode !== "committed"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => {
              setAdding(true);
              setFeedback(null);
            }}
          >
            Add Region
          </Button>
        </div>
        <div className="fm-region-list" role="list">
          {model.items.length === 0 ? (
            <div className="fm-region-list__empty">No authored regions.</div>
          ) : (
            model.items.map((item) => (
              <button
                key={item.regionId}
                className="fm-region-card"
                type="button"
                role="listitem"
                onClick={() => selectRegion(item)}
              >
                <span
                  className={`fm-region-card__dot fm-region-card__dot--${item.colorIndex}`}
                  aria-hidden="true"
                />
                <span className="fm-region-card__body">
                  <span className="fm-region-card__title-row">
                    <span className="fm-region-card__title">{item.name}</span>
                    <span className="fm-region-card__status">
                      {item.enabled ? "enabled" : "disabled"}
                    </span>
                  </span>
                  <span className="fm-region-card__meta">
                    {regionSummary(item)}
                  </span>
                  <span className="fm-region-card__meta">
                    {item.realizationStatus}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </InspectorSection>

      {adding ? (
        <InspectorSection value="create" title="New Region">
          <FormField
            label="Name"
            mono={false}
            type="text"
            value={draft.name}
            onChange={(event) => updateDraft({ name: event.target.value })}
          />
          <FormField
            label="Shape"
            type="select"
            value={draft.shapeKind}
            onChange={(event) =>
              updateDraft({ shapeKind: event.target.value as RegionShapeKind })
            }
          >
            <option value="box">Box</option>
            <option value="cylinder">Cylinder</option>
            <option value="sphere">Sphere</option>
          </FormField>
          <FormField
            label="Priority"
            type="number"
            step={1}
            value={String(draft.priority)}
            onChange={(event) =>
              updateDraft({ priority: Number(event.target.value) })
            }
          />
          <div className="fm-inspector-toolbar">
            <Button
              disabled={pending}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void createRegion()}
            >
              Create
            </Button>
            <Button
              disabled={pending}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setDraft(defaultNewRegionDraft());
                setFeedback(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </InspectorSection>
      ) : null}

      <InspectorSection value="summary" title="Summary">
        <FieldRow label="Object" value={model.objectLabel} />
        <FieldRow label="Object ID" value={model.objectId} />
        <FieldRow label="Region count" value={String(model.items.length)} />
        <FieldRow label="Scene fetch" value={scene.status} />
        <FieldRow label="Regions fetch" value={regions.status} />
        {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      </InspectorSection>
    </Accordion>
  );
}

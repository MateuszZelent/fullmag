"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import {
  useModelRegionDiagnosticsResource,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
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
import { resolveMeshInspectorLane } from "./fdmMeshInspectorModel";
import { publishRegionAuthoringScene } from "./regionAuthoringInvalidation";
import { syncAuthoringScriptBestEffort } from "./ObjectMagneticTexturePanelViewModel";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";

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

function diagnosticSummary(item: RegionsListItem): string | null {
  if (item.diagnosticCount === 0) return null;
  return [
    item.conflictCount > 0 ? `${item.conflictCount} conflict` : null,
    item.errorCount > 0 ? `${item.errorCount} error` : null,
    item.warningCount > 0 ? `${item.warningCount} warning` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function RegionsListPanel({ selection }: InspectorPanelProps) {
  const {
    api,
    authoringHistory,
    commands,
    resources,
    selection: selectionController,
  } = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const sessionDiscretization = useSessionStatusSelector(
    (status) => resolveSessionDiscretization(status.data),
  );
  const meshLane = resolveMeshInspectorLane(sessionDiscretization);
  const model = useMemo(
    () =>
      resolveRegionsListPanelModel(
        selection,
        scene.data,
        regions.data ?? null,
        regionDiagnostics.data ?? null,
        meshLane,
      ),
    [meshLane, regionDiagnostics.data, regions.data, scene.data, selection],
  );
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NewRegionDraft>(defaultNewRegionDraft);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const createInFlight = useRef(false);

  function updateDraft(patch: Partial<NewRegionDraft>): void {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
  }

  function resetDraft(): void {
    if (createInFlight.current) return;
    const reset = defaultNewRegionDraft();
    draftRef.current = reset;
    setDraft(reset);
    setAdding(false);
    setFeedback(null);
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

  const acknowledgeNewRegionDraft = useRegisterInspectorEditSession(
    adding ? "staged" : null,
    pending,
    adding,
    model.mode === "committed" && validateNewRegionDraft(draft).length === 0,
    undefined,
    createRegion,
    resetDraft,
    {
      applyBlockReason: sessionScopeKey
        ? undefined
        : "Session identity is not ready.",
      historyMode: "mutation-owned",
    },
  );

  async function createRegion(): Promise<boolean> {
    if (createInFlight.current) return false;
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }
    const submittedDraft = draft;
    const validationErrors = validateNewRegionDraft(submittedDraft);
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors[0] ?? "Invalid region draft." });
      return false;
    }

    const operationSessionScopeKey = sessionScopeKey;
    if (!operationSessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return false;
    }
    const historyGeneration = authoringHistory?.getGeneration?.();
    const historyContext = {
      api,
      authoringHistory,
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: () =>
        commands.getSessionScopeKey() === operationSessionScopeKey &&
        (historyGeneration === undefined ||
          authoringHistory?.getGeneration?.() === historyGeneration),
    };
    createInFlight.current = true;
    setPending(true);
    try {
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Create region ${submittedDraft.name.trim()}`,
        async ({ baseRevision }) => {
          const options = authoringWriteOptions(
            baseRevision ?? model.revision,
            operationSessionScopeKey,
          );
          if (!options?.sessionScopeKey || options.baseRevision === undefined) {
            throw new Error("A session-scoped scene revision is required to create a region.");
          }
          return api.model.createRegion(
            model.objectId,
            buildNewRegionPayload(submittedDraft, model.ownerBounds),
            options,
          );
        },
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revision = revisionFromScene(response);
      publishRegionAuthoringScene(
        resources,
        response,
        revision,
        undefined,
        operationSessionScopeKey,
        api.resourceCacheScope,
      );
      const createdRegionId = findRegionIdByName(
        response,
        model.objectId,
        submittedDraft.name,
      );
      const draftUnchanged = draftRef.current === submittedDraft;
      if (draftUnchanged) {
        if (!acknowledgeNewRegionDraft()) return false;
        const reset = defaultNewRegionDraft();
        draftRef.current = reset;
        setDraft(reset);
        setAdding(false);
      }
      if (createdRegionId && draftUnchanged) {
        selectRegion({
          colorIndex: 0,
          enabled: true,
          name: submittedDraft.name.trim(),
          objectId: model.objectId,
          priority: submittedDraft.priority,
          realizationPolicy: "inherit",
          realizationStatus: "authored_pending",
          regionId: createdRegionId,
          shapeKind: submittedDraft.shapeKind,
          conflictCount: 0,
          diagnosticCount: 0,
          errorCount: 0,
          warningCount: 0,
        });
      }
      const syncWarning = await syncAuthoringScriptBestEffort(api, sessionScopeKey);
      if (historyContext.isCurrentSessionScope() === false) return false;
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region created. Authoring script sync skipped: ${syncWarning}`
          : "Object region created.",
      });
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      createInFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Object Regions" collapsible defaultOpen>
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
            model.items.map((item) => {
              const diagnostics = diagnosticSummary(item);
              return (
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
                    {diagnostics ? (
                      <span className="fm-region-card__meta">
                        {diagnostics}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </InspectorGroup>

      {adding ? (
        <InspectorGroup title="New Region">
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
              onClick={resetDraft}
            >
              Cancel
            </Button>
          </div>
        </InspectorGroup>
      ) : null}

      <InspectorGroup title="Summary">
        <FieldRow label="Object" value={model.objectLabel} />
        <FieldRow label="Object ID" value={model.objectId} />
        <FieldRow label="Region count" value={String(model.items.length)} />
        <FieldRow label="Region conflicts" value={String(model.conflictCount)} />
        <FieldRow label="Region errors" value={String(model.errorCount)} />
        <FieldRow label="Region warnings" value={String(model.warningCount)} />
        <FieldRow label="Scene fetch" value={scene.status} />
        <FieldRow label="Regions fetch" value={regions.status} />
        <FieldRow label="Diagnostics fetch" value={regionDiagnostics.status} />
        {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      </InspectorGroup>
    </div>
  );
}

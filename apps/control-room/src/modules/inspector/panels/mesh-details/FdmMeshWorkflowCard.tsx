"use client";

import {
  AlertTriangle,
  ArrowRight,
  Box,
  CheckCircle2,
  CircleDot,
  Grid3x3,
  Layers,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import type { DomainMetaResource, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import { MeshRebuildConfirmDialog } from "../../inspectors/mesh/MeshRebuildConfirmDialog";
import { createStudyGlobalDraft } from "../StudyGlobalAuthoringModel";
import {
  buildStudyStagesMergePatch,
  createDefaultStudyStageDraft,
  withDefaultRelaxTimestepPolicy,
} from "../StudyStageAuthoringModel";

const MU0 = 4 * Math.PI * 1e-7;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatCellTupleNm(
  cellM: readonly [number, number, number] | readonly number[],
): string {
  const dx = Number(((cellM[0] ?? 0) * 1e9).toFixed(2));
  const dy = Number(((cellM[1] ?? 0) * 1e9).toFixed(2));
  const dz = Number(((cellM[2] ?? 0) * 1e9).toFixed(2));
  return `${dx} × ${dy} × ${dz} nm`;
}

function formatStageKindLabel(rawKind: string): string {
  const normalized = rawKind.trim().toLowerCase();
  switch (normalized) {
    case "relax":
      return "Relax";
    case "run":
      return "Run";
    case "hysteresis":
      return "Hysteresis";
    case "eigenmodes":
      return "Eigenmodes";
    case "frequency_response":
      return "Frequency response";
    case "add_field_drive":
      return "Field drive";
    case "table_autosave":
      return "Table autosave";
    case "autosave":
      return "Autosave";
    case "fft_response":
      return "FFT response";
    case "save_state":
      return "Save state";
    case "change_device":
      return "Change device";
    default:
      return normalized ? normalized.replace(/_/g, " ") : "Stage";
  }
}

export interface FdmWorkflowEvaluation {
  step1Geometry: {
    ready: boolean;
    magneticObjectCount: number;
    assignedObjectCount: number;
    firstUnassignedObject: { id: string; name: string } | null;
    limitingMaterial: { name: string; lexNm: number } | null;
    summary: string;
  };
  step2CellSize: {
    saved: boolean;
    ready: boolean;
    summary: string;
  };
  step3StudyStage: {
    ready: boolean;
    isCanonicalPipeline: boolean;
    stageCount: number;
    summary: string;
  };
  step4BuildGrid: {
    ready: boolean;
    voxelCount: number;
    shapeText: string | null;
    summary: string;
  };
  completedCount: number;
  canBuildNow: boolean;
  buildBlockedReason: string | null;
}

export function evaluateFdmMeshWorkflow(input: {
  sceneData: unknown;
  domainMeta: DomainMetaResource | null | undefined;
  gridMaterialized?: boolean;
  activeCellSizeM?: readonly [number, number, number] | null;
  activeGridShape?: readonly [number, number, number] | null;
  cellSizeModified?: boolean;
  canAutoSaveCellSize?: boolean;
}): FdmWorkflowEvaluation {
  const sceneRec = asRecord(input.sceneData);
  const rawObjects = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
  const rawMaterials = Array.isArray(sceneRec?.materials)
    ? sceneRec.materials
    : [];

  const nonMagneticRoles = new Set([
    "antenna",
    "conductor",
    "nonmagnetic",
    "airbox",
  ]);
  let magneticObjectCount = 0;
  let assignedObjectCount = 0;
  let firstUnassignedObject: { id: string; name: string } | null = null;
  const usedMaterialIds = new Set<string>();

  for (const entry of rawObjects) {
    const obj = asRecord(entry);
    if (!obj || obj.visible === false) continue;
    const role = asString(obj.role)?.toLowerCase() ?? "";
    if (role && nonMagneticRoles.has(role)) continue;
    magneticObjectCount += 1;
    const id = asString(obj.id) ?? asString(obj.object_id) ?? "";
    const name = asString(obj.name) ?? (id || "Object");
    const matRef = asString(obj.material_ref);
    if (matRef && matRef.toLowerCase() !== "unassigned") {
      assignedObjectCount += 1;
      usedMaterialIds.add(matRef);
    } else if (!firstUnassignedObject && id) {
      firstUnassignedObject = { id, name };
    }
  }

  let limitingMaterial: { name: string; lexNm: number } | null = null;
  for (const entry of rawMaterials) {
    const mat = asRecord(entry);
    if (!mat) continue;
    const id = asString(mat.id) ?? "";
    if (usedMaterialIds.size > 0 && id && !usedMaterialIds.has(id)) continue;
    const name = asString(mat.name) ?? (id || "Material");
    const props = asRecord(mat.properties) ?? mat;
    const ms =
      asNumber(props.ms) ??
      asNumber(props.Ms) ??
      asNumber(props.saturation_magnetization);
    const aex =
      asNumber(props.aex) ??
      asNumber(props.Aex) ??
      asNumber(props.exchange_stiffness);
    if (ms === null || aex === null || ms <= 0 || aex <= 0) continue;
    const lexM = Math.sqrt((2 * aex) / (MU0 * ms * ms));
    if (!Number.isFinite(lexM) || lexM <= 0) continue;
    const lexNm = Number((lexM * 1e9).toFixed(2));
    if (!limitingMaterial || lexNm < limitingMaterial.lexNm) {
      limitingMaterial = { lexNm, name };
    }
  }

  const step1Ready = assignedObjectCount >= 1 && firstUnassignedObject === null;
  const firstMatId = [...usedMaterialIds][0] ?? null;
  const step1Summary = step1Ready
    ? `${assignedObjectCount} ${assignedObjectCount === 1 ? "magnetic object" : "magnetic objects"}${
        limitingMaterial
          ? ` · ${limitingMaterial.name} (l_ex = ${limitingMaterial.lexNm.toFixed(2)} nm)`
          : firstMatId
            ? ` · ${firstMatId}`
            : ""
      }`
    : magneticObjectCount === 0
      ? "Add at least one magnetic object with an assigned material."
      : firstUnassignedObject
        ? `Assign a magnetic material to ${firstUnassignedObject.name}.`
        : "Assign a magnetic material to continue.";

  // Step 2: Cell Size
  const studyRec = asRecord(sceneRec?.study);
  const fdmRec = asRecord(studyRec?.fdm);
  const demagRec = asRecord(fdmRec?.demag);
  const savedCellTuple =
    Array.isArray(fdmRec?.default_cell) && fdmRec.default_cell.length >= 3
      ? (fdmRec.default_cell as unknown[]).map(asNumber)
      : null;
  const hasSavedDefaultCell = Boolean(
    savedCellTuple && savedCellTuple.every((v) => v !== null && v > 0),
  );
  const savedCommonCells = Array.isArray(demagRec?.common_cells)
    ? (demagRec.common_cells as unknown[]).map(asNumber)
    : Array.isArray(demagRec?.common_cells_xy)
      ? [
          asNumber((demagRec.common_cells_xy as unknown[])[0]),
          asNumber((demagRec.common_cells_xy as unknown[])[1]),
          1,
        ]
      : null;
  const hasSavedCommonCells = Boolean(
    savedCommonCells &&
      savedCommonCells.length >= 3 &&
      savedCommonCells.every((v) => v !== null && v > 0),
  );
  const step2Saved = hasSavedDefaultCell || hasSavedCommonCells;
  const step2Ready = step2Saved && !input.cellSizeModified;

  const effectiveCell =
    input.activeCellSizeM ??
    (hasSavedDefaultCell && savedCellTuple
      ? ([
          savedCellTuple[0] ?? 0,
          savedCellTuple[1] ?? 0,
          savedCellTuple[2] ?? 0,
        ] as const)
      : input.domainMeta?.grid?.spacing &&
          input.domainMeta.grid.spacing.every((v) => v > 0)
        ? input.domainMeta.grid.spacing
        : null);
  const effectiveShape =
    input.activeGridShape ??
    (hasSavedCommonCells && savedCommonCells
      ? ([
          savedCommonCells[0] ?? 0,
          savedCommonCells[1] ?? 0,
          savedCommonCells[2] ?? 0,
        ] as const)
      : input.domainMeta?.grid?.shape &&
          input.domainMeta.grid.shape.every((v) => v > 0)
        ? input.domainMeta.grid.shape
        : null);

  const cellText = effectiveCell ? formatCellTupleNm(effectiveCell) : null;
  const shapePreviewText =
    effectiveShape && effectiveShape.every((n) => n > 0)
      ? effectiveShape.join(" × ")
      : null;

  const step2Summary = step2Ready
    ? [cellText, shapePreviewText].filter(Boolean).join(" · ") ||
      "Cell sizing saved"
    : input.cellSizeModified && cellText
      ? `${[cellText, shapePreviewText].filter(Boolean).join(" · ")} (unsaved edit)`
      : input.canAutoSaveCellSize && cellText
        ? `${[cellText, shapePreviewText].filter(Boolean).join(" · ")} (saved on build)`
        : "Set voxel spacing (Δx, Δy, Δz) in Mesh.";

  // Step 3: Study Stage
  const stageSource = readStudyStageSource(studyRec);
  const isCanonicalPipeline = stageSource.kind === "pipeline";
  const stageLabels: string[] = [];
  if (stageSource.kind === "pipeline") {
    for (const entry of stageSource.entries) {
      stageLabels.push(formatStageKindLabel(entry.stageKind ?? "stage"));
    }
  } else if (Array.isArray(studyRec?.stages)) {
    for (const item of studyRec.stages) {
      const stageRec = asRecord(item);
      stageLabels.push(formatStageKindLabel(asString(stageRec?.kind) ?? "stage"));
    }
  }
  const stageCount = stageLabels.length;
  const step3Ready = stageCount > 0;
  const step3Summary = step3Ready
    ? stageCount === 1
      ? `1 stage (${stageLabels[0]})`
      : `${stageCount} stages (${stageLabels.slice(0, 2).join(" → ")}${stageCount > 2 ? " → …" : ""})`
    : "Add a Study stage so the FDM execution plan has an authored source.";

  // Step 4: Build Structured Grid
  const domainGridShape = input.domainMeta?.grid?.shape ?? null;
  const hasDomainGrid = Boolean(
    domainGridShape &&
      Array.isArray(domainGridShape) &&
      domainGridShape.length >= 3 &&
      domainGridShape.every((n) => typeof n === "number" && n > 0),
  );
  const isMaterialized = input.gridMaterialized ?? hasDomainGrid;
  const realizedShape = hasDomainGrid
    ? ([
        domainGridShape![0] ?? 0,
        domainGridShape![1] ?? 0,
        domainGridShape![2] ?? 0,
      ] as const)
    : null;
  const voxelCount = realizedShape
    ? realizedShape[0] * realizedShape[1] * realizedShape[2]
    : 0;
  const realizedShapeText = realizedShape ? realizedShape.join(" × ") : null;

  const step4Ready = isMaterialized && !input.cellSizeModified;
  const step4Summary = isMaterialized
    ? voxelCount > 0
      ? `${voxelCount.toLocaleString("en-US")} voxels (${realizedShapeText})`
      : "Structured grid materialized"
    : shapePreviewText && effectiveShape
      ? `Ready to voxelize ${(effectiveShape[0] * effectiveShape[1] * effectiveShape[2]).toLocaleString("en-US")} estimated voxels (${shapePreviewText})`
      : "Materialize Cartesian voxels and magnetic support mask.";

  const completedCount =
    Number(step1Ready) +
    Number(step2Ready) +
    Number(step3Ready) +
    Number(step4Ready);

  let buildBlockedReason: string | null = null;
  if (!step1Ready) {
    buildBlockedReason =
      "Complete Step 1 (Geometry & material) before building the grid.";
  } else if (!step2Saved && !input.canAutoSaveCellSize) {
    buildBlockedReason =
      "Configure cell size in Step 2 before building the grid.";
  } else if (!step3Ready) {
    buildBlockedReason =
      "Add a Study stage in Step 3 before building the grid.";
  }

  return {
    buildBlockedReason,
    canBuildNow: buildBlockedReason === null,
    completedCount,
    step1Geometry: {
      assignedObjectCount,
      firstUnassignedObject,
      limitingMaterial,
      magneticObjectCount,
      ready: step1Ready,
      summary: step1Summary,
    },
    step2CellSize: {
      ready: step2Ready,
      saved: step2Saved,
      summary: step2Summary,
    },
    step3StudyStage: {
      isCanonicalPipeline,
      ready: step3Ready,
      stageCount,
      summary: step3Summary,
    },
    step4BuildGrid: {
      ready: step4Ready,
      shapeText: realizedShapeText,
      summary: step4Summary,
      voxelCount,
    },
  };
}

export interface FdmMeshWorkflowCardProps {
  sceneData: SceneResource | null | undefined;
  domainMeta: DomainMetaResource | null | undefined;
  gridMaterialized?: boolean;
  activeCellSizeM?: readonly [number, number, number] | null;
  activeGridShape?: readonly [number, number, number] | null;
  cellSizeModified?: boolean;
  canAutoSaveCellSize?: boolean;
  buildError?: string | null;
  buildBusy?: boolean;
  sessionScopeKey?: string | null;
  onSelectNode?: (next: Omit<Selection, "moduleSource">) => void;
  onFocusCellSize?: () => void;
  onBuildGrid: () => void | Promise<void>;
}

export function FdmMeshWorkflowCard({
  activeCellSizeM = null,
  activeGridShape = null,
  buildBusy = false,
  buildError = null,
  canAutoSaveCellSize = false,
  cellSizeModified = false,
  domainMeta,
  gridMaterialized,
  onBuildGrid,
  onFocusCellSize,
  onSelectNode,
  sceneData,
  sessionScopeKey = null,
}: FdmMeshWorkflowCardProps): ReactNode {
  const kernel = useKernel();
  const [addingStage, setAddingStage] = useState(false);
  const [runningBuild, setRunningBuild] = useState(false);
  const [confirmRebuildOpen, setConfirmRebuildOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const workflow = useMemo(
    () =>
      evaluateFdmMeshWorkflow({
        activeCellSizeM,
        activeGridShape,
        canAutoSaveCellSize,
        cellSizeModified,
        domainMeta,
        gridMaterialized,
        sceneData,
      }),
    [
      activeCellSizeM,
      activeGridShape,
      canAutoSaveCellSize,
      cellSizeModified,
      domainMeta,
      gridMaterialized,
      sceneData,
    ],
  );

  const navigateTo = useCallback(
    (next: Omit<Selection, "moduleSource">, focusRowKey?: string) => {
      if (onSelectNode) {
        onSelectNode(next);
      } else {
        kernel.layout?.setPanelVisible?.("right", true);
        kernel.selection?.set?.(next, "inspector");
      }
      if (focusRowKey) {
        const inspectorControl = (
          kernel as unknown as {
            inspector?: { focusRow?: (rowKey: string) => void };
          }
        ).inspector;
        inspectorControl?.focusRow?.(focusRowKey);
      }
    },
    [kernel, onSelectNode],
  );

  const handleAddRelaxStage = useCallback(async () => {
    if (addingStage || typeof kernel?.api?.model?.commitTransaction !== "function") {
      navigateTo({
        kind: "study.stages",
        label: "Stages",
        nodeId: "model:study:stages",
        objectId: null,
        ref: null,
      });
      return;
    }
    setAddingStage(true);
    setLocalError(null);
    try {
      const reqOptions = sessionScopeKey ? { sessionScopeKey } : undefined;
      let currentScene: SceneResource | null = sceneData ?? null;
      let baseRevision =
        asNumber(asRecord(currentScene)?.revision) ??
        asNumber(asRecord(currentScene)?.scene_revision);

      if (
        (!currentScene || baseRevision === null) &&
        typeof kernel.api.model.scene === "function"
      ) {
        const fetched = await kernel.api.model.scene(reqOptions);
        currentScene = fetched;
        baseRevision =
          asNumber(asRecord(fetched)?.revision) ??
          asNumber(asRecord(fetched)?.scene_revision);
      }

      const globalDraft = createStudyGlobalDraft(currentScene);
      const relaxDraft = withDefaultRelaxTimestepPolicy(
        {
          ...createDefaultStudyStageDraft("relax", 0),
          stageEnabled: true,
          stageId: "relax_1",
        },
        {
          backend:
            globalDraft.requestedBackend &&
            globalDraft.requestedBackend !== "auto"
              ? globalDraft.requestedBackend
              : "fdm",
          device: globalDraft.requestedDevice,
          precision: globalDraft.requestedPrecision,
        },
      );

      const tx = buildStudyStagesMergePatch(
        [relaxDraft],
        baseRevision ?? 0,
        currentScene ?? undefined,
      );

      const cmdCtx = createCommandContext("inspector", kernel, {
        sessionScopeKey: sessionScopeKey ?? undefined,
        sourceDetail: "fdm-mesh-workflow.add-relax-stage",
      });

      const response = kernel.authoringHistory
        ? await runAuthoringMutationWithHistory(
            cmdCtx,
            "Add default Relax stage",
            () => kernel.api.model.commitTransaction(tx, reqOptions),
          )
        : await kernel.api.model.commitTransaction(tx, reqOptions);

      const nextRev =
        asNumber(asRecord(response)?.scene_revision) ??
        asNumber(asRecord(asRecord(response)?.committed_scene)?.revision) ??
        `fdm-wf:${Date.now()}`;

      const committedScene = asRecord(response)?.committed_scene as
        | SceneResource
        | undefined;
      if (
        committedScene &&
        geometryLifecycleResources.publishCommittedSceneResource
      ) {
        geometryLifecycleResources.publishCommittedSceneResource(
          kernel.resources,
          committedScene,
          nextRev,
          undefined,
          true,
          sessionScopeKey ?? null,
          kernel.api.resourceCacheScope,
        );
      }

      const statusKey =
        sessionStatusHooks.SESSION_STATUS_RESOURCE_KEY ?? "session:status";
      kernel.resources?.invalidate?.(MODEL_SCENE_PATH, nextRev);
      kernel.resources?.invalidate?.(MODEL_STUDY_PATH, nextRev);
      kernel.resources?.invalidate?.(MODEL_READINESS_PATH, nextRev);
      kernel.resources?.invalidate?.(statusKey, nextRev);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Could not add Relax stage.",
      );
    } finally {
      setAddingStage(false);
    }
  }, [addingStage, kernel, navigateTo, sceneData, sessionScopeKey]);

  const handleBuildClick = useCallback(async () => {
    if (runningBuild || buildBusy) return;
    setRunningBuild(true);
    setLocalError(null);
    try {
      await onBuildGrid();
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : "Failed to build structured grid.",
      );
    } finally {
      setRunningBuild(false);
    }
  }, [buildBusy, onBuildGrid, runningBuild]);

  const isBusy = buildBusy || runningBuild;
  const activeError = buildError || localError;
  const isGridBuilt = workflow.step4BuildGrid.ready || Boolean(
    (gridMaterialized ?? (workflow.step4BuildGrid.voxelCount > 0)) && cellSizeModified,
  );
  const progressPercent = Math.round((workflow.completedCount / 4) * 100);
  const overallStatus =
    workflow.completedCount === 4
      ? "ready"
      : activeError
        ? "failed"
        : "needs-build";

  const step1Next = !workflow.step1Geometry.ready;
  const step2Next =
    workflow.step1Geometry.ready &&
    !workflow.step2CellSize.saved &&
    !canAutoSaveCellSize;
  const step3Next =
    workflow.step1Geometry.ready &&
    (workflow.step2CellSize.saved || canAutoSaveCellSize) &&
    !workflow.step3StudyStage.ready;
  const step4Next =
    workflow.step1Geometry.ready &&
    (workflow.step2CellSize.saved || canAutoSaveCellSize) &&
    workflow.step3StudyStage.ready &&
    !workflow.step4BuildGrid.ready;

  const primaryBuildLabel = isBusy
    ? "Building Structured Grid…"
    : isGridBuilt
      ? cellSizeModified
        ? "Save & Re-voxelize Grid"
        : "Re-voxelize Grid"
      : cellSizeModified || (!workflow.step2CellSize.saved && canAutoSaveCellSize)
        ? "Save & Build Grid"
        : "Build Structured Grid";

  return (
    <section
      aria-label="FDM Grid Build Sequence"
      className="fm-mesh-guide"
      data-fdm-mesh-workflow={overallStatus}
      data-fem-mesh-guide-status={overallStatus}
    >
      <div className="fm-mesh-guide__header">
        <div className="fm-mesh-guide__title-row">
          <Grid3x3
            aria-hidden="true"
            className="fm-mesh-guide__icon"
            size={15}
          />
          <span className="fm-mesh-guide__title">
            Structured grid workflow
          </span>
        </div>
        <Badge
          variant={
            workflow.completedCount === 4
              ? "success"
              : activeError
                ? "danger"
                : "accent"
          }
        >
          {workflow.completedCount}/4 complete
        </Badge>
      </div>

      <div
        aria-label="Grid setup progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progressPercent}
        className="fm-mesh-guide__progress-track"
        role="progressbar"
      >
        <div
          className="fm-mesh-guide__progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <ol className="fm-mesh-guide__quest-list">
        {/* Step 1: Geometry & Material */}
        <li
          className="fm-mesh-guide__quest-item"
          data-quest-recommended={String(step1Next)}
          data-quest-status={
            workflow.step1Geometry.ready
              ? "ready"
              : step1Next
                ? "recommended"
                : "missing"
          }
        >
          <div className="fm-mesh-guide__quest-main">
            <span className="fm-mesh-guide__quest-step">
              {workflow.step1Geometry.ready ? (
                <CheckCircle2 aria-hidden="true" size={14} />
              ) : step1Next ? (
                <ArrowRight aria-hidden="true" size={14} />
              ) : (
                <CircleDot aria-hidden="true" size={14} />
              )}
            </span>
            <div className="fm-mesh-guide__quest-copy">
              <div className="fm-mesh-guide__quest-header">
                <span className="fm-mesh-guide__quest-title">
                  1. Geometry &amp; material
                </span>
                <Badge
                  variant={workflow.step1Geometry.ready ? "success" : "warning"}
                >
                  {workflow.step1Geometry.ready ? "Ready" : "Action needed"}
                </Badge>
              </div>
              <p className="fm-mesh-guide__quest-summary">
                {workflow.step1Geometry.summary}
              </p>
            </div>
          </div>
          {!workflow.step1Geometry.ready ? (
            <div className="fm-mesh-guide__quest-actions">
              <Button
                size="sm"
                type="button"
                variant={step1Next ? "primary" : "secondary"}
                onClick={() => {
                  const unassigned =
                    workflow.step1Geometry.firstUnassignedObject;
                  if (unassigned) {
                    navigateTo({
                      kind: "object.material",
                      label: "Material",
                      nodeId: `model:object:${unassigned.id}:material`,
                      objectId: unassigned.id,
                      ref: null,
                    });
                    return;
                  }
                  navigateTo({
                    kind: "objects.root",
                    label: "Objects",
                    nodeId: "model:objects",
                    objectId: null,
                    ref: null,
                  });
                }}
              >
                <Box aria-hidden="true" size={13} />
                <span>
                  {workflow.step1Geometry.firstUnassignedObject
                    ? "Assign Material"
                    : "Open Objects"}
                </span>
              </Button>
            </div>
          ) : null}
        </li>

        {/* Step 2: Cell Size */}
        <li
          className="fm-mesh-guide__quest-item"
          data-quest-recommended={String(step2Next)}
          data-quest-status={
            workflow.step2CellSize.ready
              ? "ready"
              : step2Next || cellSizeModified
                ? "recommended"
                : "in-progress"
          }
        >
          <div className="fm-mesh-guide__quest-main">
            <span className="fm-mesh-guide__quest-step">
              {workflow.step2CellSize.ready ? (
                <CheckCircle2 aria-hidden="true" size={14} />
              ) : step2Next ? (
                <ArrowRight aria-hidden="true" size={14} />
              ) : (
                <CircleDot aria-hidden="true" size={14} />
              )}
            </span>
            <div className="fm-mesh-guide__quest-copy">
              <div className="fm-mesh-guide__quest-header">
                <span className="fm-mesh-guide__quest-title">
                  2. Cell size (Δx, Δy, Δz)
                </span>
                <Badge
                  variant={
                    workflow.step2CellSize.ready
                      ? "success"
                      : cellSizeModified
                        ? "accent"
                        : canAutoSaveCellSize
                          ? "default"
                          : "warning"
                  }
                >
                  {workflow.step2CellSize.ready
                    ? "Saved"
                    : cellSizeModified
                      ? "Edited"
                      : canAutoSaveCellSize
                        ? "Auto-saves"
                        : "Not set"}
                </Badge>
              </div>
              <p className="fm-mesh-guide__quest-summary">
                {workflow.step2CellSize.summary}
              </p>
            </div>
          </div>
          {!workflow.step2CellSize.ready &&
          (onFocusCellSize || !canAutoSaveCellSize) ? (
            <div className="fm-mesh-guide__quest-actions">
              <Button
                size="sm"
                type="button"
                variant={step2Next ? "primary" : "secondary"}
                onClick={() => {
                  if (onFocusCellSize) {
                    onFocusCellSize();
                    return;
                  }
                  navigateTo(
                    {
                      kind: "mesh.root",
                      label: "Mesh",
                      nodeId: "model:mesh",
                      objectId: null,
                      ref: null,
                    },
                    "cellSizeM",
                  );
                }}
              >
                <ArrowRight aria-hidden="true" size={13} />
                <span>
                  {onFocusCellSize ? "Edit Cell Size" : "Configure Cell Size"}
                </span>
              </Button>
            </div>
          ) : null}
        </li>

        {/* Step 3: Study Stage */}
        <li
          className="fm-mesh-guide__quest-item"
          data-quest-recommended={String(step3Next)}
          data-quest-status={
            workflow.step3StudyStage.ready
              ? "ready"
              : step3Next
                ? "recommended"
                : "missing"
          }
        >
          <div className="fm-mesh-guide__quest-main">
            <span className="fm-mesh-guide__quest-step">
              {workflow.step3StudyStage.ready ? (
                <CheckCircle2 aria-hidden="true" size={14} />
              ) : step3Next ? (
                <ArrowRight aria-hidden="true" size={14} />
              ) : (
                <CircleDot aria-hidden="true" size={14} />
              )}
            </span>
            <div className="fm-mesh-guide__quest-copy">
              <div className="fm-mesh-guide__quest-header">
                <span className="fm-mesh-guide__quest-title">
                  3. Study stage
                </span>
                <Badge
                  variant={
                    workflow.step3StudyStage.ready ? "success" : "warning"
                  }
                >
                  {workflow.step3StudyStage.ready ? "Ready" : "Required"}
                </Badge>
              </div>
              <p className="fm-mesh-guide__quest-summary">
                {workflow.step3StudyStage.summary}
              </p>
            </div>
          </div>
          {!workflow.step3StudyStage.ready ? (
            <div className="fm-mesh-guide__quest-actions flex flex-wrap gap-1.5">
              {!workflow.step3StudyStage.isCanonicalPipeline ? (
                <Button
                  disabled={addingStage}
                  size="sm"
                  type="button"
                  variant={step3Next ? "primary" : "secondary"}
                  onClick={() => void handleAddRelaxStage()}
                >
                  <Layers aria-hidden="true" size={13} />
                  <span>{addingStage ? "Adding…" : "Add Relax Stage"}</span>
                </Button>
              ) : null}
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  navigateTo({
                    kind: "study.stages",
                    label: "Stages",
                    nodeId: "model:study:stages",
                    objectId: null,
                    ref: null,
                  })
                }
              >
                <span>Open Stages</span>
              </Button>
            </div>
          ) : null}
        </li>

        {/* Step 4: Build Structured Grid */}
        <li
          className="fm-mesh-guide__quest-item"
          data-quest-recommended={String(step4Next)}
          data-quest-status={
            workflow.step4BuildGrid.ready
              ? "ready"
              : step4Next
                ? "recommended"
                : "in-progress"
          }
        >
          <div className="fm-mesh-guide__quest-main">
            <span className="fm-mesh-guide__quest-step">
              {workflow.step4BuildGrid.ready ? (
                <CheckCircle2 aria-hidden="true" size={14} />
              ) : step4Next ? (
                <ArrowRight aria-hidden="true" size={14} />
              ) : (
                <CircleDot aria-hidden="true" size={14} />
              )}
            </span>
            <div className="fm-mesh-guide__quest-copy">
              <div className="fm-mesh-guide__quest-header">
                <span className="fm-mesh-guide__quest-title">
                  4. Build structured grid
                </span>
                <Badge
                  variant={
                    workflow.step4BuildGrid.ready
                      ? "success"
                      : isGridBuilt && cellSizeModified
                        ? "warning"
                        : step4Next
                          ? "accent"
                          : "default"
                  }
                >
                  {workflow.step4BuildGrid.ready
                    ? "Materialized"
                    : isGridBuilt && cellSizeModified
                      ? "Stale"
                      : step4Next
                        ? "Next"
                        : "Pending"}
                </Badge>
              </div>
              <p className="fm-mesh-guide__quest-summary">
                {workflow.step4BuildGrid.summary}
              </p>
            </div>
          </div>
        </li>
      </ol>

      {activeError ? (
        <div
          className="fm-inspector-notice"
          data-slot="inspector-notice"
          data-tone="err"
          role="alert"
        >
          <AlertTriangle
            aria-hidden="true"
            className="fm-inspector-notice__icon"
            size={15}
          />
          <div className="fm-inspector-notice__body">
            <div className="fm-inspector-notice__title">
              Structured grid build failed
            </div>
            <div className="fm-inspector-notice__text">{activeError}</div>
          </div>
        </div>
      ) : null}

      {!isGridBuilt && workflow.buildBlockedReason ? (
        <p className="fm-mesh-guide__detail">{workflow.buildBlockedReason}</p>
      ) : null}

      <Button
        className="w-full justify-center"
        disabled={isBusy || (!isGridBuilt && !workflow.canBuildNow)}
        size="sm"
        type="button"
        variant={isGridBuilt && !cellSizeModified ? "secondary" : "primary"}
        onClick={() => {
          if (isGridBuilt) {
            setConfirmRebuildOpen(true);
            return;
          }
          void handleBuildClick();
        }}
      >
        <Grid3x3 aria-hidden="true" size={14} />
        <span>{primaryBuildLabel}</span>
      </Button>
      <MeshRebuildConfirmDialog
        actionLabel={primaryBuildLabel}
        busy={isBusy}
        lane="fdm"
        open={confirmRebuildOpen}
        summary={
          workflow.step4BuildGrid.shapeText && workflow.step4BuildGrid.voxelCount > 0
            ? `${workflow.step4BuildGrid.shapeText} · ${workflow.step4BuildGrid.voxelCount.toLocaleString("en-US")} cells`
            : workflow.step4BuildGrid.shapeText
        }
        onConfirm={handleBuildClick}
        onOpenChange={setConfirmRebuildOpen}
      />
    </section>
  );
}

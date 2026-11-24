"use client";

import {
  Compass,
  Eye,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  JsonObject,
  MagnetizationApplyReceipt,
  MagnetizationApplyTarget,
} from "@/kernel/api/apiTypes";
import type { components } from "@/kernel/api/generated/openapi-v2-types";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  SCENE_RESOURCE_KEY,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  sessionRequestScopeKey,
  sessionResourceIdentityKey,
} from "@/kernel/resources/sessionResourceIdentity";
import {
  resolveActiveLaneOperation,
  useActiveLaneCapabilities,
  type ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import type { RegionVisualizationTargetId } from "@/kernel/selection/selectionTypes";
import { returnToCurrentFieldView } from "@/kernel/visualization/savedFieldPresentation";
import { observationSourceWorkspaceStore } from "@/kernel/workspace/observationSourceWorkspace";
import type { InspectorPanelProps } from "@/modules/inspector/inspectorTypes";
import {
  commitMagneticTextureApply,
  magneticTextureApplyMessage,
  syncAuthoringScriptBestEffort,
} from "@/modules/inspector/panels/ObjectMagneticTexturePanelViewModel";
import {
  InspectorTemplate,
  inspectorValuesEqual,
  useInspectorSpecController,
  type InspectorActionContext,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "@/modules/inspector/template";
import {
  magnetizationTextureAssetId,
  presetMagnetizationAsset,
} from "@/shared/domain/magnetization-texture/assetFactory";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import { resolveMagnetizationTextureModel } from "@/shared/domain/magnetization-texture/draftModel";
import type { PresetTextureSpecV2 } from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  buildPresetSpecFromDraft,
  fitCharacteristicSizeToTarget,
  formatMagneticTexturePythonExpression,
  hydrateMagneticTextureDraftFromInitializer,
  resetDraftTransform,
  serializeMagneticTextureDraftToInitializer,
  type MagneticTextureDraft,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  extractMagnetizationTargetInputFromSelection,
  isExplicitRegionSelectionKind,
  parseRegionVisualizationTarget,
  resolveMagnetizationTextureTarget,
} from "@/shared/domain/magnetization-texture/targetResolver";
import {
  formatTextureTargetKey,
  getTextureInspectorUiSnapshot,
  registerTextureInspectorBinding,
  subscribeTextureDraftBridge,
  toggleTextureGizmo,
  unregisterTextureInspectorBinding,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";
import {
  canonicalPresetKind,
  humanPresetLabel,
  type MagnetizationTexturePresetId,
} from "@/shared/domain/magnetization-texture/texturePresets";
import type { MagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/types";

import {
  applyCoupledDraftFieldChange,
  buildMagneticTextureInspectorSections,
  formatCharacteristicSizeSummary,
  type FieldImportInspectionSummary,
} from "./MagneticTextureCoreSections";

type UnknownRecord = Record<string, unknown>;
type SceneInitialMagnetization = components["schemas"]["SceneInitialMagnetization"];
type SceneTextureMapping = components["schemas"]["SceneTextureMapping"];
type SceneTextureTransform3D = components["schemas"]["SceneTextureTransform3D"];

function buildSceneTextureMapping(
  mapping: PresetTextureSpecV2["mapping"],
): SceneTextureMapping | undefined {
  if (!mapping) return undefined;
  return {
    ...(mapping.space ? { space: mapping.space } : {}),
    ...(mapping.projection ? { projection: mapping.projection } : {}),
    ...(mapping.clamp_mode ? { clamp_mode: mapping.clamp_mode } : {}),
    ...(mapping.tile_period ? { tile_period: [...mapping.tile_period] } : {}),
    ...(mapping.background_vector
      ? { background_vector: [...mapping.background_vector] }
      : {}),
    ...(mapping.axis_extent_mode
      ? { axis_extent_mode: mapping.axis_extent_mode }
      : {}),
    ...(typeof mapping.axis_thickness_m === "number"
      ? { axis_thickness_m: mapping.axis_thickness_m }
      : {}),
  };
}

function buildSceneTextureTransform(
  transform: PresetTextureSpecV2["texture_transform"],
): SceneTextureTransform3D | undefined {
  if (!transform) return undefined;
  return {
    ...(transform.translation ? { translation: [...transform.translation] } : {}),
    ...(transform.rotation_quat ? { rotation_quat: [...transform.rotation_quat] } : {}),
    ...(transform.scale ? { scale: [...transform.scale] } : {}),
    ...(transform.pivot ? { pivot: [...transform.pivot] } : {}),
    ...(typeof transform.rotate_vectors === "boolean"
      ? { rotate_vectors: transform.rotate_vectors }
      : {}),
  };
}

function asRecord(value: unknown): UnknownRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function normalizeMagnetizationRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== "unassigned" ? trimmed : null;
}

function parseRegionIdFromNodeId(nodeId: string | null | undefined): string | undefined {
  if (!nodeId) return undefined;
  const match = /:region:([^:]+)/.exec(nodeId);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveSavedObjectMagnetizationAssetId(options: {
  target: Extract<MagnetizationTextureTarget, { kind: "object" }>;
  sourceMode: MagneticTextureDraft["sourceMode"];
  presetKind: MagnetizationTexturePresetId;
  draftMagnetizationRef: unknown;
  committedAsset: UnknownRecord | null;
  committedObjectRef: string | null;
}): string {
  const {
    target,
    sourceMode,
    presetKind,
    draftMagnetizationRef,
    committedAsset,
    committedObjectRef,
  } = options;
  const defaultNextId =
    sourceMode === "field-file"
      ? `mag:${target.objectId}:sampled`
      : magnetizationTextureAssetId(target, presetKind);
  const draftRef = normalizeMagnetizationRef(draftMagnetizationRef);
  if (!draftRef) {
    return defaultNextId;
  }

  const committedRef = normalizeMagnetizationRef(committedAsset?.id ?? committedObjectRef);
  const committedKind = typeof committedAsset?.kind === "string" ? committedAsset.kind : null;
  const committedPreset =
    typeof committedAsset?.preset_kind === "string"
      ? canonicalPresetKind(committedAsset.preset_kind)
      : null;
  const committedAutoId =
    committedKind === "sampled" ||
    committedKind === "file" ||
    committedKind === "sampled_field"
      ? `mag:${target.objectId}:sampled`
      : committedPreset
        ? magnetizationTextureAssetId(target, committedPreset)
        : null;

  if (committedRef && draftRef === committedRef && committedAutoId && committedRef === committedAutoId) {
    return defaultNextId;
  }
  return draftRef;
}

export function resolveMagneticTextureCapabilityGate(
  activeLane: ActiveLaneCapabilitySnapshot | null,
  draft: MagneticTextureDraft,
): { enabled: boolean; reason: string | null } | null {
  if (!activeLane?.operations) return null;
  if (draft.inheritanceMode === "inherit") return null;

  const ops = activeLane.operations;

  let opKey: string;
  if (draft.sourceMode === "field-file") {
    opKey = "initial_magnetization.sampled_field";
  } else {
    const kind = canonicalPresetKind(draft.presetKind);
    if (kind === "uniform") {
      opKey = "initial_magnetization.uniform";
    } else if (kind === "vortex") {
      opKey = "initial_magnetization.vortex";
    } else {
      opKey = ops["initial_magnetization.preset_v2"]
        ? "initial_magnetization.preset_v2"
        : "initial_magnetization.vortex";
    }
  }

  const entry = ops[opKey];
  if (!entry) return null;
  if (
    draft.sourceMode === "preset" &&
    activeLane.source?.kind === "planner" &&
    activeLane.authored?.discretization === "fdm" &&
    !activeLane.resolved &&
    entry.state === "stale" &&
    entry.reason_code === "capability_stale" &&
    entry.requires?.includes("resolved_lane_identity")
  ) {
    // An analytical Apply edits the authored scene. The scoped backend mutation
    // validates the preset and plans it on the published domain.
    return { enabled: true, reason: null };
  }
  if (opKey === "initial_magnetization.uniform" || opKey === "initial_magnetization.vortex") {
    const res = resolveActiveLaneOperation(activeLane, opKey);
    return { enabled: res.enabled, reason: res.reason ?? null };
  }
  return {
    enabled: entry.state === "supported",
    reason: entry.reason ?? null,
  };
}

export function MagneticTextureInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, authoringHistory, commands, resources } = kernel;
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const sessionStatusData = useSessionStatusSelector((status) => status.data);
  const activeLane = useActiveLaneCapabilities();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();

  const bridgeSnapshot = useSyncExternalStore(
    subscribeTextureDraftBridge,
    getTextureInspectorUiSnapshot,
    getTextureInspectorUiSnapshot,
  );

  const hostContext: "object" | "region" = isExplicitRegionSelectionKind(selection.kind)
    ? "region"
    : "object";

  const isLoadSelection =
    selection.kind === "object.magnetic-texture.load" ||
    (selection.ref?.type === "scene-object" &&
      selection.ref.kind === "object.magnetic-texture.load") ||
    Boolean(selection.nodeId?.endsWith(":magnetic-texture:load"));

  const target = useMemo<MagnetizationTextureTarget>(() => {
    const input = extractMagnetizationTargetInputFromSelection(selection);
    const resolved = resolveMagnetizationTextureTarget(input, scene.data);
    if (resolved) return resolved;

    const fallbackObjId =
      (typeof input.objectId === "string" && input.objectId.trim()) ||
      selection.objectId ||
      "object";
    const parsedMeshRegion =
      selection.ref?.type === "mesh-part"
        ? parseRegionVisualizationTarget(selection.ref.visualizationTargetId)?.regionId
        : undefined;
    const fallbackRegId =
      (typeof input.regionId === "string" && input.regionId.trim()) ||
      parsedMeshRegion ||
      parseRegionIdFromNodeId(selection.nodeId);

    if (hostContext === "region") {
      return {
        kind: "region",
        objectId: fallbackObjId,
        regionId: fallbackRegId || "region",
      };
    }
    return { kind: "object", objectId: fallbackObjId };
  }, [hostContext, scene.data, selection]);

  const objectTarget = useMemo<MagnetizationTextureTarget>(
    () => ({ kind: "object", objectId: target.objectId }),
    [target.objectId],
  );

  const objectBounds = useMemo(
    () => resolveTargetBoundsMeters(scene.data, objectTarget),
    [objectTarget, scene.data],
  );
  const bounds = useMemo(
    () => resolveTargetBoundsMeters(scene.data, target),
    [scene.data, target],
  );

  const sceneRec = asRecord(scene.data);
  const objectRec = useMemo(() => {
    const objs = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
    return objs.map(asRecord).find((o) => o && o.id === target.objectId) ?? null;
  }, [sceneRec, target.objectId]);

  const regionRec = useMemo(() => {
    if (target.kind !== "region" || !objectRec || !Array.isArray(objectRec.regions)) {
      return null;
    }
    return (
      objectRec.regions.map(asRecord).find((r) => r && r.region_id === target.regionId) ?? null
    );
  }, [objectRec, target]);

  const domainModel = useMemo(
    () =>
      resolveMagnetizationTextureModel({
        regionList: regions.data ?? null,
        scene: scene.data ?? null,
        target,
      }),
    [regions.data, scene.data, target],
  );

  const parentDomainModel = useMemo(
    () =>
      resolveMagnetizationTextureModel({
        regionList: regions.data ?? null,
        scene: scene.data ?? null,
        target: objectTarget,
      }),
    [objectTarget, regions.data, scene.data],
  );

  const parentDraft = useMemo(
    () =>
      hydrateMagneticTextureDraftFromInitializer(
        parentDomainModel.asset,
        objectBounds,
        "object",
      ),
    [objectBounds, parentDomainModel.asset],
  );

  const parentPreviewSpec = useMemo(() => {
    try {
      return buildPresetSpecFromDraft(parentDraft, objectBounds);
    } catch {
      return null;
    }
  }, [objectBounds, parentDraft]);

  const committedMagnetizationRef = useMemo(
    () =>
      target.kind === "object"
        ? (normalizeMagnetizationRef(domainModel.asset?.id ?? domainModel.objectMagnetizationRef) ??
          "")
        : "",
    [domainModel.asset?.id, domainModel.objectMagnetizationRef, target.kind],
  );

  const baselineDraft = useMemo<MagneticTextureDraft>(() => {
    if (target.kind === "region") {
      const overrideInit = regionRec
        ? asRecord(regionRec.texture_override)?.initial_magnetization
        : null;
      const hydrated = overrideInit
        ? hydrateMagneticTextureDraftFromInitializer(overrideInit, bounds, "region", {
            inherited: false,
          })
        : hydrateMagneticTextureDraftFromInitializer(parentDomainModel.asset, bounds, "region", {
            inherited: true,
          });
      return {
        ...hydrated,
        magnetizationRef: "",
      };
    }
    const hydrated = hydrateMagneticTextureDraftFromInitializer(
      domainModel.asset,
      bounds,
      "object",
    );
    return {
      ...hydrated,
      magnetizationRef: committedMagnetizationRef,
    };
  }, [
    bounds,
    committedMagnetizationRef,
    domainModel.asset,
    parentDomainModel.asset,
    regionRec,
    target.kind,
  ]);

  const supportedFieldFormats = useMemo<readonly string[]>(() => {
    const statusRec = asRecord(sessionStatusData);
    const capsRec = asRecord(statusRec?.capabilities);
    const rawList = capsRec?.field_state_import_formats;
    if (Array.isArray(rawList)) {
      const cleaned = rawList.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      if (cleaned.length > 0) return cleaned;
    }
    return ["field_state_json"];
  }, [sessionStatusData]);

  const [inspectionSummary, setInspectionSummary] = useState<FieldImportInspectionSummary | null>(
    null,
  );
  const [inspectingFieldFile, setInspectingFieldFile] = useState(false);
  const [clearingObjectTexture, setClearingObjectTexture] = useState(false);
  const [clearedResetToken, setClearedResetToken] = useState(0);
  const [loadingFieldState, setLoadingFieldState] = useState(false);
  const [loadFieldFeedback, setLoadFieldFeedback] = useState<{
    tone: "info" | "err";
    message: string;
  } | null>(null);
  const [appliedBannerMessage, setAppliedBannerMessage] = useState<string | null>(null);

  const previewAbortRef = useRef<AbortController | null>(null);
  const [lastApplyPreview, setLastApplyPreview] = useState<{
    receipt: MagnetizationApplyReceipt;
    sessionScopeKey: string;
  } | null>(null);
  const [lastApplyReceipt, setLastApplyReceipt] = useState<{
    receipt: MagnetizationApplyReceipt;
    sessionScopeKey: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useLayoutEffect(() => () => previewAbortRef.current?.abort(), []);

  const targetKey = formatTextureTargetKey(target);
  const prevTargetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (prevTargetKeyRef.current === targetKey) return;
    prevTargetKeyRef.current = targetKey;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewLoading(false);
    setPreviewError(null);
    setLastApplyPreview(null);
    setLastApplyReceipt(null);
    setLoadFieldFeedback(null);
    setAppliedBannerMessage(null);
    setInspectionSummary(null);
  }, [targetKey]);

  const handleInspectFieldFile = useCallback(
    async (draft: MagneticTextureDraft) => {
      const artifactRef =
        draft.fieldOrigin === "artifact"
          ? draft.fieldArtifactRef.trim()
          : draft.fieldSourcePath.trim();
      if (!artifactRef || !api?.persistence?.fieldStates?.inspectImport) return;
      setInspectingFieldFile(true);
      try {
        const inspectTarget =
          target.kind === "region"
            ? { kind: "region", id: target.regionId }
            : { kind: "object", id: target.objectId };
        const res = asRecord(
          await api.persistence.fieldStates.inspectImport(
            {
              artifact_ref: artifactRef,
              quantity_id: "m",
              target: inspectTarget,
              ...(draft.fieldSourceFormat !== "auto" ? { format: draft.fieldSourceFormat } : {}),
            },
            sessionScopeKey ? { sessionScopeKey } : undefined,
          ),
        );
        if (res) {
          const shape =
            Array.isArray(res.source_grid_shape) && res.source_grid_shape.length >= 3
              ? ([
                  Number(res.source_grid_shape[0]) || 1,
                  Number(res.source_grid_shape[1]) || 1,
                  Number(res.source_grid_shape[2]) || 1,
                ] as const)
              : null;
          const datasets = Array.isArray(res.datasets)
            ? res.datasets.filter((d): d is string => typeof d === "string")
            : ["fields/m"];
          const compatible =
            typeof res.compatible === "boolean"
              ? res.compatible
              : res.compatibility !== "incompatible";
          setInspectionSummary({
            vectorCount: Number(res.vector_count ?? res.point_count) || 0,
            frameCount: Number(res.frame_count) || 1,
            sourceGridShape: shape,
            minNorm: typeof res.min_norm === "number" ? res.min_norm : 1,
            maxNorm: typeof res.max_norm === "number" ? res.max_norm : 1,
            compatible,
            datasets,
          });
        }
      } finally {
        setInspectingFieldFile(false);
      }
    },
    [api, sessionScopeKey, target],
  );

  const handleLoadFieldState = useCallback(async () => {
    if (loadingFieldState) return;
    if (!objectRec) {
      setLoadFieldFeedback({
        tone: "err",
        message: "Select a committed magnetic object in the scene.",
      });
      return;
    }
    setLoadingFieldState(true);
    setLoadFieldFeedback(null);
    try {
      const ctx = createCommandContext("inspector", kernel, {
        resourceData: { [SCENE_RESOURCE_KEY]: scene.data },
        sessionScopeKey: sessionScopeKey ?? undefined,
        sourceDetail: "object-magnetic-texture-load",
      });
      const result = await commands.execute("study.load-field-state", ctx);
      if (ctx.isCurrentSessionScope?.() === false) return;
      setLoadFieldFeedback({
        tone: result.status === "completed" ? "info" : "err",
        message: result.message ?? "Magnetic texture load finished.",
      });
    } catch (error) {
      setLoadFieldFeedback({
        tone: "err",
        message: errorMessage(error),
      });
    } finally {
      setLoadingFieldState(false);
    }
  }, [commands, kernel, loadingFieldState, objectRec, scene.data, sessionScopeKey]);

  const handleShowPreparedMagnetization = useCallback(async () => {
    if (previewAbortRef.current || !lastApplyPreview || !sessionIdentity) return;
    const { receipt, sessionScopeKey: previewScopeKey } = lastApplyPreview;
    const source = receipt.prepared_initial_state;
    const scope = receipt.scopes[0];
    if (
      sessionRequestScopeKey(sessionIdentity) !== previewScopeKey ||
      !source ||
      source.scene_revision !== receipt.scene_revision ||
      receipt.status !== "initial_state_ready" ||
      !scope
    ) {
      return;
    }
    const sessionIdentityKey = sessionResourceIdentityKey(sessionIdentity);
    const abort = new AbortController();
    const displayedObservation = observationSourceWorkspaceStore.getSnapshot();
    const displayedResult = kernel.savedResultsPlayback?.getSnapshot();
    const selectedTarget = kernel.selection.get();
    previewAbortRef.current = abort;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      await kernel.api.data.fields.preparedMagnetization(
        source,
        { max_samples: 1 },
        { sessionScopeKey: previewScopeKey, signal: abort.signal },
      );
      if (
        abort.signal.aborted ||
        kernel.commands.getSessionScopeKey() !== previewScopeKey ||
        observationSourceWorkspaceStore.getSnapshot() !== displayedObservation ||
        kernel.savedResultsPlayback?.getSnapshot() !== displayedResult ||
        kernel.selection.get() !== selectedTarget
      ) {
        return;
      }
      if (kernel.visualization) {
        if (selectedTarget) {
          if (!returnToCurrentFieldView(kernel.visualization, kernel.selection, "inspector")) {
            throw new Error(
              "Apply or discard the current Inspector draft before opening the preview.",
            );
          }
        } else {
          kernel.visualization.clearSavedFieldPresentation();
        }
        kernel.visualization.setArtifactFieldSelection(null);
      }
      kernel.analysisFieldOverlay?.clear();
      observationSourceWorkspaceStore.showPrepared({
        source,
        sessionIdentityKey,
        objectId: scope.object_id,
        regionId: scope.region_id ?? null,
      });
      kernel.savedResultsPlayback?.close();
      kernel.layout?.setActiveViewportMainModule("viewport-3d");
    } catch (failure) {
      if (!abort.signal.aborted) {
        setPreviewError(errorMessage(failure));
      }
    } finally {
      if (previewAbortRef.current === abort) {
        previewAbortRef.current = null;
      }
      setPreviewLoading(previewAbortRef.current !== null);
    }
  }, [kernel, lastApplyPreview, sessionIdentity]);

  const objectName =
    (typeof objectRec?.name === "string" && objectRec.name.trim()) || target.objectId;
  const regionName =
    target.kind === "region"
      ? (typeof regionRec?.name === "string" && regionRec.name.trim()) || target.regionId
      : "";
  const regionPriority =
    target.kind === "region" && typeof regionRec?.priority === "number"
      ? regionRec.priority
      : 0;
  const parentPresetLabel = parentDomainModel.asset
    ? humanPresetLabel(parentDomainModel.asset.preset_kind, parentDomainModel.asset.kind)
    : "Uniform (+X)";

  const executeApplyTargetMutation = useCallback(
    async (applyTarget: MagnetizationApplyTarget): Promise<boolean> => {
      if (!api || !sessionScopeKey || domainModel.baseRevision === null) {
        throw new Error("The saved scene and session are required to apply magnetization.");
      }

      const historyGeneration = authoringHistory?.getGeneration?.();
      const historyContext = {
        api,
        authoringHistory,
        resourceData: { [SCENE_RESOURCE_KEY]: scene.data },
        sessionScopeKey,
        isCurrentSessionScope: () =>
          commands.getSessionScopeKey() === sessionScopeKey &&
          (historyGeneration === undefined ||
            authoringHistory?.getGeneration?.() === historyGeneration),
      };

      const response = await commitMagneticTextureApply(
        api,
        historyContext,
        applyTarget,
        domainModel.baseRevision,
      );
      if (!historyContext.isCurrentSessionScope()) return false;

      const revision = acknowledgedAuthoringSceneRevision(response);
      publishCommittedSceneResource(
        resources,
        response.committed_scene,
        revision,
        undefined,
        false,
        sessionScopeKey,
        api.resourceCacheScope,
      );
      invalidateAuthoringMutationDependents(resources, "magnetization", revision);
      const syncWarning = await syncAuthoringScriptBestEffort(api, sessionScopeKey);
      if (!historyContext.isCurrentSessionScope()) return false;

      const receipt = response.magnetization_apply;
      const preparedSource =
        receipt.status === "initial_state_ready" &&
        receipt.prepared_initial_state &&
        receipt.prepared_initial_state.scene_revision === receipt.scene_revision
          ? receipt.prepared_initial_state
          : null;
      setPreviewError(null);
      setLastApplyReceipt({ receipt, sessionScopeKey });
      setLastApplyPreview(
        preparedSource ? { receipt, sessionScopeKey } : null,
      );
      if (
        preparedSource &&
        sessionIdentity &&
        receipt.scopes[0] &&
        !kernel.savedResultsPlayback?.getSnapshot()
      ) {
        kernel.visualization?.setArtifactFieldSelection(null);
        kernel.analysisFieldOverlay?.clear();
        observationSourceWorkspaceStore.showPrepared({
          source: preparedSource,
          sessionIdentityKey: sessionResourceIdentityKey(sessionIdentity),
          objectId: receipt.scopes[0].object_id,
          regionId: receipt.scopes[0].region_id ?? null,
        });
      }
      setAppliedBannerMessage(
        magneticTextureApplyMessage(receipt, syncWarning),
      );
      return true;
    },
    [
      api,
      authoringHistory,
      commands,
      domainModel.baseRevision,
      kernel,
      resources,
      scene.data,
      sessionIdentity,
      sessionScopeKey,
    ],
  );

  const handleCommitApply = useCallback(
    async (draftToSave: MagneticTextureDraft): Promise<boolean> => {
      if (target.kind === "region" && !domainModel.authoredRegion) {
        throw new Error("Select an authored magnetic region to apply its texture.");
      }

      const unchanged = inspectorValuesEqual(draftToSave, baselineDraft);
      let applyTarget: MagnetizationApplyTarget;

      if (target.kind === "region") {
        if (draftToSave.inheritanceMode === "inherit") {
          applyTarget = {
            kind: "region",
            object_id: target.objectId,
            region_id: target.regionId,
            texture_override: null,
          };
        } else if (
          unchanged &&
          (domainModel.regionTextureOverride || domainModel.assignment === "object-inherited")
        ) {
          applyTarget = {
            kind: "region",
            object_id: target.objectId,
            region_id: target.regionId,
            texture_override: domainModel.regionTextureOverride ?? null,
          };
        } else {
          const presetSpec = buildPresetSpecFromDraft(draftToSave, bounds);
          const sceneMapping = buildSceneTextureMapping(presetSpec.mapping);
          const sceneTransform = buildSceneTextureTransform(presetSpec.texture_transform);
          const initialMagnetization: SceneInitialMagnetization = {
            kind: "preset_texture",
            preset_kind: presetSpec.preset_kind,
            preset_version: presetSpec.preset_version,
            preset_params: presetSpec.preset_params,
            ...(sceneMapping ? { mapping: sceneMapping } : {}),
            ...(sceneTransform ? { texture_transform: sceneTransform } : {}),
          };
          applyTarget = {
            kind: "region",
            object_id: target.objectId,
            region_id: target.regionId,
            texture_override: {
              initial_magnetization: initialMagnetization,
            },
          };
        }
      } else if (unchanged && domainModel.asset) {
        applyTarget = {
          kind: "object",
          object_id: target.objectId,
          asset: domainModel.asset as unknown as JsonObject,
        };
      } else if (draftToSave.sourceMode === "field-file") {
        const initializer = serializeMagneticTextureDraftToInitializer(draftToSave, bounds);
        const assetId = resolveSavedObjectMagnetizationAssetId({
          target,
          sourceMode: "field-file",
          presetKind: canonicalPresetKind(draftToSave.presetKind),
          draftMagnetizationRef: draftToSave.magnetizationRef,
          committedAsset: asRecord(domainModel.asset),
          committedObjectRef: domainModel.objectMagnetizationRef,
        });
        applyTarget = {
          kind: "object",
          object_id: target.objectId,
          asset: {
            ...initializer,
            id: assetId,
            name: draftToSave.customUiLabel.trim() || "Imported field",
          },
        };
      } else {
        const presetKind = canonicalPresetKind(draftToSave.presetKind);
        const assetId = resolveSavedObjectMagnetizationAssetId({
          target,
          sourceMode: "preset",
          presetKind,
          draftMagnetizationRef: draftToSave.magnetizationRef,
          committedAsset: asRecord(domainModel.asset),
          committedObjectRef: domainModel.objectMagnetizationRef,
        });
        const presetSpec = buildPresetSpecFromDraft(draftToSave, bounds);
        const assetMapping = buildSceneTextureMapping(presetSpec.mapping);
        const assetTransform = buildSceneTextureTransform(presetSpec.texture_transform);
        applyTarget = {
          kind: "object",
          object_id: target.objectId,
          asset: presetMagnetizationAsset({
            id: assetId,
            label: draftToSave.customUiLabel.trim() || null,
            presetKind,
            presetVersion: presetSpec.preset_version,
            presetParams: (presetSpec.preset_params ?? {}) as JsonObject,
            mapping: assetMapping ? ({ ...assetMapping } as JsonObject) : null,
            textureTransform: assetTransform ? ({ ...assetTransform } as JsonObject) : null,
          }),
        };
      }

      return executeApplyTargetMutation(applyTarget);
    },
    [
      baselineDraft,
      bounds,
      domainModel.asset,
      domainModel.assignment,
      domainModel.authoredRegion,
      domainModel.objectMagnetizationRef,
      domainModel.regionTextureOverride,
      executeApplyTargetMutation,
      target,
    ],
  );

  const controllerActionsRef = useRef<{
    draft: MagneticTextureDraft;
    bounds: typeof bounds;
    patchDraft: (partial: Partial<MagneticTextureDraft>) => void;
    revertAll: () => void;
  }>({
    draft: baselineDraft,
    bounds,
    patchDraft: () => undefined,
    revertAll: () => undefined,
  });

  const handleClearObjectTexture = useCallback(async () => {
    if (target.kind !== "object" || clearingObjectTexture || !objectRec) return;
    setClearingObjectTexture(true);
    try {
      const ok = await executeApplyTargetMutation({
        kind: "object",
        object_id: target.objectId,
        asset: null,
      });
      if (ok) {
        setClearedResetToken((token) => token + 1);
      }
    } catch (error) {
      setLoadFieldFeedback({
        tone: "err",
        message: errorMessage(error),
      });
    } finally {
      setClearingObjectTexture(false);
    }
  }, [clearingObjectTexture, executeApplyTargetMutation, objectRec, target]);

  const defaultMagnetizationRefPlaceholder = useMemo(
    () =>
      target.kind === "object"
        ? baselineDraft.sourceMode === "field-file"
          ? `mag:${target.objectId}:sampled`
          : magnetizationTextureAssetId(target, canonicalPresetKind(baselineDraft.presetKind))
        : undefined,
    [baselineDraft.presetKind, baselineDraft.sourceMode, target],
  );

  const objectActionDisabledReason = !objectRec
    ? "Select a committed magnetic object in the scene."
    : !sessionScopeKey || domainModel.baseRevision === null
      ? "The saved scene and session are required to apply magnetization."
      : null;

  const sections = useMemo(
    () =>
      buildMagneticTextureInspectorSections({
        hostContext,
        bounds,
        objectBounds,
        parentObjectName: objectName,
        parentPresetLabel,
        parentPreviewSpec,
        regionRecord: regionRec,
        supportedFieldFormats,
        inspectionSummary,
        inspectingFieldFile,
        onInspectFieldFile: handleInspectFieldFile,
        onCopyParentTextureToRegion: (ctx) => {
          ctx.patchDraft({
            ...parentDraft,
            inheritanceMode: "override",
            mappingSpace: "region",
            translationM: [0, 0, 0],
            scale: [1, 1, 1],
          });
        },
        showObjectAssignmentSection: hostContext === "object",
        defaultMagnetizationRefPlaceholder,
        gizmoEnabled: bridgeSnapshot.gizmoEnabled,
        onToggleGizmo: toggleTextureGizmo,
        canLoadFieldState: hostContext === "object" && Boolean(objectRec),
        loadFieldStateDisabledReason: !objectRec
          ? "Select a committed magnetic object in the scene."
          : null,
        loadingFieldState,
        onLoadFieldState: hostContext === "object" ? handleLoadFieldState : undefined,
      }),
    [
      bounds,
      bridgeSnapshot.gizmoEnabled,
      defaultMagnetizationRefPlaceholder,
      handleInspectFieldFile,
      handleLoadFieldState,
      hostContext,
      inspectingFieldFile,
      inspectionSummary,
      loadingFieldState,
      objectBounds,
      objectName,
      objectRec,
      parentDraft,
      parentPresetLabel,
      parentPreviewSpec,
      regionRec,
      supportedFieldFormats,
    ],
  );

  const hasCommittedTexture =
    target.kind === "region"
      ? Boolean(domainModel.regionTextureOverride || parentDomainModel.asset)
      : Boolean(domainModel.asset);

  const canShowPreparedPreview = useMemo(() => {
    if (!lastApplyPreview || !sessionIdentity) return false;
    const { receipt, sessionScopeKey: previewScopeKey } = lastApplyPreview;
    const source = receipt.prepared_initial_state;
    const scope = receipt.scopes[0];
    if (
      sessionRequestScopeKey(sessionIdentity) !== previewScopeKey ||
      !source ||
      source.scene_revision !== receipt.scene_revision ||
      receipt.status !== "initial_state_ready" ||
      !scope
    ) {
      return false;
    }
    const targetRegionId = target.kind === "region" ? target.regionId : null;
    return scope.object_id === target.objectId && (scope.region_id ?? null) === targetRegionId;
  }, [lastApplyPreview, sessionIdentity, target]);

  const needsReevaluateM0 = useMemo(() => {
    if (!lastApplyReceipt || !sessionIdentity) return false;
    const { receipt, sessionScopeKey: receiptScopeKey } = lastApplyReceipt;
    const scope = receipt.scopes[0];
    if (
      sessionRequestScopeKey(sessionIdentity) !== receiptScopeKey ||
      receipt.status === "initial_state_ready" ||
      !scope
    ) {
      return false;
    }
    const targetRegionId = target.kind === "region" ? target.regionId : null;
    return scope.object_id === target.objectId && (scope.region_id ?? null) === targetRegionId;
  }, [lastApplyReceipt, sessionIdentity, target]);

  const spec = useMemo<InspectorSpec<MagneticTextureDraft>>(() => {
    const entityId =
      target.kind === "region"
        ? `${target.objectId}/${target.regionId}`
        : domainModel.asset?.id ??
          `mag:${target.objectId}:${canonicalPresetKind(baselineDraft.presetKind)}`;

    const breadcrumbs =
      target.kind === "region"
        ? [
            {
              id: "objects-root",
              label: "Objects",
              selection: {
                kind: "objects.root" as const,
                label: "Objects",
                nodeId: "model:objects",
                objectId: null,
                ref: null,
              },
            },
            {
              id: `obj-${target.objectId}`,
              label: objectName,
              selection: {
                kind: "object.root" as const,
                label: objectName,
                nodeId: `model:object:${target.objectId}`,
                objectId: target.objectId,
                ref: {
                  kind: "object.root" as const,
                  nodeId: `model:object:${target.objectId}`,
                  objectId: target.objectId,
                  type: "scene-object" as const,
                  visualizationTargetId: `object:${target.objectId}` as const,
                },
              },
            },
            {
              id: `reg-${target.regionId}`,
              label: regionName,
              selection: {
                kind: "object.region" as const,
                label: regionName,
                nodeId: `model:object:${target.objectId}:region:${target.regionId}`,
                objectId: target.objectId,
                ref: {
                  kind: "object.region" as const,
                  nodeId: `model:object:${target.objectId}:region:${target.regionId}`,
                  objectId: target.objectId,
                  regionId: target.regionId,
                  type: "scene-object" as const,
                  visualizationTargetId:
                    `region:${target.objectId}:${encodeURIComponent(target.regionId)}` as RegionVisualizationTargetId,
                },
              },
            },
            { id: "region-texture", label: "Magnetic texture" },
          ]
        : [
            {
              id: "objects-root",
              label: "Objects",
              selection: {
                kind: "objects.root" as const,
                label: "Objects",
                nodeId: "model:objects",
                objectId: null,
                ref: null,
              },
            },
            {
              id: `obj-${target.objectId}`,
              label: objectName,
              selection: {
                kind: "object.root" as const,
                label: objectName,
                nodeId: `model:object:${target.objectId}`,
                objectId: target.objectId,
                ref: {
                  kind: "object.root" as const,
                  nodeId: `model:object:${target.objectId}`,
                  objectId: target.objectId,
                  type: "scene-object" as const,
                  visualizationTargetId: `object:${target.objectId}` as const,
                },
              },
            },
            { id: "object-texture", label: "Magnetic texture" },
          ];

    return {
      id:
        target.kind === "region"
          ? `magnetic-texture:region:${target.objectId}:${target.regionId}`
          : `magnetic-texture:object:${target.objectId}`,
      header: {
        breadcrumbs,
        canFitView: true,
        searchable: true,
        extraMenuActions: [
          ...(canShowPreparedPreview
            ? [
                {
                  id: "show-initial-magnetization",
                  label: "Show initial magnetization",
                  icon: Eye,
                  disabledReason: previewLoading ? "Checking initial magnetization…" : undefined,
                  onSelect: () => handleShowPreparedMagnetization(),
                },
              ]
            : []),
          ...(hasCommittedTexture
            ? [
                {
                  id: "reevaluate-initial-magnetization",
                  label: "Re-evaluate m₀",
                  icon: RefreshCw,
                  disabledReason:
                    target.kind === "object"
                      ? (objectActionDisabledReason ?? undefined)
                      : !domainModel.authoredRegion
                        ? "Select an authored magnetic region to apply its texture."
                        : undefined,
                  onSelect: (ctx: InspectorActionContext<MagneticTextureDraft>) => {
                    void handleCommitApply(ctx.draft);
                  },
                },
              ]
            : []),
          {
            id: "reset-transform",
            label: "Reset transform [0,0,0 / 1,1,1]",
            icon: RotateCcw,
            onSelect: (ctx) => {
              ctx.patchDraft(resetDraftTransform(ctx.draft, bounds));
            },
          },
          {
            id: "reset-uniform-x",
            label:
              target.kind === "region"
                ? "Clear override (inherit from object)"
                : "Reset to uniform +X",
            icon: Sparkles,
            destructive: target.kind === "region",
            onSelect: (ctx) => {
              if (target.kind === "region") {
                ctx.setField("inheritanceMode", "inherit");
              } else {
                ctx.patchDraft({
                  sourceMode: "preset",
                  presetKind: "uniform",
                  direction: [1, 0, 0],
                  scale: [1, 1, 1],
                });
              }
            },
          },
          ...(target.kind === "object"
            ? [
                {
                  id: "clear-object-magnetization",
                  label: "Clear Texture…",
                  icon: Trash2,
                  destructive: true,
                  disabledReason: objectActionDisabledReason ?? undefined,
                  confirm: {
                    title: `Clear magnetic texture on ${objectName}?`,
                    description:
                      "This removes the assigned initial magnetization asset from this object and reverts to the solver default.",
                    confirmLabel: "Clear Texture",
                  },
                  onSelect: () => handleClearObjectTexture(),
                },
              ]
            : []),
        ],
      },
      identity: {
        domain: "material",
        icon: Compass,
        title: (draft) => {
          if (draft.customUiLabel.trim()) return draft.customUiLabel.trim();
          if (target.kind === "region" && draft.inheritanceMode === "inherit") {
            return "Magnetic texture";
          }
          return humanPresetLabel(
            draft.presetKind,
            draft.sourceMode === "field-file" ? "sampled" : "preset_texture",
          );
        },
        renameFieldKey: "customUiLabel",
        kindLabel:
          target.kind === "region"
            ? `Region magnetization · priority ${regionPriority}`
            : "Initial magnetization (m₀)",
        entityId,
        statePill: (draft) => {
          if (target.kind === "region" && draft.inheritanceMode === "inherit") {
            return { tone: "neutral", label: "Inherited" };
          }
          if (draft.sourceMode === "field-file") {
            return { tone: "info", label: "Imported field" };
          }
          if (!domainModel.asset && target.kind === "object") {
            return { tone: "neutral", label: "Unassigned" };
          }
          return draft.presetVersion === 1
            ? { tone: "warn", label: "Analytical v1" }
            : { tone: "ok", label: "Analytical v2" };
        },
      },
      facts: (draft): readonly InspectorFact[] => {
        if (target.kind === "region") {
          const inherited = draft.inheritanceMode === "inherit";
          return [
            {
              id: "source",
              label: "Source",
              value: inherited ? "Inherited" : "Region override",
              tone: inherited ? undefined : "ok",
            },
            {
              id: "effective-preset",
              label: "Effective preset",
              value: inherited
                ? parentPresetLabel
                : humanPresetLabel(
                    draft.presetKind,
                    draft.sourceMode === "field-file" ? "sampled" : "preset_texture",
                  ),
            },
            {
              id: "characteristic-size",
              label: "Characteristic size",
              value: formatCharacteristicSizeSummary(inherited ? parentDraft : draft),
            },
            {
              id: "precedence",
              label: "Precedence",
              value: `Priority ${regionPriority}`,
            },
          ];
        }

        const spaceLabel =
          draft.mappingSpace === "world"
            ? "World"
            : draft.mappingSpace === "region"
              ? "Region"
              : "Object";
        return [
          {
            id: "preset",
            label: "Preset",
            value: humanPresetLabel(
              draft.presetKind,
              draft.sourceMode === "field-file" ? "sampled" : "preset_texture",
            ),
          },
          {
            id: "mapping",
            label: "Mapping",
            value: `${spaceLabel} · ${draft.resolvedPlane.toUpperCase()}`,
          },
          {
            id: "characteristic-size",
            label: "Characteristic size",
            value: formatCharacteristicSizeSummary(draft),
          },
          {
            id: "norm",
            label: "Norm ‖m‖ = 1",
            value:
              draft.sourceMode === "field-file"
                ? draft.fieldRenormalize
                  ? "Renormalized"
                  : "As stored"
                : "Unit exact",
            tone: "ok",
          },
        ];
      },
      modeTabs:
        hostContext === "object"
          ? [
              { id: "preset", label: "Analytical preset", icon: SlidersHorizontal },
              { id: "field-file", label: "Field file", icon: FolderOpen },
            ]
          : undefined,
      notices: (draft): readonly InspectorNotice<MagneticTextureDraft>[] => {
        const list: InspectorNotice<MagneticTextureDraft>[] = [];
        if (target.kind === "region" && objectRec && !domainModel.authoredRegion) {
          list.push({
            id: "unauthored-region-lock",
            tone: "warn",
            title: "Region not yet authored in scene",
            text: "Select an authored magnetic region to apply its texture.",
          });
        }
        const capabilityGate = resolveMagneticTextureCapabilityGate(activeLane, draft);
        if (capabilityGate && !capabilityGate.enabled && capabilityGate.reason) {
          list.push({
            id: "capability-gate",
            tone: "err",
            title: "Unsupported in active solver lane",
            text: capabilityGate.reason,
          });
        }
        if (canShowPreparedPreview) {
          list.push({
            id: "prepared-initial-magnetization",
            tone: "info",
            title: "Initial magnetization ready",
            text: appliedBannerMessage ?? "Prepared initial magnetization is ready to inspect in 3D.",
            quickFix: {
              label: previewLoading
                ? "Checking initial magnetization…"
                : "Show initial magnetization",
              disabled: previewLoading,
              onApply: () => handleShowPreparedMagnetization(),
            },
          });
        } else if (needsReevaluateM0) {
          list.push({
            id: "reevaluate-initial-magnetization",
            tone: "info",
            title: "Initial magnetization pending evaluation",
            text:
              appliedBannerMessage ??
              "Texture is saved in the scene, but initial magnetization m₀ has not been evaluated on the current mesh yet.",
            quickFix: {
              label: "Re-evaluate m₀",
              ghost: true,
              disabled: Boolean(objectActionDisabledReason),
              disabledReason: objectActionDisabledReason ?? undefined,
              onApply: (ctx) => {
                void handleCommitApply(ctx.draft);
              },
            },
          });
        }
        if (previewError) {
          list.push({
            id: "prepared-initial-magnetization-error",
            tone: "err",
            title: "Initial magnetization preview failed",
            text: previewError,
          });
        }
        if (loadFieldFeedback) {
          list.push({
            id: "load-field-state-feedback",
            tone: loadFieldFeedback.tone,
            text: loadFieldFeedback.message,
          });
        }
        if (draft.presetVersion === 1 && draft.inheritanceMode === "override") {
          list.push({
            id: "legacy-v1-preset",
            tone: "warn",
            title: "Historical v1 preset formula",
            text: "Upgrade to Analytical v2 for exact right-handed plane frames and metric clamping.",
            quickFix: {
              label: "Upgrade to Analytical v2",
              onApply: (ctx) => ctx.setField("presetVersion", 2),
            },
          });
        }
        if (target.kind === "region" && regionRec?.enabled === false) {
          list.push({
            id: "region-disabled",
            tone: "info",
            title: "Region currently disabled",
            text: "This texture override will take effect once the parent region is enabled.",
          });
        }
        if (
          target.kind === "region" &&
          draft.inheritanceMode === "override" &&
          Array.isArray(objectRec?.regions)
        ) {
          const conflictPeer = objectRec.regions
            .map(asRecord)
            .find(
              (r) =>
                r &&
                r.region_id !== target.regionId &&
                r.enabled !== false &&
                r.texture_override != null &&
                (typeof r.priority === "number" ? r.priority : 0) === regionPriority,
            );
          if (conflictPeer) {
            const peerName =
              (typeof conflictPeer.name === "string" && conflictPeer.name) ||
              String(conflictPeer.region_id ?? "peer");
            list.push({
              id: "equal-priority-conflict",
              tone: "warn",
              title: "Equal priority overlap risk",
              text: `Region "${peerName}" also has priority ${regionPriority}. Overlapping masks with identical priority fail region ownership resolution.`,
            });
          }
        }
        return list;
      },
      sections,
      details: (draft) => {
        const draftRef = normalizeMagnetizationRef(draft.magnetizationRef);
        return [
          { label: "Asset ID", value: draftRef ?? entityId, mono: true },
          { label: "Preset version", value: `v${draft.presetVersion}` },
          {
            label: "Target bounds",
            value: `${(bounds.size[0] * 1e9).toPrecision(3)} × ${(bounds.size[1] * 1e9).toPrecision(3)} × ${(bounds.size[2] * 1e9).toPrecision(3)} nm (${bounds.source})`,
          },
        ];
      },
      toPythonModuleSnippet: (draft) =>
        formatMagneticTexturePythonExpression(
          draft,
          bounds,
          target.kind === "region" ? `${regionName || target.regionId}.m` : `${objectName}.m`,
        ),
      commitBar: {
        mode: "staged",
        allowCleanApply: false,
        applyLabel: "Apply Texture",
        cleanMessage: () =>
          domainModel.baseRevision !== null
            ? `Up to date with scene revision ${domainModel.baseRevision}`
            : "Up to date",
        lockReason: (draft) => {
          if (!objectRec) return "Select a committed magnetic object in the scene.";
          if (target.kind === "region" && !domainModel.authoredRegion) {
            return "Select an authored magnetic region to apply its texture.";
          }
          const capabilityGate = resolveMagneticTextureCapabilityGate(activeLane, draft);
          if (capabilityGate && !capabilityGate.enabled) {
            return capabilityGate.reason ?? "Unsupported magnetization operation.";
          }
          return null;
        },
        onApply: (draft) => handleCommitApply(draft),
      },
    };
  }, [
    activeLane,
    appliedBannerMessage,
    baselineDraft.presetKind,
    bounds,
    canShowPreparedPreview,
    domainModel.asset,
    domainModel.authoredRegion,
    domainModel.baseRevision,
    handleClearObjectTexture,
    handleCommitApply,
    handleShowPreparedMagnetization,
    hasCommittedTexture,
    hostContext,
    loadFieldFeedback,
    needsReevaluateM0,
    objectActionDisabledReason,
    objectName,
    objectRec,
    parentDraft,
    parentPresetLabel,
    previewError,
    previewLoading,
    regionName,
    regionPriority,
    regionRec,
    sections,
    target,
  ]);

  const controller = useInspectorSpecController(spec, selection, baselineDraft, undefined, {
    resetFieldInputsOnPatch: true,
    initialModeTabId:
      isLoadSelection || baselineDraft.sourceMode === "field-file" ? "field-file" : "preset",
  });

  // When browsing the Field file tab without yet dirtying draft.sourceMode, still evaluate
  // the sampled_field capability gate notice honestly so unsupported lanes are shown upfront.
  const renderedSpec = useMemo<InspectorSpec<MagneticTextureDraft>>(() => {
    if (hostContext !== "object" || controller.activeModeTabId !== "field-file") {
      return spec;
    }
    return {
      ...spec,
      notices: (draft) =>
        spec.notices
          ? spec.notices(
              draft.sourceMode === "field-file"
                ? draft
                : { ...draft, sourceMode: "field-file" },
            )
          : [],
    };
  }, [controller.activeModeTabId, hostContext, spec]);

  // Honor redirected `object.magnetic-texture.load` selections even when switching from another texture sub-node
  const prevIsLoadRef = useRef(isLoadSelection);
  useEffect(() => {
    const becameLoad = isLoadSelection && !prevIsLoadRef.current;
    prevIsLoadRef.current = isLoadSelection;
    if (hostContext === "object" && becameLoad && controller.activeModeTabId !== "field-file") {
      controller.setActiveModeTabId("field-file");
    }
  }, [controller, hostContext, isLoadSelection]);

  const lastClearedTokenRef = useRef(0);
  useEffect(() => {
    if (clearedResetToken === lastClearedTokenRef.current) return;
    lastClearedTokenRef.current = clearedResetToken;
    controller.revertAll();
  }, [clearedResetToken, controller]);

  // Browse Slot 4 modeTab ("preset" | "field-file") without dirtying draft.sourceMode;
  // sourceMode switches only when a preset tile is clicked or a field file field is edited.
  const handleModeTabChange = useCallback(
    (tabId: string) => {
      controller.setActiveModeTabId(tabId);
    },
    [controller],
  );

  // Respond to external command requests (`magnetization-texture.activate-load-file`)
  const lastHandledTabSeqRef = useRef(0);
  useEffect(() => {
    const req = bridgeSnapshot.tabRequest;
    if (!req || req.seq === lastHandledTabSeqRef.current || req.targetKey !== targetKey) return;
    lastHandledTabSeqRef.current = req.seq;
    if (hostContext === "object") {
      handleModeTabChange(req.tabId);
    } else {
      controller.patchDraft({
        inheritanceMode: "override",
        sourceMode: req.tabId,
      });
    }
  }, [bridgeSnapshot.tabRequest, controller, handleModeTabChange, hostContext, targetKey]);

  const handleFieldChange = useCallback(
    <K extends keyof MagneticTextureDraft & string>(
      key: K,
      value: MagneticTextureDraft[K],
    ) => {
      const coupled = applyCoupledDraftFieldChange(controller.draft, key, value, bounds);
      const entries = Object.entries(coupled);
      if (entries.length === 1 && entries[0]?.[0] === key) {
        controller.setField(key, value);
      } else {
        controller.patchDraft(coupled);
      }
    },
    [bounds, controller],
  );

  // Register live 60 FPS bidirectional draft binding with `TextureTransformGizmo`
  const bindingOwner = useMemo(() => Symbol("magnetic-texture-inspector-binding"), []);

  useEffect(() => {
    controllerActionsRef.current = {
      draft: controller.draft,
      bounds,
      patchDraft: controller.patchDraft,
      revertAll: controller.revertAll,
    };
    registerTextureInspectorBinding(bindingOwner, {
      target,
      draft: controller.draft,
      bounds,
      previewDraft: controller.dirty && controller.valid,
      patchDraft: (partial: Partial<MagneticTextureDraft>) =>
        controllerActionsRef.current.patchDraft(partial),
      fitCharacteristicSize: () =>
        controllerActionsRef.current.patchDraft(
          fitCharacteristicSizeToTarget(
            controllerActionsRef.current.draft,
            controllerActionsRef.current.bounds,
          ),
        ),
      resetTransform: () =>
        controllerActionsRef.current.patchDraft(
          resetDraftTransform(
            controllerActionsRef.current.draft,
            controllerActionsRef.current.bounds,
          ),
        ),
    });
  }, [
    bindingOwner,
    bounds,
    controller.dirty,
    controller.draft,
    controller.patchDraft,
    controller.revertAll,
    controller.valid,
    target,
  ]);

  useEffect(() => {
    return () => unregisterTextureInspectorBinding(bindingOwner);
  }, [bindingOwner]);

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      const ctx = createCommandContext("inspector", kernel, {
        sourceDetail: "magnetic-texture-inspector",
      });
      void commands.execute(commandId ?? "viewport-3d.fit-selection", ctx);
    },
    [commands, kernel],
  );

  return (
    <InspectorTemplate
      activeModeTabId={controller.activeModeTabId}
      animationKey={controller.animationKey}
      appliedFlash={controller.appliedFlash}
      appliedMessage={appliedBannerMessage}
      applyError={controller.applyError}
      applying={controller.applying || clearingObjectTexture}
      baseline={controller.baseline}
      dirtyFields={controller.dirtyFields}
      displayUnits={controller.displayUnits}
      draft={controller.draft}
      fieldResetTokens={controller.fieldResetTokens}
      forceShowErrors={controller.forceShowErrors}
      invalidFields={controller.invalidFields}
      selection={selection}
      spec={renderedSpec}
      touchedFields={controller.touchedFields}
      onActiveModeTabChange={handleModeTabChange}
      onApply={controller.requestApply}
      onDisplayUnitChange={controller.setDisplayUnit}
      onFieldChange={handleFieldChange}
      onFieldTouch={controller.touchField}
      onFitView={handleFitView}
      onFocusField={controller.focusField}
      onParseErrorChange={controller.setParseError}
      onPatchDraft={controller.patchDraft}
      onRevertAll={controller.revertAll}
      onRevertField={controller.revertField}
      onSelectNode={(next) => kernel.selection.set(next, "inspector")}
    />
  );
}

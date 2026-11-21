"use client";

import {
  Compass,
  FolderOpen,
  Move3D,
  RotateCcw,
  Scaling,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { MagnetizationApplyTarget } from "@/kernel/api/apiTypes";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  SCENE_RESOURCE_KEY,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
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
import type { InspectorPanelProps } from "@/modules/inspector/inspectorTypes";
import {
  commitMagneticTextureApply,
  magneticTextureApplyMessage,
  syncAuthoringScriptBestEffort,
} from "@/modules/inspector/panels/ObjectMagneticTexturePanelViewModel";
import {
  InspectorTemplate,
  useInspectorSpecController,
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
} from "@/shared/domain/magnetization-texture/texturePresets";
import type { MagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/types";

import {
  applyCoupledDraftFieldChange,
  buildMagneticTextureInspectorSections,
  formatCharacteristicSizeSummary,
  type FieldImportInspectionSummary,
} from "./MagneticTextureCoreSections";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function resolveMagneticTextureCapabilityGate(
  activeLane: ActiveLaneCapabilitySnapshot | null,
  draft: MagneticTextureDraft,
): { enabled: boolean; reason: string | null } | null {
  if (!activeLane?.operations) return null;
  if (draft.inheritanceMode === "inherit") return null;

  const ops = activeLane.operations as Record<
    string,
    { state?: string; reason?: string | null } | undefined
  >;

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
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionStatusData = useSessionStatusSelector((status) => status.data);
  const activeLane = useActiveLaneCapabilities();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();

  const bridgeSnapshot = useSyncExternalStore(
    subscribeTextureDraftBridge,
    getTextureInspectorUiSnapshot,
    getTextureInspectorUiSnapshot,
  );

  const hostContext: "object" | "region" =
    selection.kind === "object.region.texture" ? "region" : "object";

  const target = useMemo<MagnetizationTextureTarget>(() => {
    const resolved = resolveMagnetizationTextureTarget(
      extractMagnetizationTargetInputFromSelection(selection),
      scene.data,
    );
    if (resolved) return resolved;
    const fallbackObjId =
      (selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId) ??
      "object";
    const fallbackRegId =
      selection.ref?.type === "scene-object" ? selection.ref.regionId : undefined;
    if (hostContext === "region" && fallbackRegId) {
      return { kind: "region", objectId: fallbackObjId, regionId: fallbackRegId };
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

  const baselineDraft = useMemo<MagneticTextureDraft>(() => {
    if (target.kind === "region") {
      const overrideInit = regionRec
        ? asRecord(regionRec.texture_override)?.initial_magnetization
        : null;
      if (overrideInit) {
        return hydrateMagneticTextureDraftFromInitializer(overrideInit, bounds, "region", {
          inherited: false,
        });
      }
      return hydrateMagneticTextureDraftFromInitializer(parentDomainModel.asset, bounds, "region", {
        inherited: true,
      });
    }
    return hydrateMagneticTextureDraftFromInitializer(domainModel.asset, bounds, "object");
  }, [bounds, domainModel.asset, parentDomainModel.asset, regionRec, target.kind]);

  const supportedFieldFormats = useMemo<readonly string[]>(() => {
    const statusRec = asRecord(sessionStatusData);
    const capsRec = asRecord(statusRec?.capabilities);
    const rawList = capsRec?.field_state_import_formats;
    if (Array.isArray(rawList)) {
      const cleaned = rawList.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (cleaned.length > 0) return cleaned;
    }
    return ["field_state_json"];
  }, [sessionStatusData]);

  const [inspectionSummary, setInspectionSummary] = useState<FieldImportInspectionSummary | null>(
    null,
  );
  const [inspectingFieldFile, setInspectingFieldFile] = useState(false);
  const [appliedBannerMessage, setAppliedBannerMessage] = useState<string | null>(null);

  const handleInspectFieldFile = useCallback(
    async (draft: MagneticTextureDraft) => {
      const artifactRef =
        draft.fieldOrigin === "artifact"
          ? draft.fieldArtifactRef.trim()
          : draft.fieldSourcePath.trim();
      if (!artifactRef || !api?.persistence?.fieldStates?.inspectImport) return;
      setInspectingFieldFile(true);
      try {
        const res = asRecord(
          await api.persistence.fieldStates.inspectImport(
            {
              artifact_ref: artifactRef,
              ...(draft.fieldSourceFormat !== "auto" ? { format: draft.fieldSourceFormat } : {}),
            } as never,
            sessionScopeKey ? { sessionScopeKey } : undefined,
          ),
        );
        if (res) {
          const shape = Array.isArray(res.source_grid_shape) && res.source_grid_shape.length >= 3
            ? ([
                Number(res.source_grid_shape[0]) || 1,
                Number(res.source_grid_shape[1]) || 1,
                Number(res.source_grid_shape[2]) || 1,
              ] as const)
            : null;
          const datasets = Array.isArray(res.datasets)
            ? res.datasets.filter((d): d is string => typeof d === "string")
            : ["fields/m"];
          setInspectionSummary({
            vectorCount: Number(res.vector_count) || 0,
            frameCount: Number(res.frame_count) || 1,
            sourceGridShape: shape,
            minNorm: typeof res.min_norm === "number" ? res.min_norm : 1,
            maxNorm: typeof res.max_norm === "number" ? res.max_norm : 1,
            compatible: res.compatible !== false,
            datasets,
          });
        }
      } finally {
        setInspectingFieldFile(false);
      }
    },
    [api, sessionScopeKey],
  );

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

  const handleCommitApply = useCallback(
    async (draftToSave: MagneticTextureDraft): Promise<boolean> => {
      if (!api || !sessionScopeKey || domainModel.baseRevision === null) {
        throw new Error("The saved scene and session are required to apply magnetization.");
      }

      let applyTarget: MagnetizationApplyTarget;
      if (target.kind === "region") {
        if (draftToSave.inheritanceMode === "inherit") {
          applyTarget = {
            kind: "region",
            object_id: target.objectId,
            region_id: target.regionId,
            texture_override: null,
          };
        } else {
          const initializer = serializeMagneticTextureDraftToInitializer(draftToSave, bounds);
          applyTarget = {
            kind: "region",
            object_id: target.objectId,
            region_id: target.regionId,
            texture_override: {
              initial_magnetization: initializer as never,
            },
          };
        }
      } else if (draftToSave.sourceMode === "field-file") {
        const initializer = serializeMagneticTextureDraftToInitializer(draftToSave, bounds);
        const assetId = `mag:${target.objectId}:sampled`;
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
        const assetId = magnetizationTextureAssetId(target, presetKind);
        const initializer = serializeMagneticTextureDraftToInitializer(draftToSave, bounds);
        applyTarget = {
          kind: "object",
          object_id: target.objectId,
          asset: presetMagnetizationAsset({
            id: assetId,
            label: draftToSave.customUiLabel.trim() || null,
            presetKind,
            presetVersion: 2,
            presetParams: (initializer.preset_params ?? {}) as never,
            mapping: (initializer.mapping ?? null) as never,
            textureTransform: (initializer.texture_transform ?? null) as never,
          }),
        };
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

      setAppliedBannerMessage(
        magneticTextureApplyMessage(response.magnetization_apply, syncWarning),
      );
      return true;
    },
    [
      api,
      authoringHistory,
      bounds,
      commands,
      domainModel.baseRevision,
      resources,
      scene.data,
      sessionScopeKey,
      target,
    ],
  );

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
      }),
    [
      bounds,
      handleInspectFieldFile,
      hostContext,
      inspectingFieldFile,
      inspectionSummary,
      objectBounds,
      objectName,
      parentDraft,
      parentPresetLabel,
      parentPreviewSpec,
      regionRec,
      supportedFieldFormats,
    ],
  );

  const spec = useMemo<InspectorSpec<MagneticTextureDraft>>(() => {
    const entityId =
      target.kind === "region"
        ? `${target.objectId}/${target.regionId}`
        : domainModel.asset?.id ?? `mag:${target.objectId}:${canonicalPresetKind(baselineDraft.presetKind)}`;

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
                  visualizationTargetId: `region:${target.objectId}:${encodeURIComponent(target.regionId)}` as RegionVisualizationTargetId,
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
        primaryHeaderAction: {
          label: bridgeSnapshot.gizmoEnabled ? "Hide 3D gizmo (T)" : "3D gizmo (T)",
          icon: Move3D,
          variant: bridgeSnapshot.gizmoEnabled ? "secondary" : "outline",
          disabledReason:
            target.kind === "region" && baselineDraft.inheritanceMode === "inherit"
              ? "Switch region source to Override to manipulate its 3D texture gizmo."
              : undefined,
          onRun: () => {
            toggleTextureGizmo();
          },
        },
        extraMenuActions: [
          {
            id: "fit-characteristic-size",
            label:
              target.kind === "region"
                ? "Fit characteristic size to region"
                : "Fit characteristic size to object",
            icon: Scaling,
            onSelect: (ctx) => {
              ctx.patchDraft(fitCharacteristicSizeToTarget(ctx.draft, bounds));
            },
          },
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
            destructive: true,
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
        const capabilityGate = resolveMagneticTextureCapabilityGate(activeLane, draft);
        if (capabilityGate && !capabilityGate.enabled && capabilityGate.reason) {
          list.push({
            id: "capability-gate",
            tone: "err",
            title: "Unsupported in active solver lane",
            text: capabilityGate.reason,
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
      details: (draft) => [
        { label: "Asset ID", value: entityId, mono: true },
        { label: "Preset version", value: `v${draft.presetVersion}` },
        {
          label: "Target bounds",
          value: `${(bounds.size[0] * 1e9).toPrecision(3)} × ${(bounds.size[1] * 1e9).toPrecision(3)} × ${(bounds.size[2] * 1e9).toPrecision(3)} nm (${bounds.source})`,
        },
      ],
      toPythonModuleSnippet: (draft) =>
        formatMagneticTexturePythonExpression(
          draft,
          bounds,
          target.kind === "region" ? `${regionName || target.regionId}.m` : `${objectName}.m`,
        ),
      commitBar: {
        mode: "staged",
        cleanMessage: () =>
          domainModel.baseRevision !== null
            ? `Up to date with scene revision ${domainModel.baseRevision}`
            : "Up to date",
        lockReason: (draft) => {
          if (!objectRec) return "Select a committed magnetic object in the scene.";
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
    baselineDraft.inheritanceMode,
    baselineDraft.presetKind,
    bounds,
    bridgeSnapshot.gizmoEnabled,
    domainModel.asset,
    domainModel.baseRevision,
    handleCommitApply,
    hostContext,
    objectName,
    objectRec,
    parentDraft,
    parentPresetLabel,
    regionName,
    regionPriority,
    regionRec,
    sections,
    target,
  ]);

  const controller = useInspectorSpecController(spec, selection, baselineDraft, undefined, {
    initialModeTabId: baselineDraft.sourceMode === "field-file" ? "field-file" : "preset",
  });

  // Synchronize Slot 4 modeTab ("preset" | "field-file") with draft.sourceMode on Object
  const handleModeTabChange = useCallback(
    (tabId: string) => {
      controller.setActiveModeTabId(tabId);
      const nextSourceMode = tabId === "field-file" ? "field-file" : "preset";
      if (controller.draft.sourceMode !== nextSourceMode) {
        controller.setField("sourceMode", nextSourceMode);
      }
    },
    [controller],
  );

  // Respond to external command requests (`magnetization-texture.activate-load-file`)
  const targetKey = formatTextureTargetKey(target);
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
  const controllerActionsRef = useRef({
    draft: controller.draft,
    bounds,
    patchDraft: controller.patchDraft,
  });

  useEffect(() => {
    controllerActionsRef.current = {
      draft: controller.draft,
      bounds,
      patchDraft: controller.patchDraft,
    };
    registerTextureInspectorBinding(bindingOwner, {
      target,
      draft: controller.draft,
      bounds,
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
  }, [bindingOwner, bounds, controller.draft, controller.patchDraft, target]);

  useEffect(() => {
    return () => unregisterTextureInspectorBinding(bindingOwner);
  }, [bindingOwner]);

  const handleFitView = useCallback(
    (commandId?: string) => {
      const ctx = createCommandContext("inspector", kernel, {
        sourceDetail: "magnetic-texture-inspector",
      });
      void commands.execute((commandId ?? "viewport-3d.fit-selection") as never, ctx);
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
      applying={controller.applying}
      baseline={controller.baseline}
      dirtyFields={controller.dirtyFields}
      displayUnits={controller.displayUnits}
      draft={controller.draft}
      forceShowErrors={controller.forceShowErrors}
      invalidFields={controller.invalidFields}
      selection={selection}
      spec={spec}
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

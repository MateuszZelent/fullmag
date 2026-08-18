"use client";

import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useKernel } from "@/kernel/KernelContext";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { VisualizationRegistrySyncController } from "@/kernel/visualization/VisualizationRegistrySyncController";
import {
  EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
} from "@/kernel/visualization/VisualizationDebugController";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  displayLabelForVisualizationTarget,
  hasVisualizationStatePatch,
  isFdmUniverseOutsideSupportTarget,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resetAirboxVisualizationState,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  visualizationTargetCapabilities,
  visualizationStateOverrideMatchesTarget,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationGeometryScope,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
  type ViewportTargetRenderingPreferences,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  shouldLoadRuntimeMeshManifest,
  useFieldCatalogResource,
  useQuantityCatalogResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useFieldAvailabilityResource } from "@/kernel/resources/fieldAvailabilityResources";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import {
  useVisualizationStateResource,
} from "@/kernel/visualization/useVisualizationStateResource";
import {
  useMeshSharedDomainManifestResource,
  useMeshRegionMembershipResource,
  useSceneResource,
  useDomainMetaResource,
  useFdmRegionMembershipResource,
  useFdmRegionMembershipBinaryResource,
  useFdmMultilayerLayoutResource,
  useFdmMultilayerLayerActiveMasksResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  isVisualizationAirboxIdentity,
  visualizationTargetIdForSceneObject,
} from "@/kernel/selection/selectionTypes";
import { visualizationSceneObjectIds } from "@/kernel/selection/visualizationTargetResolver";
import { useLayoutSelector } from "@/kernel/layout/useLayout";
import { manifestRenderableCarriers } from "@/modules/viewport-3d/public";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import {
  ScientificInspectorContext,
  ScientificInspectorIdentity,
} from "../components/ScientificInspectorTemplate";
import { FieldRow } from "../primitives/FieldRow";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  buildVisualizationPanelSections,
  canonicalVisualizationStateForBaseline,
  resolveVisualizationVectorBudgetRange,
  resolveVisualizationVectorSceneCap,
  visualizationOverridesForTargetReset,
  resolveVisualizationVectorCapacityForTarget,
  resolveObjectVisualizationPanelTopologyFreshness,
  resolveObjectChildRegionVisualizationTargets,
  resolveChildRegionOverrideTargetIds,
  removeOwnerChildRegionVisualizationOverrides,
  resolveRegionVisualizationCarrier,
  resolveVisualizationRenderResolution,
  restoreVisualizationAppliedBaseline,
  fdmVisualizationResourceNotice,
  fieldAvailabilityQueryForVisualizationTarget,
  isVisualizationBaselineReady,
  resolveObjectVisualizationLane,
  resolveAirboxFieldCarrierIdentity,
  resolveObjectVisualizationResourceGates,
  resolveObjectVisualizationTargetForLane,
  resolveObjectVisualizationDataState,
  resolveTargetFieldAvailabilityMap,
  resolveTargetFieldAvailabilityFromBackend,
  targetFieldCarrierDescriptorFromDebugSnapshots,
  resolveVisualizationTargetMutationStatus,
  resolvePendingVisualizationFields,
  shouldLoadObjectVisualizationFieldCatalog,
  shouldShowPrimitiveDisplayToggle,
  queueTargetVectorVisibilityPatch,
  resolveObjectVisualizationPanelTarget,
  resolveSelectedTargetVectorMeshPartRows,
  resolveObjectVisualizationPanelSelectionTarget,
  visualizationOverrideStateLabel,
  type VisualizationVectorBudgetRange,
  visualizationResetActionLabel,
  parseRegionVisualizationTargetId,
} from "./ObjectVisualizationPanelModel";
import {
  selectObjectVisualizationManifestStatus,
  objectVisualizationManifestStatusEquals,
  selectObjectVisualizationPanelSnapshot,
  objectVisualizationPanelSnapshotEquals,
  viewportRenderingPreferencesPatch,
} from "./ObjectVisualizationHelpers";
import { ObjectVisualizationOverview } from "./ObjectVisualizationOverview";
import { PlanarVisualizationSection } from "../visualization/PlanarVisualizationSection";
import {
  VisualizationContextSwitchControl,
  useVisualizationViewContext,
} from "../visualization/VisualizationContextSwitch";
import { planarPresentationPatchFromThreeDimensional } from "../visualization/presentationSemantics";

interface ObjectVisualizationAppliedBaseline {
  overrides: VisualizationStateResource["overrides"];
  targets: Array<{
    preferences: ViewportTargetRenderingPreferences | null;
    settings: VisualizationTargetSettings;
    target: VisualizationTargetRef;
  }>;
}

function primitiveRecordEquals(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) return false;
  }
  return true;
}

function objectVisualizationAppliedBaselineEquals(
  previous: ObjectVisualizationAppliedBaseline,
  next: ObjectVisualizationAppliedBaseline,
): boolean {
  if (previous.targets.length !== next.targets.length) return false;
  for (let index = 0; index < previous.targets.length; index += 1) {
    const previousTarget = previous.targets[index];
    const nextTarget = next.targets[index];
    if (!previousTarget || !nextTarget) return false;
    if (
      visualizationTargetKey(previousTarget.target) !==
      visualizationTargetKey(nextTarget.target)
    ) {
      return false;
    }
    if (
      !primitiveRecordEquals(
        previousTarget.settings as unknown as Record<string, unknown>,
        nextTarget.settings as unknown as Record<string, unknown>,
      ) ||
      !primitiveRecordEquals(
        previousTarget.preferences as unknown as Record<string, unknown> | null,
        nextTarget.preferences as unknown as Record<string, unknown> | null,
      )
    ) {
      return false;
    }
  }
  return true;
}

function visualizationMutationStatusEquals(
  previous: ReturnType<typeof resolveVisualizationTargetMutationStatus>,
  next: ReturnType<typeof resolveVisualizationTargetMutationStatus>,
): boolean {
  return (
    previous.error === next.error &&
    previous.pending === next.pending &&
    previous.retryable === next.retryable &&
    previous.state === next.state
  );
}

function useVisualizationTargetMutationStatus(
  visualizationSync: VisualizationRegistrySyncController,
  targetIds: readonly string[],
) {
  const targetIdsKey = JSON.stringify(targetIds);
  const stableTargetIds = useMemo(
    () => JSON.parse(targetIdsKey) as string[],
    [targetIdsKey],
  );
  const selectedRef = useRef<
    ReturnType<typeof resolveVisualizationTargetMutationStatus> | undefined
  >(undefined);
  const subscribe = useCallback(
    (onStoreChange: () => void) => visualizationSync.subscribe(onStoreChange),
    [visualizationSync],
  );
  const getSnapshot = useCallback(() => {
    const next = resolveVisualizationTargetMutationStatus({
      snapshot: visualizationSync.getSnapshot(),
      targetIds: stableTargetIds,
    });
    if (
      selectedRef.current &&
      visualizationMutationStatusEquals(selectedRef.current, next)
    ) {
      return selectedRef.current;
    }
    selectedRef.current = next;
    return next;
  }, [stableTargetIds, visualizationSync]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
import {
  VisualizationDisplayPassesSection,
  VisualizationRenderModeSection,
  VisualizationSurfaceColoringSection,
  VisualizationQuantitySection,
  VisualizationPointsSection,
  VisualizationWireframeSection,
  VisualizationVectorsSection,
  VisualizationGeometryScopeSection,
  VisualizationOverridesSection,
  ColorField,
  VisualizationRadioGroup,
  VisualizationToggleButton,
  type IsVisualizationFieldPending,
} from "./ObjectVisualizationTargetSection";

function useObjectVisualizationPanelState(
  selection: InspectorPanelProps["selection"],
) {
  const selectionTarget = resolveVisualizationTargetFromSelection(selection);
  const kernel = useKernel();
  const { visualizationDebug, visualizationSync } = kernel;
  const visualization = useObjectVisualizationController();
  const activeModuleTab = useLayoutSelector((layout) => layout.activeModuleTab);
  const manifestStatus = useSessionStatusSelector(
    selectObjectVisualizationManifestStatus,
    {
      enabled: Boolean(selectionTarget),
      isEqual: objectVisualizationManifestStatusEquals,
    },
  );
  const lane = resolveObjectVisualizationLane(manifestStatus?.domain.discretization);
  const fdmMultilayerLayout = useFdmMultilayerLayoutResource({
    enabled: lane === "fdm",
  });
  const fdmMultilayerActiveMasks = useFdmMultilayerLayerActiveMasksResource(
    fdmMultilayerLayout.data,
    { enabled: lane === "fdm" },
  );
  const target = resolveObjectVisualizationTargetForLane({
    fdmNativeLayers: fdmMultilayerLayout.data?.layers,
    lane,
    selection,
    selectionTarget,
  });
  const { fdm: fdmResourcesEnabled, fem: femResourcesEnabled } =
    resolveObjectVisualizationResourceGates({ lane, target });
  const fdmTarget = fdmResourcesEnabled && target !== null;
  const visualizationStateEnabled = Boolean(
    target || (selection.ref?.type === "mesh-part" && selectionTarget),
  );
  const visualizationState = useVisualizationStateResource({
    enabled: visualizationStateEnabled,
  });
  const displayVisualizationState =
    visualizationState.optimisticData ?? visualizationState.data;
  const baselineVisualizationState = canonicalVisualizationStateForBaseline(
    visualizationState.data,
    visualizationState.optimisticData,
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [patchChildRegions, setPatchChildRegions] = useState(false);
  const [fieldCatalogRequestedTargetKey, setFieldCatalogRequestedTargetKey] =
    useState<string | null>(null);
  const scene = useSceneResource({ enabled: femResourcesEnabled });
  const fdmDomain = useDomainMetaResource({ enabled: fdmResourcesEnabled });
  const fdmMembership = useFdmRegionMembershipResource({
    enabled: fdmResourcesEnabled,
  });
  const fdmMembershipRevision = fdmMembership.data
    ? `${fdmMembership.data.mesh_revision}:${fdmMembership.data.region_membership_revision}`
    : null;
  const fdmMembershipBinary = useFdmRegionMembershipBinaryResource(null, {
    enabled: fdmResourcesEnabled,
    revision: fdmMembershipRevision,
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled:
      femResourcesEnabled &&
      shouldLoadRuntimeMeshManifest(Boolean(target), manifestStatus),
  });
  const sceneObjectIds = useMemo(
    () => visualizationSceneObjectIds(scene.data),
    [scene.data],
  );
  const selectedMeshPart = useMemo(
    () =>
      selection.ref?.type === "mesh-part"
        ? manifestRenderableCarriers(manifest.data).find(
            (part) =>
              part.id ===
              (selection.ref?.type === "mesh-part"
                ? selection.ref.carrierPartId ?? selection.ref.nodeId
                : null),
          ) ?? null
        : null,
    [manifest.data, selection.ref],
  );
  /* The target resolver returns a scoped identity object; keep this memoized
   * because downstream resource selectors use its identity as a cache key. */
  const resolvedTarget = useMemo(
    () =>
      resolveObjectVisualizationPanelSelectionTarget({
        sceneObjectIds,
        selectedMeshPart,
        selection,
        selectionTarget: target,
        visualizationState: visualizationState.data,
      }),
    [
      sceneObjectIds,
      selectedMeshPart,
      selection,
      target,
      visualizationState.data,
    ],
  );
  const airboxFieldCarrierIdentity = useMemo(() => {
    if (resolvedTarget?.kind !== "airbox") return null;
    const airboxPartIds =
      lane === "fem"
        ? manifestRenderableCarriers(manifest.data)
            .filter(isVisualizationAirboxIdentity)
            .map((part) => part.id)
        : [];
    return resolveAirboxFieldCarrierIdentity({ airboxPartIds, lane });
  }, [lane, manifest.data, resolvedTarget?.kind]);
  const targetDebugSnapshots = useSyncExternalStore(
    (onStoreChange) =>
      resolvedTarget
        ? visualizationDebug.subscribe(resolvedTarget.id, onStoreChange)
        : () => undefined,
    () =>
      resolvedTarget
        ? visualizationDebug.getSnapshots(resolvedTarget.id)
        : EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
    () => EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
  );
  const regionTarget = useMemo(() => {
    if (resolvedTarget?.kind !== "region") return null;
    return parseRegionVisualizationTargetId(resolvedTarget.id);
  }, [resolvedTarget]);
  const regionMembership = useMeshRegionMembershipResource(
    regionTarget?.objectId,
    regionTarget?.regionId,
    { enabled: femResourcesEnabled && Boolean(regionTarget) },
  );
  const regionMemberships = useMemo(
    () => (regionMembership.data ? [regionMembership.data] : null),
    [regionMembership.data],
  );
  const childRegionTargets = useMemo(
    () =>
      resolvedTarget?.kind === "object"
        ? resolveObjectChildRegionVisualizationTargets({
            manifestRegions: manifest.data?.regions,
            objectId: selection.objectId,
            scene: scene.data,
          })
        : [],
    [manifest.data?.regions, resolvedTarget?.kind, scene.data, selection.objectId],
  );
  const visualizationTargets = useMemo(() => {
    const targets: VisualizationTargetRef[] = [];
    if (resolvedTarget) {
      targets.push(resolvedTarget);
      if (resolvedTarget.kind === "region" && selection.objectId) {
        targets.push({
          id: visualizationTargetIdForSceneObject(selection.objectId),
          kind: "object",
          label: selection.label,
        });
      }
    }

    for (const part of manifest.data?.mesh_parts ?? []) {
      if (isVisualizationAirboxIdentity(part)) continue;
      targets.push(
        resolveObjectVisualizationPanelTarget({
          part,
          sceneObjectIds,
          visualizationState: displayVisualizationState,
        }),
      );
    }

    if (resolvedTarget?.kind === "object") {
      targets.push(...childRegionTargets);
    }

    return targets;
  }, [
    childRegionTargets,
    manifest.data?.mesh_parts,
    sceneObjectIds,
    selection.label,
    selection.objectId,
    resolvedTarget,
    displayVisualizationState,
  ]);
  const selectPanelSnapshot = useCallback(
    (snapshot: ObjectVisualizationSnapshot) =>
      selectObjectVisualizationPanelSnapshot(snapshot, visualizationTargets),
    [visualizationTargets],
  );
  const snapshot = useObjectVisualizationSelector(selectPanelSnapshot, {
    isEqual: objectVisualizationPanelSnapshotEquals,
  });
  const inheritedSettings =
    resolvedTarget?.kind === "region" && selection.objectId
      ? resolveTargetVisualization({
          snapshot,
          target: {
            id: visualizationTargetIdForSceneObject(selection.objectId),
            kind: "object",
            label: selection.label,
          },
          visualizationState: displayVisualizationState,
        }).settings
      : undefined;
  const targetVisualization = resolvedTarget
    ? resolveTargetVisualization({
        inheritedSettings,
        snapshot,
        target: resolvedTarget,
        visualizationState: displayVisualizationState,
      })
    : null;
  const settings = targetVisualization?.settings ?? null;
  const effectiveSettings = targetVisualization?.effectiveSettings ?? null;
  const hasTargetOverride = Boolean(targetVisualization?.override);
  const appliedBaselineTargets = resolvedTarget
    ? [resolvedTarget, ...childRegionTargets]
    : [];
  const canonicalPanelSnapshot: ObjectVisualizationSnapshot = {
    ...snapshot,
    pendingOverrides: {},
  };
  const appliedBaseline: ObjectVisualizationAppliedBaseline = {
    overrides: (baselineVisualizationState?.overrides ?? []).filter((entry) =>
      appliedBaselineTargets.some((baselineTarget) =>
        visualizationStateOverrideMatchesTarget(entry, baselineTarget),
      ),
    ),
    targets: appliedBaselineTargets.map((baselineTarget) => {
      const baselineSettings = resolveTargetVisualization({
          snapshot: canonicalPanelSnapshot,
          target: baselineTarget,
          visualizationState: baselineVisualizationState,
        }).settings;
      return {
        preferences:
          snapshot.viewportPreferences?.[
            visualizationTargetKey(baselineTarget)
          ] ?? null,
        settings: baselineSettings,
        target: baselineTarget,
      };
    }),
  };
  const visualizationBaselineReady = isVisualizationBaselineReady({
    target: resolvedTarget,
    visualizationState: visualizationState.data,
    visualizationStateEnabled,
  });
  const childRegionOverrideCount = resolveChildRegionOverrideTargetIds({
    backendOverrides: displayVisualizationState?.overrides ?? [],
    childTargets: childRegionTargets,
    objectId: selection.objectId ?? "",
    snapshot,
  }).size;
  const panelSettings = settings;
  const targetKey = resolvedTarget
    ? visualizationTargetKey(resolvedTarget)
    : null;
  const childRegionTargetIds = childRegionTargets.map((childTarget) =>
    visualizationTargetKey(childTarget),
  );
  const mutationTargetIds = targetKey
    ? [
        targetKey,
        ...(patchChildRegions ? childRegionTargetIds : []),
      ]
    : [];
  const childRegionMutationStatus = useVisualizationTargetMutationStatus(
    visualizationSync,
    childRegionTargetIds,
  );
  const targetMutationStatus = useVisualizationTargetMutationStatus(
    visualizationSync,
    mutationTargetIds,
  );
  const mutationStatus = useVisualizationTargetMutationStatus(
    visualizationSync,
    [targetKey ?? "", ...childRegionTargetIds],
  );
  const pending = Boolean(
    targetMutationStatus.pending ||
      mutationTargetIds.some((mutationTargetId) =>
        Boolean(snapshot.pendingOverrides?.[mutationTargetId]),
      ),
  );
  const pendingFields = resolvePendingVisualizationFields({
    snapshot,
    targetIds: mutationTargetIds,
  });
  const childRegionPending = Boolean(
    childRegionMutationStatus.pending ||
      childRegionTargetIds.some((mutationTargetId) =>
        Boolean(snapshot.pendingOverrides?.[mutationTargetId]),
      ),
  );
  const fieldCatalogRequested =
    targetKey !== null && fieldCatalogRequestedTargetKey === targetKey;
  const fieldCatalog = useFieldCatalogResource({
    enabled:
      fdmTarget ||
      target?.kind === "airbox" ||
      shouldLoadObjectVisualizationFieldCatalog({
        requested: fieldCatalogRequested,
        surfaceColorSource: settings?.surfaceColorSource,
        targetActive: Boolean(resolvedTarget),
        vectorsVisible: Boolean(settings?.vectorsVisible),
      }),
  });
  const quantityCatalog = useQuantityCatalogResource({
    enabled:
      fdmTarget ||
      target?.kind === "airbox" ||
      shouldLoadObjectVisualizationFieldCatalog({
        requested: fieldCatalogRequested,
        surfaceColorSource: settings?.surfaceColorSource,
        targetActive: Boolean(resolvedTarget),
        vectorsVisible: Boolean(settings?.vectorsVisible),
      }),
  });
  const requiresFieldData = Boolean(
    resolvedTarget &&
      settings &&
      visualizationTargetCapabilities(resolvedTarget).supportsFieldData &&
      (settings.vectorsVisible ||
        (settings.shaderVisible && settings.surfaceColorSource !== "solid")),
  );
  const fieldAvailabilityQuery = useMemo(
    () =>
      fieldAvailabilityQueryForVisualizationTarget(
        resolvedTarget,
        airboxFieldCarrierIdentity,
      ),
    [airboxFieldCarrierIdentity, resolvedTarget],
  );
  const airboxFieldCarrierReady =
    resolvedTarget?.kind !== "airbox" || airboxFieldCarrierIdentity !== null;
  const fieldAvailability = useFieldAvailabilityResource({
    ...fieldAvailabilityQuery,
    enabled: Boolean(
      resolvedTarget && requiresFieldData && airboxFieldCarrierReady,
    ),
    quantityId: settings?.activeQuantityId ?? "H_demag",
  });
  const fieldAvailabilityEnabled = Boolean(
    resolvedTarget && requiresFieldData && airboxFieldCarrierReady,
  );
  const targetFieldCarrier =
    resolvedTarget && settings
      ? targetFieldCarrierDescriptorFromDebugSnapshots({
          pass: settings.vectorsVisible ? "vector" : "surface",
          quantityId: settings.activeQuantityId,
          snapshots: targetDebugSnapshots,
          target: resolvedTarget,
        })
      : null;
  const dataState = resolveObjectVisualizationDataState({
    backendAvailability: fieldAvailability.data,
    backendAvailabilityStatus: fieldAvailabilityEnabled
      ? fieldAvailability.status
      : undefined,
    carrier: targetFieldCarrier,
    fieldCatalog: fieldCatalog.data,
    fieldCatalogStatus: fieldCatalog.status,
    quantityId: settings?.activeQuantityId ?? "",
    requiresFieldData,
    target: resolvedTarget,
  });
  const targetFieldAvailability = resolvedTarget
    ? (() => {
        const availability = new Map(
          resolveTargetFieldAvailabilityMap({
            carrier: targetFieldCarrier,
            fieldCatalog: fieldCatalog.data,
            quantityIds: fieldCatalog.data?.quantities.map(
              (quantity) => quantity.quantity_id,
            ),
            target: resolvedTarget,
          }),
        );
        const backendAvailability = fieldAvailability.data;
        if (backendAvailability?.target_id === resolvedTarget.id) {
          const targetAvailability = resolveTargetFieldAvailabilityFromBackend(
            backendAvailability,
            resolvedTarget,
          );
          availability.set(targetAvailability.quantityId, targetAvailability);
        }
        return availability;
      })()
    : new Map();
  const topologyFreshness = resolvedTarget
    ? resolveObjectVisualizationPanelTopologyFreshness({
        manifest: manifest.data,
        scene: scene.data,
        targetObjectId:
          resolvedTarget.kind === "object"
            ? resolvedTarget.id
            : selection.objectId,
        targetKind: resolvedTarget.kind,
      })
    : null;
  const renderResolution = settings && effectiveSettings
    ? resolveVisualizationRenderResolution({
        effectiveSettings,
        settings,
        topologyFreshness,
      })
    : null;
  const sections = settings && effectiveSettings
    ? buildVisualizationPanelSections({
        effectiveSettings: renderResolution?.finalSettings ?? effectiveSettings,
        settings,
        target: resolvedTarget ?? undefined,
      })
    : [];
  const passControlsDisabled =
    !settings?.visible ||
    Boolean(renderResolution?.degradedReasons.length);
  const primitiveDisplayToggleVisible = resolvedTarget
    ? shouldShowPrimitiveDisplayToggle(
        activeModuleTab,
        resolvedTarget.kind,
        topologyFreshness,
      )
    : false;
  const revision = targetVisualization?.revision ?? snapshot.version;
  const visualizationResourceRevision = visualizationState.data?.revision ?? null;

  async function patch(patchValue: VisualizationTargetPatch): Promise<void> {
    if (!resolvedTarget) return;
    const patchTargets =
      resolvedTarget.kind === "object" && patchChildRegions && childRegionTargets.length > 0
        ? [resolvedTarget, ...childRegionTargets]
        : [resolvedTarget];
    if (resolvedTarget.kind === "airbox") {
      const localPatch =
        airboxLocalVisualizationPatchFromTargetPatch(patchValue);
      const statePatch = airboxVisualizationStatePatchFromTargetPatch(
        patchValue,
        displayVisualizationState?.overrides,
      );
      if (Object.keys(localPatch).length > 0) {
        visualization.patchViewportPreferences(resolvedTarget, localPatch);
      }
      if (!hasVisualizationStatePatch(statePatch)) {
        setFeedback(null);
        return;
      }

      visualizationSync.queuePatch(statePatch, [targetKey ?? visualizationTargetKey(resolvedTarget)]);
      visualization.patchTargetPending(
        resolvedTarget,
        persistentVisualizationTargetPatch(patchValue),
        visualizationState.rawData?.revision ?? visualizationState.data?.revision ?? 0,
      );
      setFeedback(null);
      return;
    }

    const remotePatch = persistentVisualizationTargetPatch(patchValue);
    const viewportPreferencesPatch = viewportRenderingPreferencesPatch(patchValue);
    if (Object.keys(viewportPreferencesPatch).length > 0) {
      for (const patchTarget of patchTargets) {
        visualization.patchViewportPreferences(patchTarget, viewportPreferencesPatch);
      }
    }
    if (Object.keys(remotePatch).length > 0) {
      let overrides = displayVisualizationState?.overrides ?? [];
      for (const patchTarget of patchTargets) {
        overrides = mergeVisualizationStateTargetOverride(
          overrides,
          patchTarget,
          remotePatch,
        );
      }
      visualizationSync.queuePatch(
        {
          overrides,
        },
        patchTargets.map((patchTarget) => visualizationTargetKey(patchTarget)),
      );
      // Keep the remote patch locally only until a newer visualization-state
      // revision acknowledges the queued backend transaction.
      for (const patchTarget of patchTargets) {
        visualization.patchTargetPending(
          patchTarget,
          remotePatch,
          visualizationState.rawData?.revision ?? visualizationState.data?.revision ?? 0,
        );
      }
    }
    setFeedback(null);
  }

  async function resetTarget(): Promise<void> {
    if (!resolvedTarget) return;
    if (resolvedTarget.kind === "airbox") {
      visualizationSync.queuePatch(
        resetAirboxVisualizationState(displayVisualizationState ?? { overrides: [] }),
        [visualizationTargetKey(resolvedTarget)],
      );
      visualization.clearTarget(resolvedTarget);
      setFeedback(null);
      return;
    }

    if (!displayVisualizationState) {
      setFeedback("Visualization state is still loading.");
      return;
    }

    visualizationSync.queuePatch(
      {
        overrides: visualizationOverridesForTargetReset(
          displayVisualizationState ?? { overrides: [] },
          resolvedTarget,
        ),
      },
      [visualizationTargetKey(resolvedTarget)],
    );
    visualization.clearTarget(resolvedTarget);
    setFeedback(null);
  }

  async function resetChildRegionTargets(): Promise<void> {
    if (childRegionOverrideCount === 0) return;
    if (!displayVisualizationState) {
      setFeedback("Visualization state is still loading.");
      return;
    }

    visualizationSync.queuePatch(
      {
        overrides: removeOwnerChildRegionVisualizationOverrides({
          objectId: selection.objectId ?? "",
          overrides: displayVisualizationState?.overrides ?? [],
        }),
      },
      childRegionTargets.map((childTarget) => visualizationTargetKey(childTarget)),
    );
    for (const childTarget of childRegionTargets) {
      visualization.clearTarget(childTarget);
    }
    setFeedback(null);
  }

  async function restoreAppliedBaseline(
    baseline: ObjectVisualizationAppliedBaseline,
  ): Promise<void> {
    restoreVisualizationAppliedBaseline({
      baseline,
      currentOverrides: displayVisualizationState?.overrides ?? [],
      queuePatch: (statePatch, targetIds) =>
        visualizationSync.queuePatch(statePatch, targetIds),
      visualization,
    });
    setFeedback(null);
  }

  async function retryRejectedMutation(): Promise<void> {
    if (!mutationStatus.retryable) return;
    await visualizationSync.retryRejectedMutation();
    setFeedback(null);
  }

  function sectionDisabled(
    id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
  ): boolean {
    return sections.find((section) => section.id === id)?.disabled ?? true;
  }

  function patchColor(
    field: "pointColor" | "shaderMonoColor" | "vectorMonoColor" | "wireframeColor",
    value: string,
  ) {
    if (field === "pointColor") {
      void patch({ pointColor: value });
      return;
    }
    if (field === "shaderMonoColor") {
      void executeColorCommand("visualization.target.set-shader-mono-color", value);
      return;
    }
    if (field === "vectorMonoColor") {
      void patch({ vectorMonoColor: value });
      return;
    }
    void executeColorCommand("visualization.target.set-wireframe-color", value);
  }

  async function executeColorCommand(
    commandId:
      | "visualization.target.set-shader-mono-color"
      | "visualization.target.set-wireframe-color",
    value: string,
  ): Promise<void> {
    if (!resolvedTarget) return;
    const result = await kernel.commands.execute(
      commandId,
      createCommandContext("inspector", kernel, {
        resourceData: displayVisualizationState
          ? { [VISUALIZATION_STATE_PATH]: displayVisualizationState }
          : undefined,
        sourceDetail: "ObjectVisualizationPanel",
        visualizationTarget: resolvedTarget,
      }),
      value,
    );
    setFeedback(result.status === "failed" ? result.message ?? "Color update failed." : null);
  }

  function patchNumber(
    field:
      | "vectorAlphaPercent"
      | "vectorBudget"
      | "vectorLengthScale"
      | "vectorSurfaceOffsetScale"
      | "vectorThickness"
      | "wireframeOpacityPercent",
    value: number,
  ) {
    if (field === "vectorAlphaPercent") {
      void patch({ vectorAlphaPercent: value });
      return;
    }
    if (field === "vectorBudget") {
      void patch({ vectorBudget: value });
      return;
    }
    if (field === "vectorLengthScale") {
      void patch({ vectorLengthScale: value });
      return;
    }
    if (field === "vectorSurfaceOffsetScale") {
      void patch({ vectorSurfaceOffsetScale: value });
      return;
    }
    if (field === "vectorThickness") {
      void patch({ vectorThickness: value });
      return;
    }
    void patch({ wireframeOpacityPercent: value });
  }

  // Build arrow visibility rows from carriers of the selected visualization target.
  const vectorMeshParts = (() => {
    if (!resolvedTarget) return undefined;
    const scopedPartRows = resolveSelectedTargetVectorMeshPartRows({
      manifestRegions: manifest.data?.regions,
      meshParts: manifest.data?.mesh_parts,
      sceneObjectIds,
      target: resolvedTarget,
      visualizationState: displayVisualizationState,
    });
    if (scopedPartRows.length <= 1) return undefined;
    return scopedPartRows.map((part) => {
      return {
        ...part,
        vectorsVisible: settings?.vectorsVisible ?? false,
      };
    });
  })();

  const displaySettings =
    renderResolution?.finalSettings ?? effectiveSettings ?? panelSettings;
  const renderWarning = renderResolution?.degradedReasons[0]?.message ?? null;
  const fdmNotice = fdmTarget
    ? fdmVisualizationResourceNotice({
        domain: fdmDomain.data,
        domainError: fdmDomain.error,
        domainStatus: fdmDomain.status,
        membership: fdmMembership.data,
        membershipError: fdmMembership.error,
        membershipStatus: fdmMembership.status,
        membershipBinaryReason:
          "reason" in fdmMembershipBinary.availability
            ? fdmMembershipBinary.availability.reason
            : null,
        membershipBinaryStatus: fdmMembershipBinary.availability.status,
      })
    : null;
  const regionCarrier = resolveRegionVisualizationCarrier({
    manifestRegions: fdmTarget ? null : manifest.data?.regions,
    memberships: fdmTarget ? null : regionMemberships,
    target: fdmTarget ? null : resolvedTarget,
  });
  const nativeLayer =
    resolvedTarget?.kind === "fdm-native-layer"
      ? fdmMultilayerLayout.data?.layers.find(
          (layer) =>
            resolvedTarget.id ===
            `fdm-native-layer:${encodeURIComponent(layer.layer_id)}`,
        )
      : null;
  const nativeLayerCapacity = nativeLayer
    ? {
        activeCellCount: nativeLayer.active_cell_count,
        carrierId: `fdm-native-layer:${encodeURIComponent(nativeLayer.layer_id)}`,
        domainGenerationId:
          nativeLayer.region_membership_generation_id ??
          fdmMultilayerLayout.data?.domain_generation_id ??
          null,
        gridFingerprint: nativeLayer.native_grid_fingerprint ?? null,
        inactiveCellCount: nativeLayer.inactive_cell_count,
        revision:
          nativeLayer.region_membership_revision ??
          fdmMultilayerLayout.data?.layout_revision ??
          null,
        shape: [
          nativeLayer.native_grid[0] ?? 0,
          nativeLayer.native_grid[1] ?? 0,
          nativeLayer.native_grid[2] ?? 0,
        ] as const,
      }
    : null;
  const multilayerAirboxCapacity =
    resolvedTarget?.kind === "airbox" &&
    fdmMultilayerLayout.data?.available &&
    fdmMultilayerLayout.data.airbox?.carrier_available &&
    fdmMultilayerLayout.data.airbox.cells
      ? {
          carrierFingerprint:
            fdmMultilayerLayout.data.airbox.carrier_fingerprint ?? null,
          cellCount:
            fdmMultilayerLayout.data.airbox.cells.reduce(
              (total, value) => total * value,
              1,
            ),
          carrierId: `fdm-multilayer-airbox:${fdmMultilayerLayout.data.airbox.carrier_fingerprint ?? fdmMultilayerLayout.data.layout_fingerprint ?? "unknown"}`,
          domainGenerationId:
            fdmMultilayerLayout.data.domain_generation_id ?? null,
          revision: fdmMultilayerLayout.data.airbox.carrier_revision ?? null,
          shape: [
            fdmMultilayerLayout.data.airbox.cells[0] ?? 0,
            fdmMultilayerLayout.data.airbox.cells[1] ?? 0,
            fdmMultilayerLayout.data.airbox.cells[2] ?? 0,
          ] as const,
        }
      : null;
  const vectorCapacity = resolveVisualizationVectorCapacityForTarget({
    domain: fdmTarget ? fdmDomain.data : null,
    fdmMembership: fdmTarget ? fdmMembership.data : null,
    fdmNativeActiveMask: nativeLayer
      ? fdmMultilayerActiveMasks.data?.masks.get(nativeLayer.layer_id)
          ?.activeMask ?? null
      : null,
    fdmNativeLayer: nativeLayerCapacity,
    fdmRealizedRegionIds: fdmTarget
      ? fdmMembershipBinary.data?.regionIds ?? null
      : null,
    femManifest: fdmTarget ? null : manifest.data,
    multilayerAirbox: multilayerAirboxCapacity,
    target: resolvedTarget,
  });
  const vectorBudgetRanges = {
    full: resolveVisualizationVectorBudgetRange({
      capacity: vectorCapacity,
      geometryScope: "full",
      manifestRegions: fdmTarget ? null : manifest.data?.regions,
      memberships: fdmTarget ? null : regionMemberships,
      meshParts: fdmTarget ? null : manifest.data?.mesh_parts,
      target: resolvedTarget,
    }),
    surface: resolveVisualizationVectorBudgetRange({
      capacity: vectorCapacity,
      geometryScope: "surface",
      manifestRegions: fdmTarget ? null : manifest.data?.regions,
      memberships: fdmTarget ? null : regionMemberships,
      meshParts: fdmTarget ? null : manifest.data?.mesh_parts,
      target: resolvedTarget,
    }),
  } satisfies Record<
    VisualizationGeometryScope,
    VisualizationVectorBudgetRange
  >;
  const vectorBudgetRange =
    vectorBudgetRanges[settings?.geometryScope ?? "full"];
  const vectorSceneCap = resolveVisualizationVectorSceneCap(
    displayVisualizationState,
  );
  function onTogglePartVectors(visible: boolean) {
    if (!resolvedTarget || !displayVisualizationState) return;
    queueTargetVectorVisibilityPatch({
      controller: visualization,
      state: displayVisualizationState,
      sync: visualizationSync,
      target: resolvedTarget,
      visible,
    });
  }

  return {
    appliedBaseline,
    airboxFieldCarrierIdentity,
    displaySettings,
    effectiveSettings,
    feedback,
    fdmTarget,
    fieldCatalog,
    quantityCatalog,
    childRegionOverrideCount,
    childRegionTargets,
    dataState,
    hasTargetOverride,
    onFieldCatalogRequest: () => setFieldCatalogRequestedTargetKey(targetKey),
    onTogglePartVectors,
    passControlsDisabled,
    planarVisualizationState: visualizationState.data?.planar ?? null,
    patch,
    patchChildRegions,
    patchColor,
    patchNumber,
    pending,
    pendingFields,
    mutationError:
      mutationStatus.state === "rejected" ? mutationStatus.error : null,
    mutationStatus,
    childRegionPending,
    retryRejectedMutation,
    renderResolution,
    renderWarning,
    regionCarrier,
    resetChildRegionTargets,
    resetTarget,
    restoreAppliedBaseline,
    revision,
    sectionDisabled,
    settings: panelSettings,
    target: resolvedTarget,
    targetFieldAvailability,
    setPatchChildRegions,
    primitiveDisplayToggleVisible,
    vectorBudgetRange,
    vectorBudgetRanges,
    vectorCapacity,
    vectorSceneCap,
    visualizationResourceRevision,
    vectorMeshParts,
    vectorTopologyHash:
      vectorCapacity?.topologyHash ??
      (fdmTarget ? fdmMembership.data?.grid_fingerprint ?? null : manifest.data?.topology_fingerprint ?? null),
    visualizationBaselineReady,
    fdmNotice,
  } as const;
}

type ObjectVisualizationPanelState = ReturnType<
  typeof useObjectVisualizationPanelState
>;
type ResolvedObjectVisualizationPanelState = Omit<
  ObjectVisualizationPanelState,
  "displaySettings" | "settings" | "target"
> & {
  displaySettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
  target: VisualizationTargetRef;
};

export interface VisualizationInspectorOwner {
  actionSummary: string;
  capabilityDescription: string;
  id: string;
  targetLabel: string;
  title: string;
}

const OBJECT_VISUALIZATION_OWNER: VisualizationInspectorOwner = {
  actionSummary: "Display passes, quantity, vectors, wireframe, and target overrides",
  capabilityDescription:
    "Uses the canonical object visualization target and its resolved FDM or FEM capabilities.",
  id: "object.visualization",
  targetLabel: "Magnetic object",
  title: "Object visualization",
};

export function VisualizationTargetInspectorPanel({
  owner,
  selection,
}: InspectorPanelProps & { owner: VisualizationInspectorOwner }) {
  const panel = useObjectVisualizationPanelState(selection);
  const {
    displaySettings,
    planarVisualizationState,
    settings,
    target,
    visualizationBaselineReady,
  } = panel;
  const resolvedPanel =
    target && settings && displaySettings
      ? ({ ...panel, displaySettings, settings, target } satisfies ResolvedObjectVisualizationPanelState)
      : null;
  const targetId = target
    ? target.kind === "airbox"
      ? "airbox"
      : target.id
    : null;
  const [lastGoodPanel, setLastGoodPanel] = useState<{
    panel: ResolvedObjectVisualizationPanelState;
    revision: string | number | null;
    targetKey: string;
  } | null>(null);
  if (
    visualizationBaselineReady &&
    resolvedPanel &&
    targetId &&
    (lastGoodPanel?.revision !== panel.visualizationResourceRevision ||
      lastGoodPanel.targetKey !== targetId)
  ) {
    setLastGoodPanel((current) =>
      current?.revision === panel.visualizationResourceRevision &&
      current.targetKey === targetId
        ? current
        : {
            panel: resolvedPanel,
            revision: panel.visualizationResourceRevision,
            targetKey: targetId,
          },
    );
  }
  const stablePanel = visualizationBaselineReady
    ? resolvedPanel
    : lastGoodPanel?.targetKey === targetId
      ? lastGoodPanel.panel
      : null;
  const activeSettings = stablePanel?.settings ?? settings;
  const visualizationViewContext = useVisualizationViewContext();
  const { visualizationSync } = useKernel();
  const syncSharedQuiverIntent = useCallback(() => {
    const planar = planarVisualizationState;
    if (!planar) return;
    const presentationPatch = planarPresentationPatchFromThreeDimensional({
      vectorBudget: activeSettings?.vectorBudget ?? planar.resolution.vector_budget,
      vectorColorMode: activeSettings?.vectorColorMode ?? "orientation",
      vectorLengthScale: activeSettings?.vectorLengthScale ?? 1,
    }, planar.resolution, planar.vector_style);
    if (presentationPatch) visualizationSync.queuePatch({ planar: presentationPatch });
  }, [activeSettings?.vectorBudget, activeSettings?.vectorColorMode, activeSettings?.vectorLengthScale, planarVisualizationState, visualizationSync]);
  const scientificInspectorIdentity = (
    <ScientificInspectorIdentity
      methodLabel="Display controls"
      physicalLabel={owner.targetLabel}
      title={owner.title}
    />
  );
  const scientificInspectorContext = (
    <ScientificInspectorContext
      collapsible
      defaultOpen={false}
      properties={[
        { label: "Target scope", value: owner.targetLabel },
        { label: "Capabilities", value: owner.capabilityDescription },
        { label: "Actions", value: owner.actionSummary },
      ]}
      provenance={
        target
          ? [
              { label: "Target ID", mono: true, value: targetId },
              { label: "Target kind", value: target.kind },
            ]
          : []
      }
      status={{
        availability: target ? "available" : "unavailable",
        execution: "interactive",
        resource: target
          ? visualizationBaselineReady
            ? "ready"
            : "loading"
          : "unavailable",
      }}
    />
  );

  if (!target || !stablePanel) {
    return (
      <div className="fm-inspector-panel fm-scientific-inspector" data-inspector-owner={owner.id}>
        {scientificInspectorIdentity}
        <InspectorGroup title="Visualization">
          <FieldRow label="Target" value="No visualization target" />
        </InspectorGroup>
        {scientificInspectorContext}
      </div>
    );
  }

  if (visualizationViewContext === "planar") {
    return (
      <div className="fm-inspector-panel fm-scientific-inspector" data-inspector-owner={owner.id}>
        {scientificInspectorIdentity}
        <InspectorGroup title="View">
          <VisualizationContextSwitchControl onPlanarActivate={syncSharedQuiverIntent} />
        </InspectorGroup>
        <PlanarVisualizationSection selection={selection} />
        {scientificInspectorContext}
      </div>
    );
  }

  return (
    <div className="fm-inspector-panel fm-scientific-inspector" data-inspector-owner={owner.id}>
      {scientificInspectorIdentity}
      <InspectorGroup title="View">
        <VisualizationContextSwitchControl onPlanarActivate={syncSharedQuiverIntent} />
      </InspectorGroup>
      <ObjectVisualizationPanelView
        key={visualizationTargetKey(stablePanel.target)}
        panel={stablePanel}
      />
      {scientificInspectorContext}
    </div>
  );
}

export function ObjectVisualizationPanel({ selection }: InspectorPanelProps) {
  return (
    <VisualizationTargetInspectorPanel
      owner={OBJECT_VISUALIZATION_OWNER}
      selection={selection}
    />
  );
}

function ObjectVisualizationPanelView({
  panel,
}: {
  panel: ResolvedObjectVisualizationPanelState;
}) {
  const {
    appliedBaseline: currentAppliedBaseline,
    airboxFieldCarrierIdentity,
    displaySettings,
    childRegionOverrideCount,
    childRegionTargets,
    dataState,
    feedback,
    fdmNotice,
    fdmTarget,
    fieldCatalog,
    quantityCatalog,
    hasTargetOverride,
    onFieldCatalogRequest,
    onTogglePartVectors,
    passControlsDisabled,
    patch,
    patchChildRegions,
    patchColor,
    patchNumber,
    pending,
    pendingFields,
    childRegionPending,
    mutationError,
    mutationStatus,
    renderResolution,
    renderWarning,
    regionCarrier,
    resetChildRegionTargets,
    resetTarget,
    restoreAppliedBaseline,
    revision,
    sectionDisabled,
    settings,
    setPatchChildRegions,
    target,
    targetFieldAvailability,
    primitiveDisplayToggleVisible,
    vectorBudgetRange,
    vectorBudgetRanges,
    vectorCapacity,
    vectorSceneCap,
    visualizationResourceRevision,
    vectorMeshParts,
    vectorTopologyHash,
  } = panel;
  const [appliedBaseline] = useState<ObjectVisualizationAppliedBaseline>(() =>
    structuredClone(currentAppliedBaseline),
  );
  const isFieldPending: IsVisualizationFieldPending = useCallback(
    (...fields: Array<keyof VisualizationTargetPatch>) =>
      fields.some((field) => pendingFields.has(field)),
    [pendingFields],
  );
  const visualizationDirty = !objectVisualizationAppliedBaselineEquals(
    currentAppliedBaseline,
    appliedBaseline,
  );
  const acceptLiveViewportChanges = useCallback(() => true, []);
  const resetLiveViewportChanges = useCallback(
    () => restoreAppliedBaseline(appliedBaseline),
    [appliedBaseline, restoreAppliedBaseline],
  );
  useRegisterInspectorEditSession(
    "liveViewport",
    pending,
    visualizationDirty,
    true,
    undefined,
    acceptLiveViewportChanges,
    resetLiveViewportChanges,
  );
  const enabledPassCount = [
    displaySettings.boundsVisible,
    displaySettings.shaderVisible,
    displaySettings.wireframeVisible,
    displaySettings.vectorsVisible,
    displaySettings.pointsVisible,
  ].filter(Boolean).length;
  const capabilities = visualizationTargetCapabilities(target);
  const fieldCatalogLoading = fdmTarget && fieldCatalog.status !== "ready";
  const fieldMetaTarget =
    fdmTarget &&
    target.kind !== "airbox" &&
    target.kind !== "fdm-native-layer" &&
    !isFdmUniverseOutsideSupportTarget(target)
      ? { ...target, kind: "fdm-domain" as const }
      : target;
  const meshState = renderResolution?.degradedReasons.length
    ? "Degraded"
    : "Ready";
  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-visualization-revision={revision}
    >
      <ObjectVisualizationOverview
            advanced={
              <p className="m-0 text-fm-help leading-snug text-fm-muted">
                Advanced rendering uses the active viewport quality profile.
              </p>
            }
            camera={
              <p className="m-0 text-fm-help leading-snug text-fm-muted">
                Camera framing follows the active viewport.
              </p>
            }
            clipping={
              <p className="m-0 text-fm-help leading-snug text-fm-muted">
                No clipping plane is configured for this target.
              </p>
            }
            dataState={dataState}
            display={
              <>
                <VisualizationDisplayPassesSection
              displaySettings={displaySettings}
              passControlsDisabled={passControlsDisabled}
              patch={patch}
              isFieldPending={isFieldPending}
              renderWarning={renderWarning}
              settings={settings}
              target={target}
              primitiveDisplayToggleVisible={primitiveDisplayToggleVisible}
                />
                <VisualizationRenderModeSection
              displaySettings={displaySettings}
              passControlsDisabled={passControlsDisabled}
              isFieldPending={isFieldPending}
              patch={patch}
              target={target}
                />
                {capabilities.supportsFieldData &&
                (settings.shaderVisible ||
                  settings.vectorsVisible ||
                  target.kind === "airbox" ||
                  isFdmUniverseOutsideSupportTarget(target)) ? (
                  <VisualizationQuantitySection
                    fieldCatalog={fieldCatalog.data}
                    fieldCatalogLoading={fieldCatalogLoading}
                    quantityCatalog={quantityCatalog.data}
                    targetFieldAvailability={targetFieldAvailability}
                    onFieldCatalogRequest={onFieldCatalogRequest}
                    patch={patch}
                    isFieldPending={isFieldPending}
                    settings={settings}
                    targetKind={
                      target.kind === "airbox" ||
                      isFdmUniverseOutsideSupportTarget(target)
                        ? "airbox"
                        : target.kind
                    }
                  />
                ) : null}
              </>
            }
            enabledPassCount={enabledPassCount}
            meshState={meshState}
            quantitySource={
              capabilities.supportsFieldData
                ? settings.activeQuantityId || "H_eff"
                : "Not available"
            }
            surfaceColoring={!capabilities.supportsFieldData || target.kind === "airbox" || isFdmUniverseOutsideSupportTarget(target) ? null : (
              <VisualizationSurfaceColoringSection
              airboxFieldCarrierIdentity={airboxFieldCarrierIdentity}
              patch={patch}
              patchColor={patchColor}
              isFieldPending={isFieldPending}
              sectionDisabled={sectionDisabled}
              fieldCatalog={fieldCatalog}
              fieldCatalogLoading={fieldCatalogLoading}
              fieldMetaTarget={fieldMetaTarget}
              onFieldCatalogRequest={onFieldCatalogRequest}
              regionCarrier={regionCarrier}
              settings={settings}
              target={target}
              />
            )}
            vectors={capabilities.supportsVectors ? (
              <VisualizationVectorsSection
              airboxFieldCarrierIdentity={airboxFieldCarrierIdentity}
              fieldCatalog={fieldCatalog}
              fieldCatalogLoading={fieldCatalogLoading}
              fieldMetaTarget={fieldMetaTarget}
              meshParts={vectorMeshParts}
              onTogglePartVectors={onTogglePartVectors}
              patch={patch}
              patchColor={patchColor}
              patchNumber={patchNumber}
              isFieldPending={isFieldPending}
              regionCarrier={regionCarrier}
              sectionDisabled={sectionDisabled}
              settings={settings}
              target={target}
              targetKind={target.kind}
              vectorBudgetRange={vectorBudgetRange}
              vectorCapacity={vectorCapacity}
              sceneCap={vectorSceneCap}
              visualizationRevision={visualizationResourceRevision}
              vectorTopologyHash={vectorTopologyHash}
              />
            ) : null}
      />

      {capabilities.supportsPoints && settings.pointsVisible ? (
        <VisualizationPointsSection
            patch={patch}
            patchColor={patchColor}
            isFieldPending={isFieldPending}
            sectionDisabled={sectionDisabled}
            settings={settings}
        />
      ) : null}
      {settings.wireframeVisible ? (
        <VisualizationWireframeSection
            patchColor={patchColor}
            patchNumber={patchNumber}
            isFieldPending={isFieldPending}
            sectionDisabled={sectionDisabled}
            settings={settings}
        />
      ) : null}
      {capabilities.showGeometryScopeControl ? <VisualizationGeometryScopeSection
        passControlsDisabled={passControlsDisabled}
        isFieldPending={isFieldPending}
        patch={patch}
        sceneCap={vectorSceneCap}
        settings={settings}
        vectorBudgetRange={vectorBudgetRange}
        vectorBudgetRanges={vectorBudgetRanges}
      /> : null}
      {renderWarning ? (
        <div className="fm-inspector__diagnostic-warning">{renderWarning}</div>
      ) : null}
      <VisualizationOverridesSection
        childRegionOverrideCount={childRegionOverrideCount}
        childRegionTargets={Math.max(childRegionTargets.length, childRegionOverrideCount)}
        feedback={feedback}
        mutationError={mutationError}
        mutationStatus={mutationStatus.state}
        onReset={() => void resetTarget()}
        onResetChildRegions={() => void resetChildRegionTargets()}
        onRetry={() => void panel.retryRejectedMutation()}
        pending={pending}
        childRegionPending={childRegionPending}
        resetLabel={visualizationResetActionLabel(target.kind)}
      />
      <InspectorGroup collapsible defaultOpen={false} title="Target">
        <FieldRow label="Name" value={displayLabelForVisualizationTarget(target)} />
        <FieldRow label="Target ID" value={target.kind === "airbox" ? "airbox" : target.id} />
        <FieldRow label="Kind" value={target.kind} />
        {target.kind === "fdm-domain" ? (
          <FieldRow label="Geometry" value="Structured grid cells" />
        ) : null}
        {target.kind === "fdm-native-layer" ? (
          <FieldRow label="Geometry" value="Native layer grid cells" />
        ) : null}
        <FieldRow
          label="Override"
          value={visualizationOverrideStateLabel({
            hasOverride: hasTargetOverride,
            targetKind: target.kind,
          })}
        />
        {target.kind === "object" && childRegionTargets.length > 0 ? (
          <>
            <FieldRow
              label="Child overrides"
              value={`${childRegionOverrideCount}/${childRegionTargets.length}`}
            />
            <label className="fm-visualization-part-toggle">
              <input
                checked={patchChildRegions}
                type="checkbox"
                onChange={(event) => setPatchChildRegions(event.target.checked)}
              />
              <span>Apply edits to child regions</span>
            </label>
          </>
        ) : null}
        <FieldRow
          label="Render state"
          value={
            renderResolution?.degradedReasons[0]?.message ??
            (settings.renderMode === "surface+edges"
              ? "Shaded + wireframe"
              : settings.renderMode)
          }
        />
        {fdmNotice ? <FeedbackBanner kind="warning" message={fdmNotice} /> : null}
      </InspectorGroup>
    </div>
  );
}

export { ColorField, VisualizationRadioGroup, VisualizationToggleButton };

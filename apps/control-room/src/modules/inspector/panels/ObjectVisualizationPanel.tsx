"use client";

import React, {
  useCallback,
  useMemo,
  useState,
} from "react";

import { useKernel } from "@/kernel/KernelContext";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  displayLabelForVisualizationTarget,
  hasVisualizationStatePatch,
  isFdmUniverseOutsideSupportTarget,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resolveTargetVisualization,
  resetAirboxVisualizationState,
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
} from "@/kernel/resources/studyRuntimeResources";
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
import { ScientificInspectorTemplate } from "../components/ScientificInspectorTemplate";
import { FieldRow } from "../primitives/FieldRow";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  buildVisualizationPanelSections,
  canonicalVisualizationStateForBaseline,
  resolveVisualizationVectorBudgetRange,
  resolveObjectVisualizationPanelTopologyFreshness,
  resolveObjectChildRegionVisualizationTargets,
  resolveChildRegionOverrideTargetIds,
  removeOwnerChildRegionVisualizationOverrides,
  resolveRegionVisualizationCarrier,
  resolveVisualizationRenderResolution,
  restoreVisualizationAppliedBaseline,
  fdmGridCellCount,
  fdmVisualizationResourceNotice,
  isVisualizationBaselineReady,
  resolveObjectVisualizationLane,
  resolveObjectVisualizationResourceGates,
  resolveObjectVisualizationTargetForLane,
  shouldLoadObjectVisualizationFieldCatalog,
  shouldShowPrimitiveDisplayToggle,
  surfaceSolidColorPatch,
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
} from "./ObjectVisualizationTargetSection";

function useObjectVisualizationPanelState(
  selection: InspectorPanelProps["selection"],
) {
  const selectionTarget = resolveVisualizationTargetFromSelection(selection);
  const { visualizationSync } = useKernel();
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
  const target = resolveObjectVisualizationTargetForLane({
    lane,
    selection,
    selectionTarget,
  });
  const { fdm: fdmResourcesEnabled, fem: femResourcesEnabled } =
    resolveObjectVisualizationResourceGates({ lane, target });
  const fdmTarget = fdmResourcesEnabled && target !== null;
  const visualizationState = useVisualizationStateResource({
    enabled: femResourcesEnabled,
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
  const pending = false;
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
  /* eslint-disable react-hooks/preserve-manual-memoization */
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
  /* eslint-enable react-hooks/preserve-manual-memoization */
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
  const appliedBaseline: ObjectVisualizationAppliedBaseline = {
    overrides: (baselineVisualizationState?.overrides ?? []).filter((entry) =>
      appliedBaselineTargets.some((baselineTarget) =>
        visualizationStateOverrideMatchesTarget(entry, baselineTarget),
      ),
    ),
    targets: appliedBaselineTargets.map((baselineTarget) => {
      const baselineSettings = resolveTargetVisualization({
          snapshot,
          target: baselineTarget,
          visualizationState: baselineVisualizationState,
        }).settings;
      return {
        preferences: structuredClone(
          snapshot.viewportPreferences?.[
            visualizationTargetKey(baselineTarget)
          ] ?? null,
        ),
        settings: baselineSettings,
        target: baselineTarget,
      };
    }),
  };
  const visualizationBaselineReady = isVisualizationBaselineReady({
    femResourcesEnabled,
    target: resolvedTarget,
    visualizationState: visualizationState.data,
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
  const fieldCatalogRequested =
    targetKey !== null && fieldCatalogRequestedTargetKey === targetKey;
  const fieldCatalog = useFieldCatalogResource({
    enabled:
      fdmTarget ||
      shouldLoadObjectVisualizationFieldCatalog({
        requested: fieldCatalogRequested,
        surfaceColorSource: settings?.surfaceColorSource,
        targetActive: Boolean(resolvedTarget),
        vectorsVisible: Boolean(settings?.vectorsVisible),
      }),
  });
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
    pending ||
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

  async function patch(patchValue: VisualizationTargetPatch): Promise<void> {
    if (!resolvedTarget) return;
    if (fdmTarget) {
      const viewportPatch = viewportRenderingPreferencesPatch(patchValue);
      if (Object.keys(viewportPatch).length > 0) {
        visualization.patchViewportPreferences(resolvedTarget, viewportPatch);
      }
      const localPatch = persistentVisualizationTargetPatch(patchValue);
      if (Object.keys(localPatch).length > 0) {
        visualization.patchTarget(resolvedTarget, localPatch);
      }
      setFeedback(null);
      return;
    }
    const patchTargets =
      resolvedTarget.kind === "object" && patchChildRegions && childRegionTargets.length > 0
        ? [resolvedTarget, ...childRegionTargets]
        : [resolvedTarget];
    if (resolvedTarget.kind === "airbox") {
      const localPatch =
        airboxLocalVisualizationPatchFromTargetPatch(patchValue);
      const statePatch = airboxVisualizationStatePatchFromTargetPatch(
        patchValue,
        visualizationState.data?.overrides,
      );
      if (Object.keys(localPatch).length > 0) {
        visualization.patchViewportPreferences(resolvedTarget, localPatch);
      }
      if (!hasVisualizationStatePatch(statePatch)) {
        setFeedback(null);
        return;
      }

      visualizationSync.queuePatch(statePatch);
      visualization.patchTargetPending(
        resolvedTarget,
        persistentVisualizationTargetPatch(patchValue),
        visualizationState.rawData?.revision ?? visualizationState.data?.revision ?? 0,
      );
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      const viewportPreferencesPatch = viewportRenderingPreferencesPatch(patchValue);
      const persistentPatch = persistentVisualizationTargetPatch(patchValue);
      for (const patchTarget of patchTargets) {
        if (Object.keys(viewportPreferencesPatch).length > 0) {
          visualization.patchViewportPreferences(
            patchTarget,
            viewportPreferencesPatch,
          );
        }
        if (Object.keys(persistentPatch).length > 0) {
          visualization.patchTarget(patchTarget, persistentPatch);
        }
      }
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
      let overrides = visualizationState.data.overrides ?? [];
      for (const patchTarget of patchTargets) {
        overrides = mergeVisualizationStateTargetOverride(
          overrides,
          patchTarget,
          remotePatch,
        );
      }
      visualizationSync.queuePatch({
        overrides,
      });
      // Keep the remote patch locally only until a newer visualization-state
      // revision acknowledges the queued backend transaction.
      for (const patchTarget of patchTargets) {
        visualization.patchTargetPending(
          patchTarget,
          remotePatch,
          visualizationState.rawData?.revision ?? visualizationState.data.revision,
        );
      }
    }
    setFeedback(null);
  }

  async function resetTarget(): Promise<void> {
    if (!resolvedTarget) return;
    if (fdmTarget) {
      visualization.clearTarget(resolvedTarget);
      setFeedback(null);
      return;
    }
    if (resolvedTarget.kind === "airbox") {
      visualizationSync.queuePatch(
        resetAirboxVisualizationState(visualizationState.data ?? { overrides: [] }),
      );
      visualization.clearTarget(resolvedTarget);
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      visualization.clearTarget(resolvedTarget);
      return;
    }

    visualizationSync.queuePatch({
      overrides: (visualizationState.data.overrides ?? []).filter(
        (entry) => !visualizationStateOverrideMatchesTarget(entry, resolvedTarget),
      ),
    });
    visualization.clearTarget(resolvedTarget);
    setFeedback(null);
  }

  async function resetChildRegionTargets(): Promise<void> {
    if (childRegionOverrideCount === 0) return;
    if (!visualizationState.data) {
      for (const childTarget of childRegionTargets) {
        visualization.clearTarget(childTarget);
      }
      return;
    }

    visualizationSync.queuePatch({
      overrides: removeOwnerChildRegionVisualizationOverrides({
        objectId: selection.objectId ?? "",
        overrides: visualizationState.data.overrides ?? [],
      }),
    });
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
      currentOverrides: visualizationState.data?.overrides ?? [],
      fdm: fdmTarget,
      queuePatch: (statePatch) => visualizationSync.queuePatch(statePatch),
      visualization,
    });
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
      void patch(surfaceSolidColorPatch(value));
      return;
    }
    if (field === "vectorMonoColor") {
      void patch({ vectorMonoColor: value });
      return;
    }
    void patch({ wireframeColor: value });
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
  const fdmCellCount = fdmTarget ? fdmGridCellCount(fdmDomain.data) : null;
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
  const vectorBudgetRanges = {
    full: resolveVisualizationVectorBudgetRange({
      fdmCellCount,
      geometryScope: "full",
      manifestRegions: manifest.data?.regions,
      memberships: regionMemberships,
      meshParts: manifest.data?.mesh_parts,
      target: resolvedTarget,
    }),
    surface: resolveVisualizationVectorBudgetRange({
      fdmCellCount,
      geometryScope: "surface",
      manifestRegions: manifest.data?.regions,
      memberships: regionMemberships,
      meshParts: manifest.data?.mesh_parts,
      target: resolvedTarget,
    }),
  } satisfies Record<
    VisualizationGeometryScope,
    VisualizationVectorBudgetRange
  >;
  const vectorBudgetRange =
    vectorBudgetRanges[settings?.geometryScope ?? "full"];
  function onTogglePartVectors(visible: boolean) {
    if (!resolvedTarget || !visualizationState.data) return;
    queueTargetVectorVisibilityPatch({
      controller: visualization,
      state: visualizationState.data,
      sync: visualizationSync,
      target: resolvedTarget,
      visible,
    });
  }

  return {
    appliedBaseline,
    displaySettings,
    effectiveSettings,
    feedback,
    fdmTarget,
    fieldCatalog,
    childRegionOverrideCount,
    childRegionTargets,
    hasTargetOverride,
    onFieldCatalogRequest: () => setFieldCatalogRequestedTargetKey(targetKey),
    onTogglePartVectors,
    passControlsDisabled,
    patch,
    patchChildRegions,
    patchColor,
    patchNumber,
    pending,
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
    setPatchChildRegions,
    primitiveDisplayToggleVisible,
    vectorBudgetRange,
    vectorBudgetRanges,
    vectorMeshParts,
    vectorTopologyHash: fdmTarget
      ? fdmMembership.data?.grid_fingerprint ?? null
      : manifest.data?.topology_fingerprint ?? null,
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
  const { displaySettings, settings, target, visualizationBaselineReady } = panel;
  const visualizationViewContext = useVisualizationViewContext();
  const { visualizationSync } = useKernel();
  const planarResource = useVisualizationStateResource();
  const syncSharedQuiverIntent = useCallback(() => {
    const planar = planarResource.data?.planar;
    if (!planar) return;
    const presentationPatch = planarPresentationPatchFromThreeDimensional({
      vectorBudget: settings?.vectorBudget ?? planar.resolution.vector_budget,
      vectorColorMode: settings?.vectorColorMode ?? "orientation",
      vectorLengthScale: settings?.vectorLengthScale ?? 1,
    }, planar.resolution);
    if (presentationPatch) visualizationSync.queuePatch({ planar: presentationPatch });
  }, [planarResource.data?.planar, settings?.vectorBudget, settings?.vectorColorMode, settings?.vectorLengthScale, visualizationSync]);

  const targetId = target
    ? target.kind === "airbox"
      ? "airbox"
      : target.id
    : null;
  const scientificInspector = (
    <ScientificInspectorTemplate
      methodLabel="Display controls"
      physicalLabel={owner.targetLabel}
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
      title={owner.title}
    />
  );

  if (!target || !settings || !displaySettings) {
    return (
      <div className="fm-inspector-panel" data-inspector-owner={owner.id}>
        {scientificInspector}
        <InspectorGroup title="Visualization">
          <FieldRow label="Target" value="No visualization target" />
        </InspectorGroup>
      </div>
    );
  }

  if (!visualizationBaselineReady) {
    return (
      <div className="fm-inspector-panel" data-inspector-owner={owner.id}>
        {scientificInspector}
        <InspectorGroup title="View">
          <FieldRow label="Target" value={displayLabelForVisualizationTarget(target)} />
          <FieldRow label="State" value="Loading applied visualization state" />
        </InspectorGroup>
      </div>
    );
  }

  if (visualizationViewContext === "planar") {
    return (
      <div className="fm-inspector-panel" data-inspector-owner={owner.id}>
        {scientificInspector}
        <InspectorGroup title="View">
          <VisualizationContextSwitchControl onPlanarActivate={syncSharedQuiverIntent} />
        </InspectorGroup>
        <PlanarVisualizationSection selection={selection} />
      </div>
    );
  }

  return (
    <div className="fm-inspector-panel" data-inspector-owner={owner.id}>
      {scientificInspector}
      <InspectorGroup title="View">
        <VisualizationContextSwitchControl onPlanarActivate={syncSharedQuiverIntent} />
      </InspectorGroup>
      <ObjectVisualizationPanelView
        key={visualizationTargetKey(target)}
        panel={{ ...panel, displaySettings, settings, target }}
      />
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
    displaySettings,
    childRegionOverrideCount,
    childRegionTargets,
    feedback,
    fdmNotice,
    fdmTarget,
    fieldCatalog,
    hasTargetOverride,
    onFieldCatalogRequest,
    onTogglePartVectors,
    passControlsDisabled,
    patch,
    patchChildRegions,
    patchColor,
    patchNumber,
    pending,
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
    primitiveDisplayToggleVisible,
    vectorBudgetRange,
    vectorBudgetRanges,
    vectorMeshParts,
    vectorTopologyHash,
  } = panel;
  const [appliedBaseline] = useState<ObjectVisualizationAppliedBaseline>(() =>
    structuredClone(currentAppliedBaseline),
  );
  const visualizationDirty =
    JSON.stringify(currentAppliedBaseline) !== JSON.stringify(appliedBaseline);
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
  const requiresFieldData =
    capabilities.supportsFieldData &&
    (displaySettings.vectorsVisible ||
      (displaySettings.shaderVisible && settings.surfaceColorSource !== "solid"));
  const dataState =
    !capabilities.supportsFieldData
      ? "Not available"
      : !requiresFieldData
      ? "Not required"
      : fieldCatalog.status === "ready"
        ? "Live"
        : fieldCatalog.status;

  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-visualization-revision={revision}
    >
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
              pending={pending}
              renderWarning={renderWarning}
              settings={settings}
              target={target}
              primitiveDisplayToggleVisible={primitiveDisplayToggleVisible}
                />
                <VisualizationRenderModeSection
              displaySettings={displaySettings}
              passControlsDisabled={passControlsDisabled}
              pending={pending}
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
                    onFieldCatalogRequest={onFieldCatalogRequest}
                    patch={patch}
                    pending={pending}
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
              patch={patch}
              patchColor={patchColor}
              pending={pending}
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
              fieldCatalog={fieldCatalog}
              fieldCatalogLoading={fieldCatalogLoading}
              fieldMetaTarget={fieldMetaTarget}
              meshParts={vectorMeshParts}
              onTogglePartVectors={onTogglePartVectors}
              patch={patch}
              patchColor={patchColor}
              patchNumber={patchNumber}
              pending={pending}
              regionCarrier={regionCarrier}
              sectionDisabled={sectionDisabled}
              settings={settings}
              target={target}
              targetKind={target.kind}
              vectorBudgetRange={vectorBudgetRange}
              vectorTopologyHash={vectorTopologyHash}
              />
            ) : null}
      />

      {capabilities.supportsPoints && settings.pointsVisible ? (
        <VisualizationPointsSection
            patch={patch}
            patchColor={patchColor}
            pending={pending}
            sectionDisabled={sectionDisabled}
            settings={settings}
        />
      ) : null}
      {settings.wireframeVisible ? (
        <VisualizationWireframeSection
            patchColor={patchColor}
            patchNumber={patchNumber}
            pending={pending}
            sectionDisabled={sectionDisabled}
            settings={settings}
        />
      ) : null}
      {capabilities.showGeometryScopeControl ? <VisualizationGeometryScopeSection
        passControlsDisabled={passControlsDisabled}
        pending={pending}
        patch={patch}
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
        onReset={() => void resetTarget()}
        onResetChildRegions={() => void resetChildRegionTargets()}
        pending={pending}
        resetLabel={visualizationResetActionLabel(target.kind)}
      />
    </div>
  );
}

export { ColorField, VisualizationRadioGroup, VisualizationToggleButton };

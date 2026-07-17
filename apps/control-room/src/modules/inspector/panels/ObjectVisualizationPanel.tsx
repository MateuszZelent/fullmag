"use client";

import { Info, RotateCcw } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  FieldCatalogResource,
  FieldMetaResource,
  LiveStatusResource,
} from "@/kernel/api/apiTypes";
import { quantityUnitForColorbar } from "@/kernel/api/quantityIds";
import { useKernel } from "@/kernel/KernelContext";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  displayLabelForVisualizationTarget,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resolveTargetVisualization,
  resetAirboxVisualizationState,
  resolveVisualizationTargetFromSelection,
  visualizationStateOverrideMatchesTarget,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
  type SurfaceColorSource,
  type VisualizationStoredTargetPatch,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  shouldLoadRuntimeMeshManifest,
  useFieldCatalogResource,
  useFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import {
  useVisualizationStateResource,
} from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import {
  useMeshSharedDomainManifestResource,
  useMeshRegionMembershipsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  isVisualizationAirboxIdentity,
  visualizationTargetIdForSceneObject,
} from "@/kernel/selection/selectionTypes";
import { visualizationSceneObjectIds } from "@/kernel/selection/visualizationTargetResolver";
import { useLayoutSelector } from "@/kernel/layout/useLayout";
import { manifestRenderableCarriers } from "@/modules/viewport-3d/public";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildAirboxVectorDiagnostic,
  buildAirboxVisibilityDiagnostic,
  buildVisualizationPanelSections,
  colorPickerInputValue,
  displayPassTogglePatch,
  fieldMetaScopeQueryForVisualizationTarget,
  formatScalarColorbarValueWithDisplayUnit,
  geometryScopeVectorBudgetPatch,
  resolveVisualizationVectorBudgetRange,
  resolveObjectVisualizationPanelTopologyFreshness,
  resolveObjectChildRegionVisualizationTargets,
  resolveChildRegionOverrideTargetIds,
  removeOwnerChildRegionVisualizationOverrides,
  resolveRegionVisualizationCarrier,
  resolveVisualizationRenderResolution,
  resolveSurfaceColorSourceItems,
  scalarColorPaletteGradientCss,
  scalarColorPalettePatch,
  scalarColorbarDisplayUnitItems,
  scalarColorbarSupportsDisplayUnits,
  SCALAR_COLOR_PALETTE_ITEMS,
  shouldShowPrimitiveDisplayToggle,
  shouldLoadObjectVisualizationFieldCatalog,
  shouldShowSurfaceFieldColorbar,
  SURFACE_FIELD_PROJECTION_ITEMS,
  surfaceFieldProjectionModePatch,
  surfaceColorSourceFieldMetaComponent,
  geometryScopeDisplayPatch,
  quantitySourcePatch,
  queueTargetVectorVisibilityPatch,
  resolveObjectVisualizationPanelTarget,
  resolveSelectedTargetVectorMeshPartRows,
  resolveObjectVisualizationPanelSelectionTarget,
  regionVisualizationCarrierSupportsFieldMeta,
  regionVisualizationFieldWarning,
  renderModeDisplayPatch,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  visualizationOverrideStateLabel,
  VISUALIZATION_COLOR_MODE_ITEMS,
  type VisualizationVectorBudgetRange,
  type RegionVisualizationCarrier,
  visualizationQuantityItems,
  visualizationResetActionLabel,
  parseRegionVisualizationTargetId,
  type ScalarColorbarDisplayUnit,
} from "./ObjectVisualizationPanelModel";
import { VisualizationVectorAccountingRows } from "./VisualizationVectorAccountingRows";
import {
  nextVisualizationRadioValue,
  visualizationSectionDisabledDescription,
} from "./ObjectVisualizationPanelAccessibility";
import {
  selectObjectVisualizationManifestStatus,
  objectVisualizationManifestStatusEquals,
  selectObjectVisualizationPanelSnapshot,
  objectVisualizationPanelSnapshotEquals,
  viewportRenderingPreferencesPatch,
} from "./ObjectVisualizationHelpers";
import {
  VisualizationDisplayPassesSection,
  VisualizationRenderModeSection,
  VisualizationSurfaceColoringSection,
  VisualizationQuantitySection,
  VisualizationPointsSection,
  VisualizationWireframeSection,
  VisualizationVectorsSection,
  VisualizationGeometryScopeSection,
  VisualizationOpacitySection,
  VisualizationOverridesSection,
  ViewportPreferenceScopeNote,
  ColorField,
  NumberField,
  VisualizationToggleButton,
  VisualizationRadioGroup,
} from "./ObjectVisualizationTargetSection";

const ToggleButton = VisualizationToggleButton;

const RENDER_MODES: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { label: "Shaded", value: "surface" },
  { label: "Shaded + wireframe", value: "surface+edges" },
  { label: "Wire", value: "wireframe" },
  { label: "Points", value: "points" },
];

const GEOMETRY_SCOPES: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
];

const OBJECT_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  "object",
  "part",
  "region",
];

function visualizationTargetPatchEquals(
  previous: VisualizationStoredTargetPatch | undefined,
  next: VisualizationStoredTargetPatch | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof VisualizationStoredTargetPatch>);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      return false;
    }
  }

  return true;
}

function surfaceFieldStatus(
  source: SurfaceColorSource,
  fieldCatalog: FieldCatalogResource | null | undefined,
  fetchStatus: string,
): string {
  if (source === "solid") return "not required";
  const revision =
    fieldCatalog?.quantities.reduce(
      (latest, quantity) =>
        quantity.available ? Math.max(latest, quantity.field_revision) : latest,
      0,
    ) ?? 0;
  if (revision > 0) {
    return `available r${revision}`;
  }
  return fetchStatus === "ready" ? "none" : fetchStatus;
}

type PatchVisualizationTarget = (patchValue: VisualizationTargetPatch) => Promise<void>;
type SectionDisabled = (
  id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
) => boolean;

const SCALAR_COLORBAR_RANGE_CACHE_MAX = 32;
const scalarColorbarRangeCache = new Map<string, FieldMetaResource>();
const scalarColorbarRangeListeners = new Set<() => void>();

function subscribeScalarColorbarRangeCache(listener: () => void): () => void {
  scalarColorbarRangeListeners.add(listener);
  return () => {
    scalarColorbarRangeListeners.delete(listener);
  };
}

function rememberScalarColorbarRange(
  identity: string,
  data: FieldMetaResource,
): void {
  scalarColorbarRangeCache.delete(identity);
  scalarColorbarRangeCache.set(identity, data);
  while (scalarColorbarRangeCache.size > SCALAR_COLORBAR_RANGE_CACHE_MAX) {
    const oldest = scalarColorbarRangeCache.keys().next().value;
    if (!oldest) break;
    scalarColorbarRangeCache.delete(oldest);
  }
  for (const listener of scalarColorbarRangeListeners) {
    listener();
  }
}

function useScalarColorbarRangeCache(
  identity: string,
): FieldMetaResource | null {
  return useSyncExternalStore(
    subscribeScalarColorbarRangeCache,
    () => scalarColorbarRangeCache.get(identity) ?? null,
    () => null,
  );
}

function useObjectVisualizationPanelState(
  selection: InspectorPanelProps["selection"],
) {
  const target = resolveVisualizationTargetFromSelection(selection);
  const { visualizationSync } = useKernel();
  const visualization = useObjectVisualizationController();
  const activeModuleTab = useLayoutSelector((layout) => layout.activeModuleTab);
  const visualizationState = useVisualizationStateResource();
  const manifestStatus = useSessionStatusSelector(
    selectObjectVisualizationManifestStatus,
    {
      enabled: Boolean(target),
      isEqual: objectVisualizationManifestStatusEquals,
    },
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [patchChildRegions, setPatchChildRegions] = useState(false);
  const [fieldCatalogRequestedTargetKey, setFieldCatalogRequestedTargetKey] =
    useState<string | null>(null);
  const pending = false;
  const scene = useSceneResource({ enabled: Boolean(target) });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(Boolean(target), manifestStatus),
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
  const airboxPartIds =
    manifest.data?.mesh_parts?.flatMap((part) =>
      isVisualizationAirboxIdentity(part) ? [part.id] : [],
    ) ?? [];
  const regionId = useMemo(() => {
    if (resolvedTarget?.kind !== "region") return null;
    const parsed = parseRegionVisualizationTargetId(resolvedTarget.id);
    return parsed?.regionId ?? null;
  }, [resolvedTarget]);
  const regionMemberships = useMeshRegionMembershipsResource(
    regionId ? [regionId] : [],
    { enabled: Boolean(regionId) }
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
          visualizationState: visualizationState.data,
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
    visualizationState.data,
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
          visualizationState: visualizationState.data,
        }).settings
      : undefined;
  const targetVisualization = resolvedTarget
    ? resolveTargetVisualization({
        inheritedSettings,
        snapshot,
        target: resolvedTarget,
        visualizationState: visualizationState.data,
      })
    : null;
  const settings = targetVisualization?.settings ?? null;
  const effectiveSettings = targetVisualization?.effectiveSettings ?? null;
  const hasTargetOverride = Boolean(targetVisualization?.override);
  const childRegionOverrideCount = resolveChildRegionOverrideTargetIds({
    backendOverrides: visualizationState.data?.overrides ?? [],
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
    enabled: shouldLoadObjectVisualizationFieldCatalog({
      requested: fieldCatalogRequested,
      surfaceColorSource: settings?.surfaceColorSource,
      targetActive: Boolean(resolvedTarget),
      vectorsVisible: Boolean(settings?.vectorsVisible),
    }),
  });
  const vectorDomain = visualizationState.data?.layers?.vectors?.domain ?? "auto";
  const topologyFreshness = resolvedTarget
    ? resolveObjectVisualizationPanelTopologyFreshness({
        manifest: manifest.data,
        scene: scene.data,
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
      })
    : [];
  const passControlsDisabled = pending || !settings?.visible;
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
      visualizationState: visualizationState.data,
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
  const regionCarrier = resolveRegionVisualizationCarrier({
    manifestRegions: manifest.data?.regions,
    memberships: regionMemberships.data,
    target: resolvedTarget,
  });
  const vectorBudgetRanges = {
    full: resolveVisualizationVectorBudgetRange({
      geometryScope: "full",
      manifestRegions: manifest.data?.regions,
      memberships: regionMemberships.data,
      meshParts: manifest.data?.mesh_parts,
      target: resolvedTarget,
    }),
    surface: resolveVisualizationVectorBudgetRange({
      geometryScope: "surface",
      manifestRegions: manifest.data?.regions,
      memberships: regionMemberships.data,
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
    displaySettings,
    effectiveSettings,
    airboxPartIds,
    feedback,
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
    revision,
    sectionDisabled,
    settings: panelSettings,
    target: resolvedTarget,
    setPatchChildRegions,
    primitiveDisplayToggleVisible,
    vectorDomain,
    vectorBudgetRange,
    vectorBudgetRanges,
    vectorMeshParts,
    vectorTopologyHash: manifest.data?.topology_fingerprint ?? null,
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

export function ObjectVisualizationPanel({ selection }: InspectorPanelProps) {
  const panel = useObjectVisualizationPanelState(selection);
  const { displaySettings, settings, target } = panel;

  if (!target || !settings || !displaySettings) {
    return (
      <div className="fm-inspector-panel">
        <InspectorSection title="Visualization">
          <FieldRow label="Target" value="No visualization target" />
        </InspectorSection>
      </div>
    );
  }

  return (
    <ObjectVisualizationPanelView
      panel={{ ...panel, displaySettings, settings, target }}
    />
  );
}

function ObjectVisualizationPanelView({
  panel,
}: {
  panel: ResolvedObjectVisualizationPanelState;
}) {
  const {
    displaySettings,
    airboxPartIds,
    childRegionOverrideCount,
    childRegionTargets,
    feedback,
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
    revision,
    sectionDisabled,
    settings,
    setPatchChildRegions,
    target,
    primitiveDisplayToggleVisible,
    vectorDomain,
    vectorBudgetRange,
    vectorBudgetRanges,
    vectorMeshParts,
    vectorTopologyHash,
  } = panel;

  return (
    <div className="fm-inspector-panel" data-visualization-revision={revision}>
      <InspectorSection title="Visualization Target">
        <FieldRow label="Name" value={displayLabelForVisualizationTarget(target)} />
        <FieldRow label="Target ID" value={target.kind === "airbox" ? "airbox" : target.id} />
        <FieldRow label="Kind" value={target.kind} />
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
      </InspectorSection>
      <VisualizationDisplayPassesSection
        airboxPartIds={airboxPartIds}
        displaySettings={displaySettings}
        fieldCatalog={fieldCatalog}
        onFieldCatalogRequest={onFieldCatalogRequest}
        passControlsDisabled={passControlsDisabled}
        patch={patch}
        pending={pending}
        renderWarning={renderWarning}
        settings={settings}
        targetKind={target.kind}
        primitiveDisplayToggleVisible={primitiveDisplayToggleVisible}
        vectorDomain={vectorDomain}
      />

      <VisualizationRenderModeSection
        displaySettings={displaySettings}
        passControlsDisabled={passControlsDisabled}
        pending={pending}
        patch={patch}
      />
      <VisualizationQuantitySection
        onFieldCatalogRequest={onFieldCatalogRequest}
        patch={patch}
        pending={pending}
        settings={settings}
        targetKind={target.kind}
      />
      <VisualizationSurfaceColoringSection
        patch={patch}
        patchColor={patchColor}
        pending={pending}
        sectionDisabled={sectionDisabled}
        fieldCatalog={fieldCatalog}
        onFieldCatalogRequest={onFieldCatalogRequest}
        regionCarrier={regionCarrier}
        settings={settings}
        target={target}
      />
      <VisualizationPointsSection
        patchColor={patchColor}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
      />
      <VisualizationWireframeSection
        patchColor={patchColor}
        patchNumber={patchNumber}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
      />
      <VisualizationVectorsSection
        meshParts={vectorMeshParts}
        onTogglePartVectors={onTogglePartVectors}
        patch={patch}
        patchColor={patchColor}
        patchNumber={patchNumber}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
        targetKind={target.kind}
        vectorBudgetRange={vectorBudgetRange}
        vectorBudgetRanges={vectorBudgetRanges}
        vectorTopologyHash={vectorTopologyHash}
      />
      <VisualizationGeometryScopeSection
        passControlsDisabled={passControlsDisabled}
        pending={pending}
        patch={patch}
        settings={settings}
        vectorBudgetRange={vectorBudgetRange}
        vectorBudgetRanges={vectorBudgetRanges}
      />
      <VisualizationOpacitySection patch={patch} settings={settings} />
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

"use client";

import { Info, RotateCcw } from "lucide-react";
import React, {
  useCallback,
  useEffect,
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
  resolveTargetVisualization,
  resetAirboxVisualizationState,
  resolveVisualizationTargetFromSelection,
  visualizationStateOverrideMatchesTarget,
  visualizationTargetKey,
  type LocalRenderingTargetPatch,
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
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { visualizationSceneObjectIds } from "@/kernel/selection/visualizationTargetResolver";
import { useLayoutSelector } from "@/kernel/layout/useLayout";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildAirboxVectorDiagnostic,
  buildAirboxVisibilityDiagnostic,
  buildVisualizationVectorBudgetDiagnostic,
  buildVisualizationPanelSections,
  colorPickerInputValue,
  displayPassTogglePatch,
  fieldMetaScopeQueryForVisualizationTarget,
  formatScalarColorbarValueWithDisplayUnit,
  geometryScopeVectorBudgetPatch,
  resolveVisualizationVectorBudgetRange,
  resolveObjectVisualizationPanelTopologyFreshness,
  resolveObjectChildRegionVisualizationTargets,
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
  queuePartVectorVisibilityPatch,
  resolveObjectVisualizationPanelTarget,
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
import { formatCount } from "./MeshResourceView";

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

type ObjectVisualizationManifestStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<LiveStatusResource["resources"], "mesh_revision">;
};

function selectObjectVisualizationManifestStatus(status: {
  data: LiveStatusResource | null;
}): ObjectVisualizationManifestStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_revision: status.data.resources.mesh_revision,
    },
  };
}

function objectVisualizationManifestStatusEquals(
  previous: ObjectVisualizationManifestStatus | null,
  next: ObjectVisualizationManifestStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_revision === next.resources.mesh_revision
  );
}

const OBJECT_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  "object",
  "part",
  "region",
];

function selectObjectVisualizationPanelSnapshot(
  snapshot: ObjectVisualizationSnapshot,
  targets: readonly VisualizationTargetRef[],
): ObjectVisualizationSnapshot {
  const defaults: ObjectVisualizationSnapshot["defaults"] = {};
  const localRenderOverrides: NonNullable<
    ObjectVisualizationSnapshot["localRenderOverrides"]
  > = {};
  const overrides: ObjectVisualizationSnapshot["overrides"] = {};
  const pendingOverrides: NonNullable<
    ObjectVisualizationSnapshot["pendingOverrides"]
  > = {};

  for (const target of targets) {
    const defaultPatch = snapshot.defaults[target.kind];
    if (defaultPatch) {
      defaults[target.kind] = defaultPatch;
    }

    const override = snapshot.overrides[visualizationTargetKey(target)];
    if (override) {
      overrides[visualizationTargetKey(target)] = override;
    }
    const localRenderOverride = snapshot.localRenderOverrides?.[
      visualizationTargetKey(target)
    ];
    if (localRenderOverride) {
      localRenderOverrides[visualizationTargetKey(target)] = localRenderOverride;
    }
    const pendingOverride = snapshot.pendingOverrides?.[
      visualizationTargetKey(target)
    ];
    if (pendingOverride) {
      pendingOverrides[visualizationTargetKey(target)] = pendingOverride;
    }
  }

  return {
    defaults,
    localRenderOverrides,
    overrides,
    pendingOverrides,
    version: snapshot.version,
  };
}

function objectVisualizationPanelSnapshotEquals(
  previous: ObjectVisualizationSnapshot,
  next: ObjectVisualizationSnapshot,
): boolean {
  for (const kind of OBJECT_VISUALIZATION_TARGET_KINDS) {
    if (!visualizationTargetPatchEquals(previous.defaults[kind], next.defaults[kind])) {
      return false;
    }
  }

  const overrideKeys = new Set([
    ...Object.keys(previous.overrides),
    ...Object.keys(next.overrides),
  ]);
  for (const key of overrideKeys) {
    if (!visualizationTargetPatchEquals(previous.overrides[key], next.overrides[key])) {
      return false;
    }
  }

  const localRenderOverrideKeys = new Set([
    ...Object.keys(previous.localRenderOverrides ?? {}),
    ...Object.keys(next.localRenderOverrides ?? {}),
  ]);
  for (const key of localRenderOverrideKeys) {
    if (
      !visualizationTargetPatchEquals(
        previous.localRenderOverrides?.[key],
        next.localRenderOverrides?.[key],
      )
    ) {
      return false;
    }
  }

  const pendingOverrideKeys = new Set([
    ...Object.keys(previous.pendingOverrides ?? {}),
    ...Object.keys(next.pendingOverrides ?? {}),
  ]);
  for (const key of pendingOverrideKeys) {
    const previousPending = previous.pendingOverrides?.[key];
    const nextPending = next.pendingOverrides?.[key];
    if (
      previousPending?.baseRevision !== nextPending?.baseRevision ||
      !visualizationTargetPatchEquals(previousPending?.patch, nextPending?.patch)
    ) {
      return false;
    }
  }

  return true;
}

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

function remoteVisualizationTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  const remotePatch = { ...patch };
  delete remotePatch.airboxSyntheticVectorsEnabled;
  delete remotePatch.vectorCenteringEnabled;
  delete remotePatch.vectorSurfaceOffsetEnabled;
  delete remotePatch.vectorSurfaceOffsetScale;
  delete remotePatch.primitiveVisible;
  return remotePatch;
}

function localRenderingTargetPatch(
  patch: VisualizationTargetPatch,
): LocalRenderingTargetPatch {
  return {
    ...(patch.primitiveVisible === undefined
      ? {}
      : { primitiveVisible: patch.primitiveVisible }),
    ...(patch.vectorCenteringEnabled === undefined
      ? {}
      : { vectorCenteringEnabled: patch.vectorCenteringEnabled }),
    ...(patch.vectorSurfaceOffsetEnabled === undefined
      ? {}
      : { vectorSurfaceOffsetEnabled: patch.vectorSurfaceOffsetEnabled }),
    ...(patch.vectorSurfaceOffsetScale === undefined
      ? {}
      : { vectorSurfaceOffsetScale: patch.vectorSurfaceOffsetScale }),
  };
}

function VisualizationDisplayPassesSection({
  airboxPartIds,
  displaySettings,
  fieldCatalog,
  onFieldCatalogRequest,
  passControlsDisabled,
  patch,
  pending,
  renderWarning,
  settings,
  targetKind,
  primitiveDisplayToggleVisible,
  vectorDomain,
}: {
  airboxPartIds: readonly string[];
  displaySettings: VisualizationTargetSettings;
  fieldCatalog: ReturnType<typeof useFieldCatalogResource>;
  onFieldCatalogRequest: () => void;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  pending: boolean;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
  targetKind: VisualizationTargetKind;
  primitiveDisplayToggleVisible: boolean;
  vectorDomain: string;
}) {
  const [airboxDiagnosticOpen, setAirboxDiagnosticOpen] = useState(false);
  const airboxDiagnostic =
    targetKind === "airbox"
      ? buildAirboxVisibilityDiagnostic({
          displaySettings,
          renderWarning,
          settings,
        })
      : null;
  const airboxVectorDiagnostic =
    targetKind === "airbox"
      ? buildAirboxVectorDiagnostic({
          airboxPartIds,
          displaySettings,
          fieldCatalog: fieldCatalog.data,
          fieldCatalogStatus: fieldCatalog.status,
          renderWarning,
          settings,
          vectorDomain,
        })
      : null;

  function handleVisibleClick(): void {
    const nextVisible = !settings.visible;
    void patch({ visible: nextVisible });
    if (targetKind === "airbox" && nextVisible) {
      setAirboxDiagnosticOpen(true);
    } else if (targetKind === "airbox") {
      setAirboxDiagnosticOpen(false);
    }
  }

  function handleDiagnosticClick(): void {
    onFieldCatalogRequest();
    setAirboxDiagnosticOpen(true);
  }

  return (
    <InspectorSection title="Display Passes">
      {renderWarning ? (
        <FeedbackBanner kind="warning" message={renderWarning} />
      ) : null}
      <div className="fm-visualization-toggle-grid">
        {targetKind === "airbox" ? (
          <Button
            aria-label="Airbox visualization diagnostics"
            className="fm-visualization-toggle"
            size="sm"
            title="Airbox visualization diagnostics"
            type="button"
            variant="secondary"
            onClick={handleDiagnosticClick}
          >
            <Info size={14} />
          </Button>
        ) : null}
        <ToggleButton
          active={displaySettings.visible}
          disabled={pending}
          label="Visible"
          onClick={handleVisibleClick}
        />
        <ToggleButton active={displaySettings.shaderVisible} disabled={passControlsDisabled} label="Surface" onClick={() => void patch(surfaceDisplayPassPatch(settings))} />
        <ToggleButton active={displaySettings.wireframeVisible} disabled={passControlsDisabled} label="Wireframe" onClick={() => void patch(displayPassTogglePatch(settings, "wireframeVisible"))} />
        <ToggleButton active={displaySettings.boundsVisible} disabled={passControlsDisabled} label="Frame" onClick={() => void patch(displayPassTogglePatch(settings, "boundsVisible"))} />
        <ToggleButton active={displaySettings.pointsVisible} disabled={passControlsDisabled} label="Points" onClick={() => void patch(displayPassTogglePatch(settings, "pointsVisible"))} />
        <ToggleButton active={displaySettings.vectorsVisible} disabled={passControlsDisabled} label="Vectors" onClick={() => void patch(displayPassTogglePatch(settings, "vectorsVisible"))} />
        {primitiveDisplayToggleVisible ? (
          <ToggleButton
            active={Boolean(displaySettings.primitiveVisible)}
            disabled={passControlsDisabled}
            label="Primitive"
            onClick={() =>
              void patch(displayPassTogglePatch(settings, "primitiveVisible"))
            }
          />
        ) : null}
      </div>
      <Dialog
        open={
          airboxDiagnosticOpen &&
          (airboxDiagnostic !== null || airboxVectorDiagnostic !== null)
        }
        onOpenChange={setAirboxDiagnosticOpen}
      >
        <DialogContent aria-describedby="fm-airbox-diagnostic-description">
          <DialogHeader>
            <DialogTitle>
              Airbox visualization diagnostic
            </DialogTitle>
            <DialogDescription id="fm-airbox-diagnostic-description">
              {airboxVectorDiagnostic?.message ??
                airboxDiagnostic?.message ??
                "Airbox visibility state is not available."}
            </DialogDescription>
          </DialogHeader>
          <div>
            {airboxVectorDiagnostic ? (
              <>
                <FieldRow label="Vector status" value={airboxVectorDiagnostic.title} />
                {airboxVectorDiagnostic.details.map((detail) => (
                  <FieldRow
                    key={`vector:${detail.label}`}
                    label={detail.label}
                    value={detail.value}
                  />
                ))}
              </>
            ) : null}
            {airboxDiagnostic ? (
              <FieldRow label="Visibility status" value={airboxDiagnostic.title} />
            ) : null}
            {airboxDiagnostic?.details.map((detail) => (
              <FieldRow
                key={`visibility:${detail.label}`}
                label={detail.label}
                value={detail.value}
              />
            ))}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm" type="button" variant="secondary">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </InspectorSection>
  );
}

function VisualizationRenderModeSection({
  displaySettings,
  passControlsDisabled,
  patch,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
}) {
  return (
    <InspectorSection title="Render Mode">
      <fieldset className="fm-visualization-segments" aria-label="Render mode">
        {RENDER_MODES.map((mode) => (
          <Button
            key={mode.value}
            size="sm"
            type="button"
            disabled={passControlsDisabled}
            variant={displaySettings.visible && displaySettings.renderMode === mode.value ? "primary" : "secondary"}
            onClick={() => void patch(renderModeDisplayPatch(mode.value))}
          >
            {mode.label}
          </Button>
        ))}
      </fieldset>
    </InspectorSection>
  );
}

function VisualizationSurfaceColoringSection({
  patch,
  patchColor,
  pending,
  sectionDisabled,
  fieldCatalog,
  onFieldCatalogRequest,
  regionCarrier,
  settings,
  target,
}: {
  patch: PatchVisualizationTarget;
  patchColor: (
    field: "pointColor" | "shaderMonoColor" | "vectorMonoColor" | "wireframeColor",
    value: string,
  ) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  fieldCatalog: ReturnType<typeof useFieldCatalogResource>;
  onFieldCatalogRequest: () => void;
  regionCarrier?: RegionVisualizationCarrier | null;
  settings: VisualizationTargetSettings;
  target: VisualizationTargetRef;
}) {
  const colorbarComponent = surfaceColorSourceFieldMetaComponent(
    settings.surfaceColorSource,
    settings.activeQuantityId,
  );
  const showColorbar = shouldShowSurfaceFieldColorbar(
    settings.surfaceColorSource,
    settings.activeQuantityId,
  );
  const fieldMetaScopeQuery = fieldMetaScopeQueryForVisualizationTarget(
    target,
    regionCarrier,
  );
  const regionFieldWarning =
    target.kind === "region" ? regionVisualizationFieldWarning(regionCarrier) : null;
  const regionFieldMetaUnavailable =
    target.kind === "region" &&
    !regionVisualizationCarrierSupportsFieldMeta(regionCarrier);
  const colorbarRangeIdentity = [
    settings.activeQuantityId,
    colorbarComponent ?? "none",
    fieldMetaScopeQuery.scope_kind ?? "full",
    fieldMetaScopeQuery.scope_id ?? "full",
  ].join(":");
  const fieldMeta = useFieldMetaResource({
    component: colorbarComponent ?? null,
    enabled: showColorbar && !regionFieldMetaUnavailable,
    quantityId: settings.activeQuantityId,
    ...fieldMetaScopeQuery,
  });
  return (
    <InspectorSection title="Surface Coloring" collapsible>
      {regionFieldWarning ? (
        <FeedbackBanner
          kind="warning"
          message={regionFieldWarning}
        />
      ) : null}
      <FormField
        disabled={pending || sectionDisabled("surface-coloring")}
        label="Color source"
        type="select"
        value={settings.surfaceColorSource}
        onChange={(event) => {
          const surfaceColorSource = event.target.value as SurfaceColorSource;
          if (surfaceColorSource !== "solid") {
            onFieldCatalogRequest();
          }
          void patch({ surfaceColorSource });
        }}
      >
        {resolveSurfaceColorSourceItems(settings.activeQuantityId).map((source) => (
          <option key={source.value} value={source.value}>
            {source.label}
          </option>
        ))}
      </FormField>
      <FormField
        disabled={
          pending ||
          sectionDisabled("surface-coloring") ||
          settings.surfaceColorSource === "solid"
        }
        label="Projection"
        type="select"
        value={settings.surfaceProjectionMode}
        onChange={(event) =>
          void patch(surfaceFieldProjectionModePatch(event.target.value))
        }
      >
        {SURFACE_FIELD_PROJECTION_ITEMS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </FormField>
      {showColorbar && !regionFieldMetaUnavailable ? (
        <ScalarColorbarControl
          disabled={pending || sectionDisabled("surface-coloring")}
          fieldMeta={fieldMeta}
          palette={settings.scalarColorPalette}
          patch={patch}
          rangeIdentity={colorbarRangeIdentity}
        />
      ) : null}
      {showColorbar && !regionFieldMetaUnavailable ? (
        <label className="fm-inspector-checkbox-row">
          <input
            className="fm-inspector-checkbox"
            checked={settings.viewportColorbarVisible}
            disabled={pending || sectionDisabled("surface-coloring")}
            type="checkbox"
            onChange={(event) =>
              void patch({ viewportColorbarVisible: event.target.checked })
            }
          />
          <span>Add colorbar to viewport</span>
        </label>
      ) : null}
      {settings.surfaceColorSource === "solid" ? (
        <ColorField
          disabled={pending || sectionDisabled("surface-coloring")}
          label="Solid color"
          value={settings.shaderMonoColor}
          onChange={(value) => patchColor("shaderMonoColor", value)}
        />
      ) : null}
      <FieldRow
        label="Field status"
        value={surfaceFieldStatus(
          settings.surfaceColorSource,
          fieldCatalog.data,
          fieldCatalog.status,
        )}
      />
    </InspectorSection>
  );
}

function ScalarColorbarControl({
  disabled,
  fieldMeta,
  palette,
  patch,
  rangeIdentity,
}: {
  disabled: boolean;
  fieldMeta: ReturnType<typeof useFieldMetaResource>;
  palette: string;
  patch: PatchVisualizationTarget;
  rangeIdentity: string;
}) {
  const [displayUnit, setDisplayUnit] =
    useState<ScalarColorbarDisplayUnit>("");
  const cachedRange = useScalarColorbarRangeCache(rangeIdentity);
  useEffect(() => {
    if (
      fieldMeta.data?.stats &&
      typeof fieldMeta.data.stats.min === "number" &&
      typeof fieldMeta.data.stats.max === "number"
    ) {
      rememberScalarColorbarRange(rangeIdentity, fieldMeta.data);
    }
  }, [fieldMeta.data, rangeIdentity]);
  const visibleMeta = fieldMeta.data ?? cachedRange;
  const stats = visibleMeta?.stats;
  const unit =
    visibleMeta?.unit?.trim() ||
    (visibleMeta?.quantity_id ? quantityUnitForColorbar(visibleMeta.quantity_id) : "");
  const supportsDisplayUnitToggle =
    scalarColorbarSupportsDisplayUnits(unit);
  const displayUnitItems = scalarColorbarDisplayUnitItems(unit);
  const effectiveDisplayUnit =
    displayUnitItems.some((item) => item.value === displayUnit)
      ? displayUnit
      : displayUnitItems[0]?.value ?? "";
  const minLabel =
    typeof stats?.min === "number"
      ? formatScalarColorbarValueWithDisplayUnit(
          stats.min,
          unit,
          effectiveDisplayUnit,
        )
      : null;
  const maxLabel =
    typeof stats?.max === "number"
      ? formatScalarColorbarValueWithDisplayUnit(
          stats.max,
          unit,
          effectiveDisplayUnit,
        )
      : null;
  const dataRange =
    minLabel && maxLabel
      ? `${minLabel} to ${maxLabel}`
      : fieldMeta.status === "ready"
        ? "range unavailable"
        : "loading field range";
  return (
    <div className="fm-inspector-colorbar-control">
      <FormField
        disabled={disabled}
        label="Color map"
        type="select"
        value={palette}
        onChange={(event) => void patch(scalarColorPalettePatch(event.target.value))}
      >
        {SCALAR_COLOR_PALETTE_ITEMS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </FormField>
      {supportsDisplayUnitToggle ? (
        <FormField
          disabled={disabled}
          label="Display unit"
          type="select"
          value={effectiveDisplayUnit}
          onChange={(event) =>
            setDisplayUnit(event.target.value as ScalarColorbarDisplayUnit)
          }
        >
          {displayUnitItems.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </FormField>
      ) : null}
      <div
        className="fm-inspector-colorbar"
        aria-label={
          minLabel && maxLabel
            ? `Scalar color range: ${visibleMeta?.quantity_id ?? "field"}, ${minLabel} to ${maxLabel}`
            : "Scalar color map preview waiting for field range"
        }
      >
        <span className="fm-inspector-colorbar__limit">
          {minLabel ?? ""}
        </span>
        <span
          aria-hidden="true"
          className="fm-inspector-colorbar__ramp"
          style={{
            background: scalarColorPaletteGradientCss(palette),
          }}
        />
        <span className="fm-inspector-colorbar__limit">
          {maxLabel ?? ""}
        </span>
      </div>
      <FieldRow label="Data range" value={dataRange} />
    </div>
  );
}

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

function VisualizationQuantitySection({
  onFieldCatalogRequest,
  patch,
  pending,
  settings,
  targetKind,
}: {
  onFieldCatalogRequest: () => void;
  patch: PatchVisualizationTarget;
  pending: boolean;
  settings: VisualizationTargetSettings;
  targetKind?: VisualizationTargetKind;
}) {
  return (
    <InspectorSection title="Quantity Source">
      <FormField
        disabled={pending || !settings.visible}
        label="Quantity source"
        type="select"
        value={settings.activeQuantityId}
        onChange={(event) => {
          const patchValue = quantitySourcePatch(settings, event.target.value);
          const nextSurfaceColorSource =
            patchValue.surfaceColorSource ?? settings.surfaceColorSource;
          if (nextSurfaceColorSource !== "solid") {
            onFieldCatalogRequest();
          }
          void patch(patchValue);
        }}
      >
        {visualizationQuantityItems(settings.activeQuantityId, targetKind).map((quantity) => (
          <option key={quantity.value} value={quantity.value}>
            {quantity.label}
          </option>
        ))}
      </FormField>
    </InspectorSection>
  );
}

function VisualizationPointsSection({
  patchColor,
  pending,
  sectionDisabled,
  settings,
}: {
  patchColor: (field: "pointColor", value: string) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Points">
      <ColorField
        disabled={pending || sectionDisabled("points")}
        label="Point color"
        value={settings.pointColor}
        onChange={(value) => patchColor("pointColor", value)}
      />
    </InspectorSection>
  );
}

function VisualizationWireframeSection({
  patchColor,
  patchNumber,
  pending,
  sectionDisabled,
  settings,
}: {
  patchColor: (field: "wireframeColor", value: string) => void;
  patchNumber: (field: "wireframeOpacityPercent", value: number) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Wireframe">
      <ColorField disabled={pending || sectionDisabled("wireframe")} label="Wireframe color" value={settings.wireframeColor} onChange={(value) => patchColor("wireframeColor", value)} />
      <NumberField disabled={pending || sectionDisabled("wireframe")} label="Wireframe opacity" max={100} min={0} step={1} unit="%" value={settings.wireframeOpacityPercent} onChange={(value) => patchNumber("wireframeOpacityPercent", value)} />
    </InspectorSection>
  );
}

function VisualizationVectorsSection({
  meshParts,
  onTogglePartVectors,
  patch,
  patchColor,
  patchNumber,
  pending,
  sectionDisabled,
  settings,
  targetKind,
  vectorBudgetRange,
  vectorBudgetRanges,
}: {
  meshParts?: ReadonlyArray<{
    id: string;
    label: string;
    vectorsVisible: boolean;
  }>;
  onTogglePartVectors?: (partId: string, visible: boolean) => void;
  patch: PatchVisualizationTarget;
  patchColor: (field: "vectorMonoColor", value: string) => void;
  patchNumber: (
    field:
      | "vectorAlphaPercent"
      | "vectorBudget"
      | "vectorLengthScale"
      | "vectorSurfaceOffsetScale"
      | "vectorThickness",
    value: number,
  ) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
  targetKind: VisualizationTargetKind;
  vectorBudgetRange: VisualizationVectorBudgetRange;
  vectorBudgetRanges: Record<
    VisualizationGeometryScope,
    VisualizationVectorBudgetRange
  >;
}) {
  const vectorBudgetValue = Math.max(
    vectorBudgetRange.min,
    Math.min(vectorBudgetRange.max, settings.vectorBudget),
  );
  const vectorBudgetDiagnostic = buildVisualizationVectorBudgetDiagnostic({
    requestedBudget: vectorBudgetValue,
    vectorBudgetRange,
  });

  return (
    <InspectorSection title="Vectors">
      <fieldset className="fm-visualization-segments" aria-label="Vector coloring">
        {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
          <Button
            key={mode.value}
            size="sm"
            type="button"
            disabled={pending || sectionDisabled("vectors")}
            variant={settings.vectorColorMode === mode.value ? "primary" : "secondary"}
            onClick={() => void patch({ vectorColorMode: mode.value })}
          >
            {mode.label}
          </Button>
        ))}
      </fieldset>
      <ColorField disabled={pending || sectionDisabled("vectors")} label="Vector mono color" value={settings.vectorMonoColor} onChange={(value) => patchColor("vectorMonoColor", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Vector alpha" max={100} min={0} step={1} unit="%" value={settings.vectorAlphaPercent} onChange={(value) => patchNumber("vectorAlphaPercent", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Vector thickness" max={8} min={0.1} step={0.1} value={settings.vectorThickness} onChange={(value) => patchNumber("vectorThickness", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Arrow length" max={5} min={0.1} step={0.1} unit="×" value={settings.vectorLengthScale} onChange={(value) => patchNumber("vectorLengthScale", value)} />
      <NumberField
        disabled={pending || sectionDisabled("vectors")}
        label="Arrow budget"
        max={vectorBudgetRange.max}
        min={vectorBudgetRange.min}
        step={vectorBudgetRange.step}
        value={vectorBudgetValue}
        onChange={(value) => patchNumber("vectorBudget", value)}
      />
      <FieldRow
        label="Arrow samples"
        value={`${formatCount(vectorBudgetDiagnostic.displayedGlyphCount)} / ${formatCount(vectorBudgetDiagnostic.availableNodeCount)}${vectorBudgetDiagnostic.exact ? "" : " est."}`}
      />
      <div className="fm-visualization-toggle-grid">
        {targetKind === "airbox" ? (
          <ToggleButton
            active={settings.airboxSyntheticVectorsEnabled}
            disabled={pending || sectionDisabled("vectors")}
            label="Dev fallback +Z"
            onClick={() =>
              void patch({
                airboxSyntheticVectorsEnabled:
                  !settings.airboxSyntheticVectorsEnabled,
                vectorsVisible: true,
              })
            }
          />
        ) : null}
        <ToggleButton
          active={settings.vectorCenteringEnabled}
          disabled={pending || sectionDisabled("vectors")}
          label="Centered arrows"
          onClick={() =>
            void patch({
              vectorCenteringEnabled: !settings.vectorCenteringEnabled,
            })
          }
        />
        <ToggleButton
          active={settings.vectorSurfaceOffsetEnabled}
          disabled={pending || sectionDisabled("vectors")}
          label="Lift above surface"
          onClick={() =>
            void patch({
              vectorSurfaceOffsetEnabled:
                !settings.vectorSurfaceOffsetEnabled,
            })
          }
        />
      </div>
      {settings.vectorSurfaceOffsetEnabled ? (
        <NumberField disabled={pending || sectionDisabled("vectors")} label="Extra surface gap" max={1} min={0} step={0.01} value={settings.vectorSurfaceOffsetScale} onChange={(value) => patchNumber("vectorSurfaceOffsetScale", value)} />
      ) : null}
      <fieldset className="fm-visualization-segments" aria-label="Arrow extent">
        {GEOMETRY_SCOPES.map((scope) => (
          <Button
            key={scope.value}
            size="sm"
            type="button"
            disabled={pending || sectionDisabled("vectors")}
            variant={settings.geometryScope === scope.value ? "primary" : "secondary"}
            onClick={() =>
              void patch(
                geometryScopeVectorBudgetPatch({
                  currentRange:
                    vectorBudgetRanges[settings.geometryScope] ??
                    vectorBudgetRange,
                  geometryScope: scope.value,
                  nextRange: vectorBudgetRanges[scope.value],
                  settings,
                }),
              )
            }
          >
            {scope.label}
          </Button>
        ))}
      </fieldset>
      {meshParts && meshParts.length > 1 && onTogglePartVectors && (
        <fieldset className="fm-visualization-part-toggles" aria-label="Object target vector visibility">
          <span className="fm-visualization-part-toggles__label">Object surfaces</span>
          {meshParts.map((part) => (
            <label key={part.id} className="fm-visualization-part-toggle">
              <input
                type="checkbox"
                checked={part.vectorsVisible}
                disabled={pending || sectionDisabled("vectors")}
                onChange={(e) => onTogglePartVectors(part.id, e.target.checked)}
              />
              <span>{part.label}</span>
            </label>
          ))}
        </fieldset>
      )}
    </InspectorSection>
  );
}

function VisualizationGeometryScopeSection({
  passControlsDisabled,
  patch,
  settings,
  vectorBudgetRange,
  vectorBudgetRanges,
}: {
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
  vectorBudgetRange: VisualizationVectorBudgetRange;
  vectorBudgetRanges: Record<
    VisualizationGeometryScope,
    VisualizationVectorBudgetRange
  >;
}) {
  return (
    <InspectorSection title="Geometry Scope">
      <fieldset className="fm-visualization-segments" aria-label="Geometry scope">
        {GEOMETRY_SCOPES.map((scope) => (
          <Button
            key={scope.value}
            size="sm"
            type="button"
            disabled={passControlsDisabled}
            variant={settings.visible && settings.geometryScope === scope.value ? "primary" : "secondary"}
            onClick={() =>
              void patch({
                ...geometryScopeDisplayPatch(settings, scope.value),
                ...geometryScopeVectorBudgetPatch({
                  currentRange:
                    vectorBudgetRanges[settings.geometryScope] ??
                    vectorBudgetRange,
                  geometryScope: scope.value,
                  nextRange: vectorBudgetRanges[scope.value],
                  settings,
                }),
              })
            }
          >
            {scope.label}
          </Button>
        ))}
      </fieldset>
    </InspectorSection>
  );
}

function VisualizationOpacitySection({
  patch,
  settings,
}: {
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Opacity">
      <NumberField
        disabled={!settings.visible}
        label="Opacity"
        max={100}
        min={0}
        step={1}
        unit="%"
        value={settings.opacityPercent}
        onChange={(value) => void patch({ opacityPercent: value })}
      />
    </InspectorSection>
  );
}

function VisualizationOverridesSection({
  childRegionOverrideCount,
  childRegionTargets,
  feedback,
  onReset,
  onResetChildRegions,
  pending,
  resetLabel,
}: {
  childRegionOverrideCount: number;
  childRegionTargets: number;
  feedback: string | null;
  onReset: () => void;
  onResetChildRegions: () => void;
  pending: boolean;
  resetLabel: string;
}) {
  return (
    <InspectorSection title="Overrides">
      <div className="fm-inspector-toolbar">
        <Button size="sm" type="button" disabled={pending} variant="ghost" onClick={onReset}>
          <RotateCcw size={12} aria-hidden="true" />
          {resetLabel}
        </Button>
        {childRegionTargets > 0 ? (
          <Button
            size="sm"
            type="button"
            disabled={pending || childRegionOverrideCount === 0}
            variant="ghost"
            onClick={onResetChildRegions}
          >
            <RotateCcw size={12} aria-hidden="true" />
            Clear child region overrides
          </Button>
        ) : null}
      </div>
      {feedback && <FeedbackBanner kind="error" message={feedback} />}
    </InspectorSection>
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
        ? manifest.data?.mesh_parts?.find((part) => part.id === selection.ref?.nodeId) ??
          null
        : null,
    [manifest.data?.mesh_parts, selection.ref],
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
      if (part.role === "air" || part.role === "airbox") continue;
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
  const childRegionOverrideCount = childRegionTargets.filter(
    (childTarget) => snapshot.overrides[visualizationTargetKey(childTarget)],
  ).length;
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
  const airboxPartIds =
    manifest.data?.mesh_parts?.flatMap((part) =>
      part.role === "air" || part.role === "airbox" ? [part.id] : [],
    ) ?? [];
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
        visualization.patchTarget(resolvedTarget, localPatch);
      }
      if (!hasVisualizationStatePatch(statePatch)) {
        setFeedback(null);
        return;
      }

      visualizationSync.queuePatch(statePatch);
      visualization.patchTargetPending(
        resolvedTarget,
        patchValue,
        visualizationState.rawData?.revision ?? visualizationState.data?.revision ?? 0,
      );
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      for (const patchTarget of patchTargets) {
        visualization.patchTarget(patchTarget, patchValue);
      }
      return;
    }

    const remotePatch = remoteVisualizationTargetPatch(patchValue);
    const localRenderPatch = localRenderingTargetPatch(patchValue);
    if (Object.keys(localRenderPatch).length > 0) {
      for (const patchTarget of patchTargets) {
        visualization.patchLocalRenderTarget(patchTarget, localRenderPatch);
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
    if (childRegionTargets.length === 0) return;
    if (!visualizationState.data) {
      for (const childTarget of childRegionTargets) {
        visualization.clearTarget(childTarget);
      }
      return;
    }

    visualizationSync.queuePatch({
      overrides: (visualizationState.data.overrides ?? []).filter(
        (entry) =>
          !childRegionTargets.some((childTarget) =>
            visualizationStateOverrideMatchesTarget(entry, childTarget),
          ),
      ),
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

  // Build object-target arrow visibility rows from manifest parts.
  const vectorMeshParts = (() => {
    const parts = manifest.data?.mesh_parts;
    if (!parts || parts.length === 0) return undefined;
    // Filter to magnetic parts only (exclude airbox).
    const magneticParts = parts.filter(
      (p) => p.role !== "air" && p.role !== "airbox",
    );
    if (magneticParts.length <= 1) return undefined;
    return magneticParts.map((p) => {
      const partTarget = resolveObjectVisualizationPanelTarget({
        part: p,
        sceneObjectIds,
        visualizationState: visualizationState.data,
      });
      const partSettings = resolveTargetVisualization({
        snapshot,
        target: partTarget,
        visualizationState: visualizationState.data,
      }).settings;
      return {
        id: p.id,
        label: p.label,
        objectId: p.object_id ?? null,
        vectorsVisible: partSettings.vectorsVisible,
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

  function onTogglePartVectors(partId: string, visible: boolean) {
    const part = manifest.data?.mesh_parts?.find((p) => p.id === partId);
    if (!part || !visualizationState.data) return;
    queuePartVectorVisibilityPatch({
      controller: visualization,
      part,
      sceneObjectIds,
      state: visualizationState.data,
      sync: visualizationSync,
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
      />
      <VisualizationGeometryScopeSection
        passControlsDisabled={passControlsDisabled}
        patch={patch}
        settings={settings}
        vectorBudgetRange={vectorBudgetRange}
        vectorBudgetRanges={vectorBudgetRanges}
      />
      <VisualizationOpacitySection patch={patch} settings={settings} />
      <VisualizationOverridesSection
        childRegionOverrideCount={childRegionOverrideCount}
        childRegionTargets={childRegionTargets.length}
        feedback={feedback}
        onReset={() => void resetTarget()}
        onResetChildRegions={() => void resetChildRegionTargets()}
        pending={pending}
        resetLabel={visualizationResetActionLabel(target.kind)}
      />
    </div>
  );
}

function ColorField({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const pickerValue = colorPickerInputValue(value);

  return (
    <label className="fm-visualization-color-field">
      <span>{label}</span>
      <div className="fm-visualization-color-field__control">
        <input
          aria-label={`${label} picker`}
          className="fm-visualization-color-field__picker"
          disabled={disabled}
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="fm-visualization-color-field__value"
          disabled={disabled}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  );
}

function NumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  unit,
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  unit?: string;
  value: number;
}) {
  const [draftOverride, setDraftOverride] = useState<number | null>(null);
  const latestOnChangeRef = useRef(onChange);
  const draftFrameRef = useRef<number | null>(null);
  const pendingValueRef = useRef<number | null>(null);
  const queuedDraftValueRef = useRef<number | null>(null);
  const displayValue = draftOverride ?? value;

  useEffect(() => {
    latestOnChangeRef.current = onChange;
  }, [onChange]);

  useEffect(
    () => () => {
      if (draftFrameRef.current !== null) {
        window.cancelAnimationFrame(draftFrameRef.current);
        draftFrameRef.current = null;
      }
    },
    [],
  );

  const flushDraft = useCallback(() => {
    const pendingValue = pendingValueRef.current;
    pendingValueRef.current = null;
    queuedDraftValueRef.current = null;
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    setDraftOverride(null);
    if (pendingValue !== null) {
      latestOnChangeRef.current(pendingValue);
    }
  }, []);

  const scheduleDraft = useCallback(
    (nextValue: number) => {
      pendingValueRef.current = nextValue;
      queuedDraftValueRef.current = nextValue;
      if (draftFrameRef.current !== null) return;

      draftFrameRef.current = window.requestAnimationFrame(() => {
        draftFrameRef.current = null;
        const queuedValue = queuedDraftValueRef.current;
        queuedDraftValueRef.current = null;
        if (queuedValue !== null) {
          setDraftOverride(queuedValue);
        }
      });
    },
    [],
  );

  const valueRange = max - min;
  const pct =
    valueRange > 0
      ? Math.max(0, Math.min(100, ((displayValue - min) / valueRange) * 100))
      : 0;

  return (
    <label className="fm-visualization-range">
      <span>
        {unit ? `${label}: ${displayValue}${unit}` : `${label}: ${displayValue}`}
      </span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        type="range"
        value={displayValue}
        onBlur={flushDraft}
        onChange={(event) => scheduleDraft(Number(event.target.value))}
        onKeyUp={flushDraft}
        onPointerCancel={flushDraft}
        onPointerUp={flushDraft}
      />
    </label>
  );
}

function ToggleButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="fm-visualization-toggle"
      data-active={active}
      disabled={disabled}
      size="sm"
      type="button"
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

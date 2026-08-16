"use client";

import {
  Check,
  RotateCcw,
  Palette,
  ArrowUpRight,
  Eye,
  EyeOff,
  ArrowRightLeft,
  Box,
  SquareDashed,
} from "lucide-react";
import React, { useState, useId } from "react";
import {
  type FieldCatalogResource,
  type FieldMetaResource,
  type QuantityCatalogResource,
} from "@/kernel/api/apiTypes";
import { quantityUnitForColorbar } from "@/kernel/api/quantityIds";
import { Button } from "@/shared/ui/Button";
import {
  SegmentedControl,
} from "@/shared/ui/SegmentedControl";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";
import { controlVariants } from "@/shared/ui/controlVariants";
import { cn } from "@/shared/utils/className";
import {
  type VisualizationGeometryScope,
  type SurfaceColorSource,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
  visualizationTargetCapabilities,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { Viewport3DRenderedScalarRangeQuery } from "@/modules/viewport-3d/public";
import {
  useFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useViewport3DRenderedScalarRange } from "@/modules/viewport-3d/public";
import {
  buildVisualizationPanelSections,
  displayPassTogglePatch,
  fieldMetaScopeQueryForVisualizationTarget,
  fieldCatalogQuantityAvailable,
  formatScalarColorbarValueWithDisplayUnit,
  geometryScopeVectorBudgetPatch,
  resolveSurfaceColorSourceItems,
  scalarColorPaletteGradientCss,
  scalarColorPalettePatch,
  scalarColorbarDisplayUnitItems,
  scalarColorbarSupportsDisplayUnits,
  SCALAR_COLOR_PALETTE_ITEMS,
  shouldShowSurfaceFieldColorbar,
  shouldShowVectorFieldColorbar,
  SURFACE_FIELD_PROJECTION_ITEMS,
  surfaceFieldProjectionModePatch,
  surfaceColorSourceFieldMetaComponent,
  vectorColorModeFieldMetaComponent,
  geometryScopeDisplayPatch,
  quantitySourcePatch,
  regionVisualizationCarrierSupportsFieldMeta,
  regionVisualizationFieldWarning,
  renderModeDisplayPatch,
  resolveVisualizationDisplayMode,
  type VisualizationDisplayMode,
  type VisualizationVectorBudgetRange,
  type RegionVisualizationCarrier,
  visualizationQuantityItems,
  type ScalarColorbarDisplayUnit,
  colorPickerInputValue,
} from "./ObjectVisualizationPanelModel";
import { VisualizationVectorAccountingRows } from "./VisualizationVectorAccountingRows";
import { SHARED_VECTOR_COLOR_MODE_ITEMS } from "../visualization/presentationSemantics";
import {
  visualizationSectionDisabledDescription,
} from "./ObjectVisualizationPanelAccessibility";
import { surfaceFieldStatus } from "./ObjectVisualizationHelpers";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";

const GEOMETRY_SCOPES = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
];

const RENDER_MODE_OPTIONS = [
  { value: "surface" as const, label: "Shaded", subLabel: undefined },
  { value: "surface+edges" as const, label: "Shaded +", subLabel: "Wireframe" },
  { value: "wireframe" as const, label: "Wireframe", subLabel: undefined },
  { value: "points" as const, label: "Points", subLabel: undefined },
  { value: "off" as const, label: "Off", subLabel: undefined },
] satisfies Array<{
  value: VisualizationDisplayMode;
  label: string;
  subLabel?: string;
}>;

type PatchVisualizationTarget = (patchValue: VisualizationTargetPatch) => Promise<void>;
type SectionDisabled = (
  id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
) => boolean;

export function VisualizationDisplayPassesSection({
  displaySettings,
  passControlsDisabled,
  patch,
  pending,
  renderWarning,
  settings,
  target,
  primitiveDisplayToggleVisible,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  pending: boolean;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
  target: VisualizationTargetRef;
  primitiveDisplayToggleVisible: boolean;
}) {
  const capabilities = visualizationTargetCapabilities(target);
  return (
    <div className="grid min-w-0 gap-0" data-slot="visualization-display-passes">
      {renderWarning ? (
        <FeedbackBanner kind="warning" message={renderWarning} />
      ) : null}

      <div className="fm-viz-layer-strip">
        <button
          aria-label="Toggle target visibility"
          aria-pressed={settings.visible}
          className={`fm-viz-layer-chip${
            settings.visible
              ? " fm-viz-layer-chip--on"
              : ""
          }`}
          disabled={pending}
          type="button"
          onClick={() => void patch({ visible: !settings.visible })}
        >
          <Eye size={13} strokeWidth={1.75} aria-hidden="true" />
          Visible
        </button>

        {capabilities.showBoundsControl ? (
          <button
            aria-label="Toggle target bounds"
            aria-pressed={displaySettings.boundsVisible && displaySettings.visible}
            className={`fm-viz-layer-chip${
              displaySettings.boundsVisible && displaySettings.visible
                ? " fm-viz-layer-chip--on"
                : ""
            }`}
            disabled={passControlsDisabled}
            type="button"
            onClick={() =>
              void patch(displayPassTogglePatch(settings, "boundsVisible"))
            }
          >
            <SquareDashed size={13} strokeWidth={1.75} aria-hidden="true" />
            Bounds
          </button>
        ) : null}

        {primitiveDisplayToggleVisible ? (
          <button
            aria-label="Toggle monochrome primitive preview"
            aria-pressed={Boolean(
              displaySettings.primitiveVisible && displaySettings.visible,
            )}
            className={`fm-viz-layer-chip${
              displaySettings.primitiveVisible && displaySettings.visible
                ? " fm-viz-layer-chip--on"
                : ""
            }`}
            disabled={passControlsDisabled}
            type="button"
            onClick={() =>
              void patch({ primitiveVisible: !settings.primitiveVisible })
            }
          >
            <Box size={13} strokeWidth={1.75} aria-hidden="true" />
            Primitive
          </button>
        ) : null}

        {capabilities.supportsVectors ? (
        <button
          aria-label="Toggle vector field arrows"
          aria-pressed={displaySettings.vectorsVisible && displaySettings.visible}
          className={`fm-viz-layer-chip${
            displaySettings.vectorsVisible && displaySettings.visible
              ? " fm-viz-layer-chip--on"
              : ""
          }`}
          disabled={passControlsDisabled}
          type="button"
          onClick={() =>
            void patch(displayPassTogglePatch(settings, "vectorsVisible"))
          }
        >
          <ArrowRightLeft size={13} strokeWidth={1.75} aria-hidden="true" />
          Vectors
        </button>
        ) : null}
      </div>

      {capabilities.showBoundsControl && settings.boundsVisible ? (
        <NumberField
          disabled={pending || passControlsDisabled}
          label="Bounds opacity"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.boundsOpacityPercent}
          onChange={(value) => void patch({ boundsOpacityPercent: value })}
        />
      ) : null}

      {primitiveDisplayToggleVisible && settings.primitiveVisible ? (
        <div className="grid min-w-0 gap-fm-inspector-row pt-fm-inspector-row">
          <ColorField
            disabled={pending}
            label="Primitive color"
            value={settings.primitiveMonoColor ?? settings.shaderMonoColor}
            onChange={(value) => void patch({ primitiveMonoColor: value })}
          />
          <NumberField
            disabled={pending}
            label="Primitive opacity"
            max={100}
            min={0}
            step={1}
            unit="%"
            value={settings.primitiveOpacityPercent ?? 100}
            onChange={(value) =>
              void patch({ primitiveOpacityPercent: value })
            }
          />
          <ViewportPreferenceScopeNote />
        </div>
      ) : primitiveDisplayToggleVisible ? (
        <ViewportPreferenceScopeNote />
      ) : null}
    </div>
  );
}


export function VisualizationRenderModeSection({
  displaySettings,
  passControlsDisabled,
  pending,
  patch,
  target,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  pending: boolean;
  patch: PatchVisualizationTarget;
  target: VisualizationTargetRef;
}) {
  const capabilities = visualizationTargetCapabilities(target);
  const currentMode = resolveVisualizationDisplayMode(displaySettings);
  const renderModeOptions = RENDER_MODE_OPTIONS.filter(
    (option) =>
      option.value === "off" ||
      capabilities.primaryRenderModes.includes(option.value),
  );
  const unsupportedCurrentMode =
    currentMode !== "off" &&
    !capabilities.primaryRenderModes.includes(currentMode);
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="fm-viz-render-mode-label">Render Mode</span>
      {unsupportedCurrentMode ? (
        <FeedbackBanner
          kind="warning"
          message="This saved render mode is not available for this target. Choose a supported mode to replace it."
        />
      ) : null}
      <div
        className="fm-viz-render-mode-grid"
        role="radiogroup"
        aria-label="Render mode"
      >
        {renderModeOptions.map((option) => {
          const isActive = currentMode === option.value;
          return (
            <button
              key={option.value}
              aria-checked={isActive}
              aria-label={option.label}
              className={`fm-viz-render-mode-tile ${isActive ? "fm-viz-render-mode-tile--active" : ""}`}
              disabled={passControlsDisabled || pending}
              role="radio"
              type="button"
              onClick={() =>
                void patch(
                  target.id === "fdm-universe-outside-support"
                    ? { renderMode: option.value }
                    : renderModeDisplayPatch(option.value),
                )
              }
            >
              <span className="fm-viz-render-mode-tile__icon" aria-hidden="true">
                {option.value === "surface" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" fill={isActive ? "currentColor" : "none"} fillOpacity={isActive ? "0.15" : "0"} />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                )}
                {option.value === "surface+edges" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" fill={isActive ? "currentColor" : "none"} fillOpacity={isActive ? "0.15" : "0"} />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                    <polyline points="7 9.5 12 12 17 9.5" />
                    <polyline points="12 12 12 16.5" />
                  </svg>
                )}
                {option.value === "wireframe" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                    <line x1="7" y1="3.5" x2="12" y2="6.01" />
                    <line x1="17" y1="3.5" x2="12" y2="6.01" />
                  </svg>
                )}
                {option.value === "points" && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                    <circle cx="7" cy="9" r="1.5" fill="currentColor" />
                    <circle cx="17" cy="9" r="1.5" fill="currentColor" />
                    <circle cx="7" cy="15" r="1.5" fill="currentColor" />
                    <circle cx="17" cy="15" r="1.5" fill="currentColor" />
                    <circle cx="12" cy="6" r="1" fill="currentColor" />
                    <circle cx="12" cy="18" r="1" fill="currentColor" />
                    <circle cx="4" cy="12" r="1" fill="currentColor" />
                    <circle cx="20" cy="12" r="1" fill="currentColor" />
                  </svg>
                )}
                {option.value === "off" && (
                  <EyeOff size={20} strokeWidth={1.5} />
                )}
              </span>
              <span className="fm-viz-render-mode-tile__label">
                {option.label}
                {option.subLabel ? (
                  <span className="fm-viz-render-mode-tile__sub-label">{option.subLabel}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}


export function VisualizationSurfaceColoringSection({
  patch,
  patchColor,
  pending,
  sectionDisabled,
  fieldCatalog,
  fieldCatalogLoading,
  fieldMetaTarget,
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
  fieldCatalog: { data: FieldCatalogResource | null; status: string };
  fieldCatalogLoading: boolean;
  fieldMetaTarget: VisualizationTargetRef;
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
  const fieldMetaQuantityAvailable =
    !fieldCatalogLoading &&
    fieldCatalogQuantityAvailable(fieldCatalog.data, settings.activeQuantityId);
  const fieldMetaScopeQuery = fieldMetaScopeQueryForVisualizationTarget(
    fieldMetaTarget,
    regionCarrier,
  );
  const regionFieldWarning =
    target.kind === "region" ? regionVisualizationFieldWarning(regionCarrier) : null;
  const regionFieldMetaUnavailable =
    target.kind === "region" &&
    !regionVisualizationCarrierSupportsFieldMeta(regionCarrier);
  const showFieldMeta =
    showColorbar &&
    !regionFieldMetaUnavailable &&
    fieldMetaQuantityAvailable;
  const colorbarRangeIdentity = [
    settings.activeQuantityId,
    colorbarComponent ?? "none",
    fieldMetaScopeQuery.scope_kind ?? "full",
    fieldMetaScopeQuery.scope_id ?? "full",
  ].join(":");
  const renderedRange = useViewport3DRenderedScalarRange({
    component: colorbarComponent,
    quantityId: settings.activeQuantityId,
    scopeId: fieldMetaScopeQuery.scope_id,
    scopeKind: viewportRenderedRangeScopeKind(fieldMetaScopeQuery.scope_kind),
  });
  const fieldMeta = useFieldMetaResource({
    component: colorbarComponent ?? null,
    enabled: showFieldMeta,
    quantityId: settings.activeQuantityId,
    ...fieldMetaScopeQuery,
  });
  const surfaceSummary = settings.surfaceColorSource === "solid"
    ? "Solid color"
    : `By Quantity • ${settings.activeQuantityId ?? "H_eff"} (Auto)`;
  return (
    <InspectorGroup
      collapsible
      defaultOpen={false}
      icon={<Palette size={16} strokeWidth={1.75} />}
      summary={surfaceSummary}
      title="Surface Coloring"
      variant="nav"
    >
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
      {showFieldMeta ? (
        <ScalarColorbarControl
          disabled={pending || sectionDisabled("surface-coloring")}
          fieldMeta={fieldMeta}
          palette={settings.scalarColorPalette}
          patch={patch}
          quantityId={settings.activeQuantityId}
          rangeIdentity={colorbarRangeIdentity}
          renderedRange={renderedRange}
        />
      ) : null}
      {showFieldMeta ? (
        <InspectorPropertyRow label="Viewport colorbar">
          <Switch
            aria-label="Add colorbar to viewport"
            checked={settings.viewportColorbarVisible}
            disabled={pending || sectionDisabled("surface-coloring")}
            onCheckedChange={(checked) =>
              void patch({ viewportColorbarVisible: checked })
            }
          />
        </InspectorPropertyRow>
      ) : null}
      {settings.surfaceColorSource === "solid" ? (
        <ColorField
          disabled={pending || sectionDisabled("surface-coloring")}
          label="Solid color"
          value={settings.shaderMonoColor}
          onChange={(value) => patchColor("shaderMonoColor", value)}
        />
      ) : null}
      <NumberField
        disabled={pending || sectionDisabled("surface-coloring")}
        label="Surface opacity"
        max={100}
        min={0}
        step={1}
        unit="%"
        value={settings.surfaceOpacityPercent}
        onChange={(value) => void patch({ surfaceOpacityPercent: value })}
      />
      <InspectorPropertyRow label="Field status">
        <span className="font-fm-mono text-fm-control text-fm-secondary">
          {surfaceFieldStatus(
            settings.surfaceColorSource,
            fieldCatalog.data,
            fieldCatalog.status,
          )}
        </span>
      </InspectorPropertyRow>
    </InspectorGroup>
  );
}

export function ScalarColorbarControl({
  disabled,
  fieldMeta,
  palette,
  patch,
  quantityId,
  rangeIdentity,
  renderedRange,
}: {
  disabled: boolean;
  fieldMeta: ReturnType<typeof useFieldMetaResource>;
  palette: string;
  patch: PatchVisualizationTarget;
  quantityId: string;
  rangeIdentity: string;
  renderedRange: { max: number; min: number } | null;
}) {
  const [displayUnit, setDisplayUnit] =
    useState<ScalarColorbarDisplayUnit>("");
  const cachedRange = useScalarColorbarRangeCache(rangeIdentity);
  React.useEffect(() => {
    if (
      fieldMeta.data?.stats &&
      typeof fieldMeta.data.stats.min === "number" &&
      typeof fieldMeta.data.stats.max === "number"
    ) {
      rememberScalarColorbarRange(rangeIdentity, fieldMeta.data);
    }
  }, [fieldMeta.data, rangeIdentity]);
  const visibleMeta = fieldMeta.data ?? cachedRange;
  const stats = renderedRange ?? visibleMeta?.stats;
  const unit =
    visibleMeta?.unit?.trim() ||
    quantityUnitForColorbar(visibleMeta?.quantity_id ?? quantityId);
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
            ? `Scalar color range: ${visibleMeta?.quantity_id ?? quantityId}, ${minLabel} to ${maxLabel}`
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
  return React.useSyncExternalStore(
    subscribeScalarColorbarRangeCache,
    () => scalarColorbarRangeCache.get(identity) ?? null,
    () => null,
  );
}

function viewportRenderedRangeScopeKind(
  scopeKind: string | null | undefined,
): Viewport3DRenderedScalarRangeQuery["scopeKind"] {
  switch (scopeKind) {
    case "airbox":
    case "full":
    case "object":
    case "part":
    case "selection":
      return scopeKind;
    default:
      return null;
  }
}

export function VisualizationQuantitySection({
  fieldCatalog,
  fieldCatalogLoading,
  quantityCatalog,
  onFieldCatalogRequest,
  patch,
  pending,
  settings,
  targetKind,
}: {
  fieldCatalog: FieldCatalogResource | null;
  fieldCatalogLoading: boolean;
  quantityCatalog: QuantityCatalogResource | null;
  onFieldCatalogRequest: () => void;
  patch: PatchVisualizationTarget;
  pending: boolean;
  settings: VisualizationTargetSettings;
  targetKind?: VisualizationTargetKind;
}) {
  return (
    <FormField
      disabled={pending || !settings.visible || fieldCatalogLoading}
      inline
      label="Quantity Source"
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
      {visualizationQuantityItems(
        settings.activeQuantityId,
        targetKind,
        fieldCatalog,
        quantityCatalog,
      ).map((quantity) => (
        <option disabled={quantity.disabled} key={quantity.value} value={quantity.value}>
          {quantity.label}
        </option>
      ))}
    </FormField>
  );
}

export function VisualizationPointsSection({
  patch,
  patchColor,
  pending,
  sectionDisabled,
  settings,
}: {
  patch: PatchVisualizationTarget;
  patchColor: (field: "pointColor", value: string) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorGroup title="Points">
      <ColorField
        disabled={pending || sectionDisabled("points")}
        label="Point color"
        value={settings.pointColor}
        onChange={(value) => patchColor("pointColor", value)}
      />
      <NumberField
        disabled={pending || sectionDisabled("points")}
        label="Point opacity"
        max={100}
        min={0}
        step={1}
        unit="%"
        value={settings.pointOpacityPercent}
        onChange={(value) => void patch({ pointOpacityPercent: value })}
      />
    </InspectorGroup>
  );
}

export function VisualizationWireframeSection({
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
    <InspectorGroup title="Wireframe">
      <ColorField disabled={pending || sectionDisabled("wireframe")} label="Wireframe color" value={settings.wireframeColor} onChange={(value) => patchColor("wireframeColor", value)} />
      <NumberField disabled={pending || sectionDisabled("wireframe")} label="Wireframe opacity" max={100} min={0} step={1} unit="%" value={settings.wireframeOpacityPercent} onChange={(value) => patchNumber("wireframeOpacityPercent", value)} />
    </InspectorGroup>
  );
}

export function VisualizationVectorsSection({
  fieldCatalog,
  fieldCatalogLoading,
  fieldMetaTarget,
  meshParts,
  onTogglePartVectors,
  patch,
  patchColor,
  patchNumber,
  pending,
  regionCarrier,
  sectionDisabled,
  settings,
  target,
  targetKind,
  vectorBudgetRange,
  vectorTopologyHash,
}: {
  fieldCatalog: { data: FieldCatalogResource | null; status: string };
  fieldCatalogLoading: boolean;
  fieldMetaTarget: VisualizationTargetRef;
  meshParts?: ReadonlyArray<{
    actionTargetLabel: string;
    id: string;
    label: string;
    vectorsVisible: boolean;
  }>;
  onTogglePartVectors?: (visible: boolean) => void;
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
  regionCarrier?: RegionVisualizationCarrier | null;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
  target: VisualizationTargetRef;
  targetKind: VisualizationTargetKind;
  vectorBudgetRange: VisualizationVectorBudgetRange;
  vectorTopologyHash: string | null;
}) {
  const colorbarComponent = vectorColorModeFieldMetaComponent(
    settings.vectorColorMode,
    settings.activeQuantityId,
  );
  const showColorbar = shouldShowVectorFieldColorbar(
    settings.vectorColorMode,
    settings.activeQuantityId,
  );
  const fieldMetaQuantityAvailable =
    !fieldCatalogLoading &&
    fieldCatalogQuantityAvailable(fieldCatalog.data, settings.activeQuantityId);
  const fieldMetaScopeQuery = fieldMetaScopeQueryForVisualizationTarget(
    fieldMetaTarget,
    regionCarrier,
  );
  const regionFieldWarning =
    target.kind === "region" ? regionVisualizationFieldWarning(regionCarrier) : null;
  const regionFieldMetaUnavailable =
    target.kind === "region" &&
    !regionVisualizationCarrierSupportsFieldMeta(regionCarrier);
  const showFieldMeta =
    showColorbar &&
    !regionFieldMetaUnavailable &&
    fieldMetaQuantityAvailable;
  const fieldMeta = useFieldMetaResource({
    component: colorbarComponent ?? null,
    enabled: showFieldMeta,
    quantityId: settings.activeQuantityId,
    ...fieldMetaScopeQuery,
  });
  const colorbarRangeIdentity = [
    "vectors",
    settings.activeQuantityId,
    colorbarComponent ?? "none",
    fieldMetaScopeQuery.scope_kind ?? "full",
    fieldMetaScopeQuery.scope_id ?? "full",
  ].join(":");
  const renderedRange = useViewport3DRenderedScalarRange({
    component: colorbarComponent,
    quantityId: settings.activeQuantityId,
    scopeId: fieldMetaScopeQuery.scope_id,
    scopeKind: viewportRenderedRangeScopeKind(fieldMetaScopeQuery.scope_kind),
  });
  const vectorBudgetValue = Math.max(
    vectorBudgetRange.min,
    Math.min(vectorBudgetRange.max, settings.vectorBudget),
  );
  const vectorsDisabled = pending || sectionDisabled("vectors");

  const vectorsSummary = settings.geometryScope
    ? `${settings.geometryScope === "surface" ? "Surface" : "Volume"} • Density Auto`
    : "Surface • Density Auto";
  return (
    <InspectorGroup
      collapsible
      defaultOpen={false}
      icon={<ArrowUpRight size={16} strokeWidth={1.75} />}
      summary={vectorsSummary}
      title="Vectors"
      variant="nav"
    >
      <ViewportPreferenceScopeNote />
      <VisualizationRadioGroup
        disabled={vectorsDisabled}
        disabledDescription={visualizationSectionDisabledDescription({
          disabled: vectorsDisabled,
          pending,
          requiredPass: "Vectors",
          requiredPassEnabled: settings.vectorsVisible,
          targetVisible: settings.visible,
        })}
        items={[
          ...SHARED_VECTOR_COLOR_MODE_ITEMS,
          { label: "X component", value: "x" },
          { label: "Y component", value: "y" },
          { label: "Z component", value: "z" },
        ]}
        label="Vector coloring"
        value={settings.vectorColorMode}
        onValueChange={(value) => void patch({ vectorColorMode: value })}
      />
      {regionFieldWarning && showColorbar ? (
        <FeedbackBanner kind="warning" message={regionFieldWarning} />
      ) : null}
      {showFieldMeta ? (
        <ScalarColorbarControl
          disabled={vectorsDisabled}
          fieldMeta={fieldMeta}
          palette={settings.scalarColorPalette}
          patch={patch}
          quantityId={settings.activeQuantityId}
          rangeIdentity={colorbarRangeIdentity}
          renderedRange={renderedRange}
        />
      ) : null}
      {showFieldMeta ? (
        <InspectorPropertyRow label="Viewport colorbar">
          <Switch
            aria-label="Add vector colorbar to viewport"
            checked={settings.viewportColorbarVisible}
            disabled={vectorsDisabled}
            onCheckedChange={(checked) =>
              void patch({ viewportColorbarVisible: checked })
            }
          />
        </InspectorPropertyRow>
      ) : null}
      {settings.vectorColorMode === "monochrome" ? (
        <ColorField
          disabled={vectorsDisabled}
          label="Vector color"
          value={settings.vectorMonoColor}
          onChange={(value) => patchColor("vectorMonoColor", value)}
        />
      ) : null}
      <div className="fm-viz-vector-subgroup">
        <NumberField disabled={vectorsDisabled} label="Vector opacity" max={100} min={0} step={1} unit="%" value={settings.vectorAlphaPercent} onChange={(value) => patchNumber("vectorAlphaPercent", value)} />
        <NumberField disabled={vectorsDisabled} label="Thickness" max={8} min={0.1} step={0.1} value={settings.vectorThickness} onChange={(value) => patchNumber("vectorThickness", value)} />
        <NumberField disabled={vectorsDisabled} label="Arrow length" max={5} min={0.1} step={0.1} unit="×" value={settings.vectorLengthScale} onChange={(value) => patchNumber("vectorLengthScale", value)} />
      </div>
      <div className="fm-viz-vector-subgroup">
        <NumberField
          disabled={vectorsDisabled}
          label="Arrow budget"
          max={vectorBudgetRange.max}
          min={vectorBudgetRange.min}
          step={vectorBudgetRange.step}
          value={vectorBudgetValue}
          onChange={(value) => patchNumber("vectorBudget", value)}
        />
      </div>
      <div className="fm-viz-vector-accounting">
        <VisualizationVectorAccountingRows
          availableNodeCount={vectorBudgetRange.availableNodeCount}
          currentTopologyHash={vectorTopologyHash}
          exact={vectorBudgetRange.exact}
          targetKind={targetKind}
        />
      </div>
      <div className="fm-visualization-toggle-grid fm-visualization-toggle-grid--vectors">
        <ToggleButton
          active={settings.vectorCenteringEnabled}
          disabled={vectorsDisabled}
          disabledDescription={visualizationSectionDisabledDescription({
            disabled: vectorsDisabled,
            pending,
            requiredPass: "Vectors",
            requiredPassEnabled: settings.vectorsVisible,
            targetVisible: settings.visible,
          })}
          label="Centered arrows"
          onClick={() =>
            void patch({
              vectorCenteringEnabled: !settings.vectorCenteringEnabled,
            })
          }
        />
        <ToggleButton
          active={settings.vectorSurfaceOffsetEnabled}
          disabled={vectorsDisabled}
          disabledDescription={visualizationSectionDisabledDescription({
            disabled: vectorsDisabled,
            pending,
            requiredPass: "Vectors",
            requiredPassEnabled: settings.vectorsVisible,
            targetVisible: settings.visible,
          })}
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
      {meshParts && meshParts.length > 1 && onTogglePartVectors && (
        <fieldset className="fm-visualization-part-toggles" aria-label="Object target vector visibility">
          <span className="fm-visualization-part-toggles__label">Object surfaces</span>
          {meshParts.map((part) => (
            <label key={part.id} className="fm-visualization-part-toggle">
              <input
                type="checkbox"
                checked={part.vectorsVisible}
                disabled={pending || sectionDisabled("vectors")}
                onChange={(e) => onTogglePartVectors(e.target.checked)}
              />
              <span>{part.label}</span>
              <span className="fm-visualization-part-toggle__target">
                {part.actionTargetLabel}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </InspectorGroup>
  );
}

function ViewportPreferenceScopeNote() {
  return (
    <p className="fm-visualization-scope-note" role="note">
      Viewport-only settings. Not saved or shared.
    </p>
  );
}

function displayControlDisabledDescription(
  passControlsDisabled: boolean,
  targetVisible: boolean,
  pending: boolean,
): string | undefined {
  if (!targetVisible) return "Target is hidden.";
  if (pending) return "Saving display changes.";
  return undefined;
}

export function VisualizationGeometryScopeSection({
  passControlsDisabled,
  pending,
  patch,
  settings,
  vectorBudgetRange,
  vectorBudgetRanges,
}: {
  passControlsDisabled: boolean;
  pending: boolean;
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
  vectorBudgetRange: VisualizationVectorBudgetRange;
  vectorBudgetRanges: Record<
    VisualizationGeometryScope,
    VisualizationVectorBudgetRange
  >;
}) {
  return (
    <InspectorGroup title="Geometry Scope">
      <VisualizationRadioGroup
        disabled={passControlsDisabled}
        disabledDescription={displayControlDisabledDescription(passControlsDisabled, settings.visible, pending)}
        items={GEOMETRY_SCOPES}
        label="Geometry scope"
        value={settings.geometryScope}
        onValueChange={(value) =>
          void patch({
            ...geometryScopeDisplayPatch(settings, value as VisualizationGeometryScope),
            ...geometryScopeVectorBudgetPatch({
              currentRange:
                vectorBudgetRanges[settings.geometryScope] ?? vectorBudgetRange,
              geometryScope: value as VisualizationGeometryScope,
              nextRange: vectorBudgetRanges[value as VisualizationGeometryScope],
              settings,
            }),
          })
        }
      />
    </InspectorGroup>
  );
}

export function VisualizationOverridesSection({
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
    <InspectorGroup collapsible defaultOpen={false} title="Diagnostics & overrides">
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
    </InspectorGroup>
  );
}

export function ColorField({
  disabled,
  label,
  value,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  return (
    <InspectorPropertyRow label={label}>
      <div
        className="flex min-w-0 w-full items-center justify-end gap-2"
        data-slot="visualization-color-control"
      >
        <input
          aria-label={`${label} picker`}
          className="h-fm-control-sm w-fm-control-sm shrink-0 cursor-pointer rounded-fm-control border border-fm-subtle bg-fm-canvas p-1 disabled:cursor-not-allowed disabled:border-fm-disabled-border disabled:bg-fm-disabled disabled:opacity-100"
          disabled={disabled}
          id={inputId}
          type="color"
          value={colorPickerInputValue(value)}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <input
          aria-label={`${label} value`}
          className={cn(
            "min-w-0 flex-1 font-fm-mono",
            controlVariants({ density: "compact" }),
          )}
          disabled={disabled}
          type="text"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </div>
    </InspectorPropertyRow>
  );
}

export function NumberField({
  disabled,
  label,
  max = 100,
  min = 0,
  step = 1,
  unit,
  value,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  max?: number;
  min?: number;
  step?: number;
  unit?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draftOverride, setDraftOverride] = useState<number | null>(null);
  const displayValue = draftOverride ?? value;
  const displayLabel = `${formatNumericControlValue(displayValue, step)}${unit ?? ""}`;

  return (
    <InspectorPropertyRow
      label={
        <span className="flex w-full min-w-0 items-baseline justify-between gap-3">
          <span>{label}</span>
          <output className="shrink-0 font-fm-mono text-fm-control font-semibold text-fm-primary">
            {displayLabel}
          </output>
        </span>
      }
      layout="stacked"
    >
      <Slider
        aria-label={label}
        className="w-full"
        data-slot="visualization-number-control"
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        value={[displayValue]}
        onValueChange={([nextValue]) => {
          if (nextValue !== undefined) setDraftOverride(nextValue);
        }}
        onValueCommit={([nextValue]) => {
          setDraftOverride(null);
          if (nextValue !== undefined) onChange(nextValue);
        }}
      />
    </InspectorPropertyRow>
  );
}

function formatNumericControlValue(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return value.toFixed(decimals);
}

export function VisualizationToggleButton({
  active,
  disabled,
  disabledDescription,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  disabledDescription?: string;
  label: string;
  onClick: () => void;
}) {
  const descriptionId = useId();
  return (
    <Button
      aria-describedby={disabledDescription ? descriptionId : undefined}
      aria-pressed={active}
      className="fm-visualization-toggle"
      data-active={active}
      disabled={disabled}
      size="sm"
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {active ? <Check aria-hidden="true" size={12} /> : null}
      {label}
      {disabledDescription ? (
        <span className="fm-visually-hidden" id={descriptionId}>
          {disabledDescription}
        </span>
      ) : null}
    </Button>
  );
}

const ToggleButton = VisualizationToggleButton;

export function VisualizationRadioGroup<T extends string>({
  disabled,
  disabledDescription,
  items,
  label,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  disabledDescription?: string;
  items: Array<{ label: string; value: T }>;
  label: string;
  value: T;
  onValueChange: (next: T) => void;
}) {
  return (
    <InspectorPropertyRow
      description={disabled ? disabledDescription : undefined}
      label={label}
      layout="stacked"
    >
      <SegmentedControl
        aria-label={label}
        className="w-full"
        columns={items.length <= 2 ? 2 : items.length > 4 ? 3 : 4}
        disabled={disabled}
        options={items}
        value={value}
        onValueChange={onValueChange}
      />
    </InspectorPropertyRow>
  );
}

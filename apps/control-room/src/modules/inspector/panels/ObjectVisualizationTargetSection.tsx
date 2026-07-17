"use client";

import {
  Check,
  RotateCcw,
  Palette,
  ArrowUpRight,
  Eye,
  ArrowRightLeft,
} from "lucide-react";
import React, { useState, useId } from "react";
import { type FieldCatalogResource, type FieldMetaResource } from "@/kernel/api/apiTypes";
import { quantityUnitForColorbar } from "@/kernel/api/quantityIds";
import { Button } from "@/shared/ui/Button";
import {
  SegmentedControl,
  type SegmentedControlOption,
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
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  useFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildVisualizationPanelSections,
  displayPassTogglePatch,
  fieldMetaScopeQueryForVisualizationTarget,
  formatScalarColorbarValueWithDisplayUnit,
  geometryScopeVectorBudgetPatch,
  resolveSurfaceColorSourceItems,
  scalarColorPaletteGradientCss,
  scalarColorPalettePatch,
  scalarColorbarDisplayUnitItems,
  scalarColorbarSupportsDisplayUnits,
  SCALAR_COLOR_PALETTE_ITEMS,
  shouldShowSurfaceFieldColorbar,
  SURFACE_FIELD_PROJECTION_ITEMS,
  surfaceFieldProjectionModePatch,
  surfaceColorSourceFieldMetaComponent,
  geometryScopeDisplayPatch,
  quantitySourcePatch,
  regionVisualizationCarrierSupportsFieldMeta,
  regionVisualizationFieldWarning,
  renderModeDisplayPatch,
  resolveVisualizationDisplayMode,
  type VisualizationDisplayMode,
  VISUALIZATION_COLOR_MODE_ITEMS,
  type VisualizationVectorBudgetRange,
  type RegionVisualizationCarrier,
  visualizationQuantityItems,
  type ScalarColorbarDisplayUnit,
  colorPickerInputValue,
} from "./ObjectVisualizationPanelModel";
import { VisualizationVectorAccountingRows } from "./VisualizationVectorAccountingRows";
import {
  visualizationSectionDisabledDescription,
} from "./ObjectVisualizationPanelAccessibility";
import { surfaceFieldStatus } from "./ObjectVisualizationHelpers";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";

const RENDER_MODES: Array<SegmentedControlOption<VisualizationDisplayMode>> = [
  { label: "Shaded", value: "surface" },
  {
    accessibleLabel: "Shaded plus wireframe",
    label: "Shaded +\nWireframe",
    value: "surface+edges",
  },
  { label: "Wireframe", value: "wireframe" },
  { label: "Points", value: "points" },
  { label: "Off", value: "off" },
];

const GEOMETRY_SCOPES = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
];

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
  primitiveDisplayToggleVisible,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  pending: boolean;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
  primitiveDisplayToggleVisible: boolean;
}) {
  function handleVisibleClick(): void {
    void patch({ visible: !settings.visible });
  }

  return (
    <div className="grid min-w-0 gap-3" data-slot="visualization-display-passes">
      {renderWarning ? (
        <FeedbackBanner kind="warning" message={renderWarning} />
      ) : null}

      {/* Surface row */}
      <div className="fm-viz-display-row">
        <span className="fm-viz-display-row__icon">
          <Eye size={15} strokeWidth={1.75} />
        </span>
        <span className="fm-viz-display-row__label">Surface</span>
        <span className="fm-viz-display-row__controls">
          <button
            aria-pressed={displaySettings.visible}
            className={`fm-viz-visible-pill${!displaySettings.visible ? " fm-viz-visible-pill--inactive" : ""}`}
            disabled={pending}
            type="button"
            onClick={handleVisibleClick}
          >
            <span className="fm-viz-visible-pill__dot" aria-hidden="true" />
            Visible
          </button>
        </span>
      </div>

      {/* Vectors row */}
      <div className="fm-viz-display-row">
        <span className="fm-viz-display-row__icon">
          <ArrowRightLeft size={15} strokeWidth={1.75} />
        </span>
        <span className="fm-viz-display-row__label">Vectors</span>
        <span className="fm-viz-display-row__controls fm-viz-display-row__controls--vectors">
          <span className="fm-viz-display-row__enabled-label">Enabled</span>
          <Switch
            aria-label="Toggle vectors"
            checked={displaySettings.vectorsVisible}
            disabled={passControlsDisabled}
            onCheckedChange={() =>
              void patch(displayPassTogglePatch(settings, "vectorsVisible"))
            }
          />
          <SegmentedControl
            aria-label="Vectors geometry scope"
            className="fm-viz-display-row__scope"
            disabled={passControlsDisabled}
            options={[
              { label: "Surface", value: "surface" },
              { label: "Volume", value: "full" },
            ]}
            value={settings.geometryScope === "full" ? "full" : "surface"}
            onValueChange={(value) =>
              void patch({ geometryScope: value as "surface" | "full" })
            }
          />
        </span>
      </div>

      {primitiveDisplayToggleVisible ? <ViewportPreferenceScopeNote /> : null}
    </div>
  );
}


export function VisualizationRenderModeSection({
  displaySettings,
  passControlsDisabled,
  pending,
  patch,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  pending: boolean;
  patch: PatchVisualizationTarget;
}) {
  const currentMode = resolveVisualizationDisplayMode(displaySettings);
  const renderModeOptions = [
    { value: "surface" as const, label: "Shaded", subLabel: undefined },
    { value: "surface+edges" as const, label: "Shaded +", subLabel: "Wireframe" },
    { value: "wireframe" as const, label: "Wireframe", subLabel: undefined },
    { value: "points" as const, label: "Points", subLabel: undefined },
  ] satisfies Array<{ value: VisualizationDisplayMode; label: string; subLabel?: string }>;
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="fm-viz-render-mode-label">Render Mode</span>
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
              disabled={passControlsDisabled}
              role="radio"
              type="button"
              onClick={() => void patch(renderModeDisplayPatch(option.value))}
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
  return React.useSyncExternalStore(
    subscribeScalarColorbarRangeCache,
    () => scalarColorbarRangeCache.get(identity) ?? null,
    () => null,
  );
}

export function VisualizationQuantitySection({
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
    <FormField
      disabled={pending || !settings.visible}
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
      {visualizationQuantityItems(settings.activeQuantityId, targetKind).map((quantity) => (
        <option key={quantity.value} value={quantity.value}>
          {quantity.label}
        </option>
      ))}
    </FormField>
  );
}

export function VisualizationPointsSection({
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
    <InspectorGroup title="Points">
      <ColorField
        disabled={pending || sectionDisabled("points")}
        label="Point color"
        value={settings.pointColor}
        onChange={(value) => patchColor("pointColor", value)}
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
  vectorTopologyHash,
}: {
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
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
  targetKind: VisualizationTargetKind;
  vectorBudgetRange: VisualizationVectorBudgetRange;
  vectorBudgetRanges: Record<
    VisualizationGeometryScope,
    VisualizationVectorBudgetRange
  >;
  vectorTopologyHash: string | null;
}) {
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
        items={VISUALIZATION_COLOR_MODE_ITEMS}
        label="Vector coloring"
        value={settings.vectorColorMode}
        onValueChange={(value) => void patch({ vectorColorMode: value })}
      />
      {settings.vectorColorMode === "monochrome" ? (
        <ColorField
          disabled={vectorsDisabled}
          label="Vector color"
          value={settings.vectorMonoColor}
          onChange={(value) => patchColor("vectorMonoColor", value)}
        />
      ) : null}
      <div className="fm-viz-vector-subgroup">
        <NumberField disabled={vectorsDisabled} label="Opacity" max={100} min={0} step={1} unit="%" value={settings.vectorAlphaPercent} onChange={(value) => patchNumber("vectorAlphaPercent", value)} />
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
        {targetKind === "airbox" ? (
          <ToggleButton
            active={settings.airboxSyntheticVectorsEnabled}
            disabled={vectorsDisabled}
            disabledDescription={visualizationSectionDisabledDescription({
              disabled: vectorsDisabled,
              pending,
              requiredPass: "Vectors",
              requiredPassEnabled: settings.vectorsVisible,
              targetVisible: settings.visible,
            })}
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
      <VisualizationRadioGroup
        disabled={vectorsDisabled}
        disabledDescription={visualizationSectionDisabledDescription({
          disabled: vectorsDisabled,
          pending,
          requiredPass: "Vectors",
          requiredPassEnabled: settings.vectorsVisible,
          targetVisible: settings.visible,
        })}
        items={GEOMETRY_SCOPES}
        label="Arrow extent"
        value={settings.geometryScope}
        onValueChange={(value) =>
          void patch(
            geometryScopeVectorBudgetPatch({
              currentRange:
                vectorBudgetRanges[settings.geometryScope] ?? vectorBudgetRange,
              geometryScope: value as VisualizationGeometryScope,
              nextRange: vectorBudgetRanges[value as VisualizationGeometryScope],
              settings,
            }),
          )
        }
      />
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

export function VisualizationOpacitySection({
  patch,
  settings,
}: {
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorGroup title="Opacity">
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

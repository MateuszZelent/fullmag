"use client";

import { Check, Info, RotateCcw } from "lucide-react";
import React, { useState, useId, useRef, useCallback, useEffect } from "react";
import { type FieldCatalogResource, type FieldMetaResource } from "@/kernel/api/apiTypes";
import { quantityUnitForColorbar } from "@/kernel/api/quantityIds";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
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
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
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
  buildAirboxVectorDiagnostic,
  buildAirboxVisibilityDiagnostic,
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
  surfaceDisplayPassPatch,
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

const RENDER_MODES = [
  { label: "Shaded", value: "surface" },
  { label: "Shaded + wireframe", value: "surface+edges" },
  { label: "Wire", value: "wireframe" },
  { label: "Points", value: "points" },
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
  fieldCatalog: { data: FieldCatalogResource | null; status: string };
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
    <div className="grid min-w-0 gap-3" data-slot="visualization-display-passes">
      {renderWarning ? (
        <FeedbackBanner kind="warning" message={renderWarning} />
      ) : null}
      <div className="fm-visualization-toggle-grid">
        <ToggleButton
          active={displaySettings.visible}
          disabled={pending}
          disabledDescription={pending ? "Saving display changes." : undefined}
          label="Visible"
          onClick={handleVisibleClick}
        />
        <ToggleButton
          active={displaySettings.shaderVisible}
          disabled={passControlsDisabled}
          disabledDescription={displayControlDisabledDescription(
            passControlsDisabled,
            settings.visible,
            pending,
          )}
          label="Surface"
          onClick={() => void patch(surfaceDisplayPassPatch(settings))}
        />
        <ToggleButton
          active={displaySettings.wireframeVisible}
          disabled={passControlsDisabled}
          disabledDescription={displayControlDisabledDescription(
            passControlsDisabled,
            settings.visible,
            pending,
          )}
          label="Wireframe"
          onClick={() =>
            void patch(displayPassTogglePatch(settings, "wireframeVisible"))
          }
        />
        <ToggleButton
          active={displaySettings.boundsVisible}
          disabled={passControlsDisabled}
          disabledDescription={displayControlDisabledDescription(
            passControlsDisabled,
            settings.visible,
            pending,
          )}
          label="Frame"
          onClick={() => void patch(displayPassTogglePatch(settings, "boundsVisible"))}
        />
        <ToggleButton
          active={displaySettings.pointsVisible}
          disabled={passControlsDisabled}
          disabledDescription={displayControlDisabledDescription(
            passControlsDisabled,
            settings.visible,
            pending,
          )}
          label="Points"
          onClick={() => void patch(displayPassTogglePatch(settings, "pointsVisible"))}
        />
        <ToggleButton
          active={displaySettings.vectorsVisible}
          disabled={passControlsDisabled}
          disabledDescription={displayControlDisabledDescription(
            passControlsDisabled,
            settings.visible,
            pending,
          )}
          label="Vectors"
          onClick={() => void patch(displayPassTogglePatch(settings, "vectorsVisible"))}
        />
        {primitiveDisplayToggleVisible ? (
          <ToggleButton
            active={Boolean(displaySettings.primitiveVisible)}
            disabled={passControlsDisabled}
            disabledDescription={displayControlDisabledDescription(
              passControlsDisabled,
              settings.visible,
              pending,
            )}
            label="Primitive"
            onClick={() =>
              void patch(displayPassTogglePatch(settings, "primitiveVisible"))
            }
          />
        ) : null}
        {targetKind === "airbox" ? (
          <Button
            aria-label="Airbox visualization diagnostics"
            className="fm-visualization-toggle"
            size="sm"
            title="Airbox visualization diagnostics"
            type="button"
            variant="ghost"
            onClick={handleDiagnosticClick}
          >
            <Info aria-hidden="true" size={13} />
            Diagnostic
          </Button>
        ) : null}
      </div>
      {primitiveDisplayToggleVisible ? <ViewportPreferenceScopeNote /> : null}
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
  return (
    <InspectorPropertyRow
      description={
        displayControlDisabledDescription(
          passControlsDisabled,
          displaySettings.visible,
          pending,
        )
      }
      label="Render mode"
      layout="stacked"
    >
      <SegmentedControl
        aria-label="Render mode"
        disabled={passControlsDisabled}
        options={RENDER_MODES}
        value={displaySettings.renderMode}
        onValueChange={(value) => void patch(renderModeDisplayPatch(value as VisualizationRenderMode))}
      />
    </InspectorPropertyRow>
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
  return (
    <InspectorGroup collapsible defaultOpen={false} title="Surface Coloring">
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

  return (
    <InspectorGroup collapsible defaultOpen={false} title="Vectors">
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
      <VisualizationVectorAccountingRows
        availableNodeCount={vectorBudgetRange.availableNodeCount}
        currentTopologyHash={vectorTopologyHash}
        exact={vectorBudgetRange.exact}
        targetKind={targetKind}
      />
      <div className="fm-visualization-toggle-grid">
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
      This viewport only — not saved to the simulation or shared with other clients.
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
    <InspectorGroup title="Overrides">
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
    <div className="fm-form-field">
      <label className="fm-form-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="fm-form-field__control-row">
        <input
          aria-label={`${label} picker`}
          className="fm-color-picker-input"
          disabled={disabled}
          id={inputId}
          type="color"
          value={colorPickerInputValue(value)}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <input
          aria-label={`${label} value`}
          className="fm-inspector-input"
          disabled={disabled}
          type="text"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </div>
    </div>
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
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
    >
      {active ? <Check aria-hidden="true" size={13} /> : null}
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
  const name = useId();
  return (
    <div className="fm-radio-group" role="radiogroup" aria-label={label}>
      {items.map((item) => {
        const itemId = `${name}-${item.value}`;
        const isChecked = item.value === value;
        return (
          <div className="fm-radio-item" key={item.value}>
            <input
              checked={isChecked}
              className="fm-radio-item__input"
              disabled={disabled}
              id={itemId}
              name={name}
              type="radio"
              value={item.value}
              onChange={() => onValueChange(item.value)}
            />
            <label
              className="fm-radio-item__label"
              htmlFor={itemId}
              title={disabledDescription}
            >
              {item.label}
            </label>
          </div>
        );
      })}
    </div>
  );
}

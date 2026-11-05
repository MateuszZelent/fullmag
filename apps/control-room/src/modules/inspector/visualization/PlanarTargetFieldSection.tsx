"use client";

import { useState } from "react";
import { ArrowRightLeft, Palette, ScanLine } from "lucide-react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  visualizationStateScopeIdForTarget,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import { DIRECTION_COLORMAP } from "@/shared/visualization/directionColor";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { ColorField } from "../panels/ObjectVisualizationTargetSection";
import { SCALAR_COLOR_PALETTE_ITEMS } from "../panels/ObjectVisualizationPanelModel";
import {
  PLANAR_RANGE_MODE_ITEMS,
  PLANAR_VECTOR_COLOR_MODE_ITEMS,
  PLANAR_VECTOR_LENGTH_MODE_ITEMS,
  planarRangeForMode,
} from "./presentationSemantics";
import { VisualizationDisplayPassesControl } from "./VisualizationInspectorControls";
import {
  createPlanarTargetFieldProfile,
  findPlanarTargetFieldProfile,
  patchPlanarTargetFieldProfile,
  planarAirboxEnablePatch,
  planarTargetFieldProfileId,
  removePlanarTargetFieldProfile,
  upsertPlanarTargetFieldProfile,
  type PlanarTargetFieldProfile,
  type PlanarTargetFieldProfilePatch,
  type PlanarTargetFieldQuantityOption,
} from "./planarTargetFieldProfile";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarRange = NonNullable<Planar["range"]>;
type PlanarVectorStyle = Planar["vector_style"];
type PlanarTargetFieldPatch = Partial<Planar> & {
  field_overlays?: PlanarTargetFieldProfile[];
};

type PlanarWithTargetOverlays = Planar & {
  field_overlays?: PlanarTargetFieldProfile[] | null;
};

function defaultComponent(
  option: PlanarTargetFieldQuantityOption | undefined,
): string {
  return option?.components.find((component) => component.value === "frobenius")?.value
    ?? option?.components.find((component) => component.value === "magnitude")?.value
    ?? option?.components[0]?.value
    ?? "magnitude";
}

function quantityComponentSupportsVectors(
  quantity: PlanarTargetFieldQuantityOption | undefined,
  component: string,
): boolean {
  const outputKind = quantity?.components.find((option) => option.value === component)?.outputKind;
  return outputKind === undefined ? quantity?.vector ?? false : outputKind === "vector";
}

function numberValue(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function PlanarTargetFieldSection({
  target,
  targetReason,
  planar,
  quantities: quantityOptions,
  displayUnitItems,
  canonicalUnit,
  onPatch,
}: {
  target: VisualizationTargetRef;
  targetReason?: string;
  planar: Planar;
  quantities: readonly PlanarTargetFieldQuantityOption[];
  displayUnitItems?: readonly { value: string; label: string }[];
  canonicalUnit?: string;
  onPatch: (patch: PlanarTargetFieldPatch, touchedFieldOverlayId?: string) => void;
}) {
  const [validationErrors, setValidationErrors] = useState<Record<string, string | null>>({});
  const profileState = planar as PlanarWithTargetOverlays;
  const overlays = profileState.field_overlays ?? [];
  const objectTarget = target.kind === "object";
  const airboxTarget = target.kind === "airbox";
  const quantities = airboxTarget ? quantityOptions.filter((quantity) => quantity.id !== "m") : quantityOptions;
  const scopeId = objectTarget ? visualizationStateScopeIdForTarget(target) : "";
  const profile = objectTarget
    ? findPlanarTargetFieldProfile(overlays, scopeId)
    : undefined;
  const profileId = objectTarget
    ? planarTargetFieldProfileId(scopeId)
    : "airbox";
  const validationError = validationErrors[profileId] ?? null;
  const disabledReason = targetReason ?? (
    objectTarget || airboxTarget
      ? undefined
      : "Planar target fields are supported for objects and Airbox only."
  );
  const disabled = disabledReason !== undefined;
  const maxReached = objectTarget && profile === undefined && overlays.length >= 4;

  const updateValidationError = (message: string | null) => {
    setValidationErrors((current) => ({ ...current, [profileId]: message }));
  };

  const patchProfile = (next: PlanarTargetFieldProfilePatch) => {
    if (!profile || disabled) return;
    onPatch({
      field_overlays: patchPlanarTargetFieldProfile(overlays, profile.id, next),
    }, profile.id);
  };

  const patchAirbox = (next: Partial<Planar>) => {
    if (disabled || !airboxTarget) return;
    onPatch({ ...next, view_scope: { kind: "airbox" } });
  };

  const toggleTargetField = () => {
    if (disabled || maxReached) return;
    if (objectTarget) {
      if (profile) {
        onPatch({
          field_overlays: removePlanarTargetFieldProfile(overlays, profile.id),
        }, profile.id);
        return;
      }
      const nextProfile = createPlanarTargetFieldProfile(scopeId, planar.vector_style);
      const nextOverlays = upsertPlanarTargetFieldProfile(overlays, nextProfile);
      if (!nextOverlays) return;
      onPatch({
        field_overlays: nextOverlays,
        ...(overlays.length === 0
          ? {
              multislice: {
                ...(planar.multislice ?? { enabled: false, position_fractions: [] }),
                enabled: false,
              },
            }
          : {}),
      }, nextProfile.id);
      return;
    }

    if (!airboxTarget) return;
    onPatch(planarAirboxEnablePatch(planar, quantities));
  };

  const selectedQuantityId = profile?.quantity_id ?? planar.quantity_id;
  const selectedQuantity = quantities.find((quantity) => quantity.id === selectedQuantityId);
  const vectorQuantity = selectedQuantity
    ? quantityComponentSupportsVectors(selectedQuantity, profile?.component ?? planar.component)
    : selectedQuantityId === "m";
  const componentOptions = selectedQuantity?.components ?? [
    { value: selectedQuantityId === "m" ? "magnitude" : "magnitude", label: "magnitude" },
  ];
  const selectedComponent = profile?.component ?? planar.component;
  const validComponent = componentOptions.some((component) => component.value === selectedComponent)
    ? selectedComponent
    : defaultComponent(selectedQuantity);
  const paletteItems = vectorQuantity
    ? [{ label: "Direction (HSL, mumax3)", value: DIRECTION_COLORMAP }, ...SCALAR_COLOR_PALETTE_ITEMS]
    : SCALAR_COLOR_PALETTE_ITEMS;
  const selectedColormap = profile?.colormap ?? planar.colormap;
  const range = profile?.range ?? planar.range ?? { mode: "auto" as const, min: null, max: null };
  const rasterOpacity = profile?.raster_opacity ?? planar.raster_opacity ?? 1;
  const rasterVisible = profile?.raster_visible ?? planar.layers.raster;
  const vectorsVisible = profile?.vectors_visible ?? planar.layers.vectors;
  const vectorStyle = profile?.vector_style ?? planar.vector_style;
  const profileEnabled = objectTarget ? profile !== undefined : planar.view_scope.kind === "airbox";
  const controlsDisabled = disabled || !profileEnabled;
  const panelDisabledHint = disabledReason ?? (!profileEnabled ? "Show this target field to edit its planar presentation." : undefined);

  const patchRange = (next: PlanarRange) => {
    if (profile) patchProfile({ range: next });
    else patchAirbox({ range: next });
  };

  const updateManualRange = (field: "min" | "max", raw: string) => {
    const value = numberValue(raw);
    if (value === null) {
      updateValidationError("Range limits must be finite SI values.");
      return;
    }
    const next = {
      mode: "manual" as const,
      min: range.mode === "manual" ? range.min : -1,
      max: range.mode === "manual" ? range.max : 1,
      [field]: value,
    };
    if (typeof next.min !== "number" || typeof next.max !== "number" || next.min >= next.max) {
      updateValidationError("Manual range requires minimum < maximum.");
      return;
    }
    updateValidationError(null);
    patchRange(next);
  };

  const patchVectorStyle = (next: Partial<PlanarVectorStyle>) => {
    if (profile) patchProfile({ vector_style: { ...vectorStyle, ...next } });
    else patchAirbox({ vector_style: { ...vectorStyle, ...next } });
  };

  const changeQuantity = (nextQuantityId: string) => {
    const nextQuantity = quantities.find((quantity) => quantity.id === nextQuantityId);
    if (!nextQuantity || disabled) return;
    const nextComponent = defaultComponent(nextQuantity);
    const nextVectorsSupported = quantityComponentSupportsVectors(nextQuantity, nextComponent);
    const nextPalette = !nextQuantity.vector && selectedColormap === DIRECTION_COLORMAP
      ? SCALAR_COLOR_PALETTE_ITEMS[0]?.value ?? "viridis"
      : selectedColormap;
    if (profile) {
      patchProfile({
        quantity_id: nextQuantityId,
        component: nextComponent as Planar["component"],
        colormap: nextPalette,
        ...(!nextVectorsSupported ? { vectors_visible: false } : {}),
      });
      return;
    }
    patchAirbox({
      quantity_id: nextQuantityId,
      component: nextComponent as Planar["component"],
      colormap: nextPalette,
      ...(!nextVectorsSupported
        ? { layers: { ...planar.layers, vectors: false } }
        : {}),
    });
  };

  const changeComponent = (component: string) => {
    const vectorsSupported = quantityComponentSupportsVectors(selectedQuantity, component);
    if (profile) patchProfile({
      component: component as Planar["component"],
      ...(!vectorsSupported ? { vectors_visible: false } : {}),
    });
    else patchAirbox({
      component: component as Planar["component"],
      ...(!vectorsSupported ? { layers: { ...planar.layers, vectors: false } } : {}),
    });
  };

  if (!objectTarget && !airboxTarget) {
    return (
      <InspectorGroup title="Target field">
        <FieldRow label="Availability" value={disabledReason ?? "Unsupported target"} />
      </InspectorGroup>
    );
  }

  const title = objectTarget ? "Object 2D field" : "Airbox 2D field";
  const targetLabel = objectTarget ? target.label ?? scopeId : "Airbox";

  return (
    <InspectorGroup
      collapsible
      defaultOpen
      icon={<ScanLine aria-hidden="true" size={16} strokeWidth={1.75} />}
      summary={profileEnabled ? `${selectedQuantityId} • ${rasterVisible ? "Raster" : "Vectors"}` : "Disabled"}
      title={title}
      variant="nav"
    >
      <FieldRow label="Target" value={targetLabel} />
      {disabledReason ? <FieldRow label="Availability" value={disabledReason} /> : null}
      {objectTarget ? (
        <Button
          disabled={disabled || maxReached}
          disabledReason={disabledReason ?? (maxReached ? "The planar field overlay limit of four is reached." : undefined)}
          size="sm"
          type="button"
          variant={profile ? "secondary" : "primary"}
          onClick={toggleTargetField}
        >
          {profile ? "Hide field on target" : "Show field on target"}
        </Button>
      ) : !profileEnabled ? (
        <Button
          disabled={disabled || quantities.length === 0}
          disabledReason={disabledReason ?? (quantities.length === 0 ? "No planar quantities are currently available." : undefined)}
          size="sm"
          type="button"
          variant="primary"
          onClick={toggleTargetField}
        >
          Show Airbox field
        </Button>
      ) : null}
      {objectTarget && maxReached ? <FieldRow label="Availability" value="The planar field overlay limit of four is reached." /> : null}
      {profileEnabled ? (
        <>
          {objectTarget && overlays.length > 0 ? <FieldRow label="Profile limit" value={`${overlays.length} of 4 object fields`} /> : null}
          <FormField
            disabled={controlsDisabled || quantities.length === 0}
            hint={panelDisabledHint}
            label="Quantity"
            type="select"
            value={selectedQuantityId}
            onChange={(event) => changeQuantity(event.currentTarget.value)}
          >
            {!quantities.some((quantity) => quantity.id === selectedQuantityId) ? (
              <option disabled value={selectedQuantityId}>{selectedQuantityId} (unavailable)</option>
            ) : null}
            {quantities.map((quantity) => (
              <option key={quantity.id} value={quantity.id}>
                {quantity.label} ({quantity.unit || "1"})
              </option>
            ))}
          </FormField>
          <FormField
            disabled={controlsDisabled || componentOptions.length === 0}
            hint={panelDisabledHint}
            label="Component"
            type="select"
            value={validComponent}
            onChange={(event) => changeComponent(event.currentTarget.value)}
          >
            {componentOptions.map((component) => (
              <option key={component.value} value={component.value}>{component.label}</option>
            ))}
          </FormField>
          <VisualizationDisplayPassesControl
            items={[
              {
                id: "raster",
                label: "Raster",
                ariaLabel: "Toggle Raster",
                pressed: rasterVisible,
                disabled: controlsDisabled,
                onToggle: () => profile
                  ? patchProfile({ raster_visible: !rasterVisible })
                  : patchAirbox({ layers: { ...planar.layers, raster: !rasterVisible } }),
              },
              {
                id: "vectors",
                label: "Vectors",
                ariaLabel: "Toggle Vectors",
                pressed: vectorsVisible,
                disabled: controlsDisabled || !vectorQuantity,
                onToggle: () => profile
                  ? patchProfile({ vectors_visible: !vectorsVisible })
                  : patchAirbox({ layers: { ...planar.layers, vectors: !vectorsVisible } }),
              },
            ]}
          />
          <InspectorGroup
            collapsible
            defaultOpen
            icon={<Palette aria-hidden="true" size={16} strokeWidth={1.75} />}
            summary={paletteItems.find((item) => item.value === selectedColormap)?.label ?? selectedColormap}
            title="Surface Coloring"
            variant="nav"
          >
            <FormField
              disabled={controlsDisabled}
              hint={panelDisabledHint}
              label="Color map"
              type="select"
              value={selectedColormap}
              onChange={(event) => profile
                ? patchProfile({ colormap: event.currentTarget.value })
                : patchAirbox({ colormap: event.currentTarget.value })}
            >
              {paletteItems.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </FormField>
            {airboxTarget && displayUnitItems && displayUnitItems.length > 1 ? (
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Display unit"
                type="select"
                value={planar.display_unit ?? displayUnitItems[0]?.value ?? ""}
                onChange={(event) => patchAirbox({ display_unit: event.currentTarget.value || null })}
              >
                {displayUnitItems.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </FormField>
            ) : airboxTarget ? <FieldRow label="Unit" value={canonicalUnit || "dimensionless"} /> : null}
            <FormField
              disabled={controlsDisabled}
              error={validationError ?? undefined}
              hint={panelDisabledHint}
              label="Range mode"
              type="select"
              value={range.mode}
              onChange={(event) => patchRange(planarRangeForMode(event.currentTarget.value as PlanarRange["mode"], range))}
            >
              {PLANAR_RANGE_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </FormField>
            {range.mode === "manual" ? (
              <>
                <FormField
                  disabled={controlsDisabled}
                  error={validationError ?? undefined}
                  hint={panelDisabledHint}
                  label="Range minimum"
                  type="number"
                  value={range.min ?? ""}
                  onChange={(event) => updateManualRange("min", event.currentTarget.value)}
                />
                <FormField
                  disabled={controlsDisabled}
                  error={validationError ?? undefined}
                  hint={panelDisabledHint}
                  label="Range maximum"
                  type="number"
                  value={range.max ?? ""}
                  onChange={(event) => updateManualRange("max", event.currentTarget.value)}
                />
              </>
            ) : null}
            <FormField
              disabled={controlsDisabled}
              error={validationError ?? undefined}
              hint={panelDisabledHint}
              label="Raster opacity"
              max="1"
              min="0"
              step="0.05"
              type="number"
              value={rasterOpacity}
              onChange={(event) => {
                const value = numberValue(event.currentTarget.value);
                if (value === null || value < 0 || value > 1) {
                  updateValidationError("Raster opacity must be between 0 and 1.");
                  return;
                }
                updateValidationError(null);
                if (profile) patchProfile({ raster_opacity: value });
                else patchAirbox({ raster_opacity: value });
              }}
            />
            {airboxTarget ? (
              <FormField
                label="Viewport colorbar"
                type="checkbox"
                checked={planar.viewport_colorbar_visible}
                disabled={controlsDisabled}
                onChange={() => patchAirbox({ viewport_colorbar_visible: !planar.viewport_colorbar_visible })}
              />
            ) : null}
          </InspectorGroup>
          {airboxTarget ? (
            <InspectorGroup title="Airbox Layers">
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Show bounds"
                type="checkbox"
                checked={planar.layers.bounds}
                onChange={() => patchAirbox({ layers: { ...planar.layers, bounds: !planar.layers.bounds } })}
              />
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Show contours"
                type="checkbox"
                checked={planar.layers.contours}
                onChange={() => patchAirbox({ layers: { ...planar.layers, contours: !planar.layers.contours } })}
              />
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Show mesh"
                type="checkbox"
                checked={planar.layers.mesh}
                onChange={() => patchAirbox({ layers: { ...planar.layers, mesh: !planar.layers.mesh } })}
              />
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Show boundaries"
                type="checkbox"
                checked={planar.layers.boundaries}
                onChange={() => patchAirbox({ layers: { ...planar.layers, boundaries: !planar.layers.boundaries } })}
              />
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Show points"
                type="checkbox"
                checked={planar.layers.points}
                onChange={() => patchAirbox({ layers: { ...planar.layers, points: !planar.layers.points } })}
              />
              <FormField
                disabled={controlsDisabled}
                hint={panelDisabledHint}
                label="Show probes"
                type="checkbox"
                checked={planar.layers.probes}
                onChange={() => patchAirbox({ layers: { ...planar.layers, probes: !planar.layers.probes } })}
              />
              {"streamlines" in planar.layers ? (
                <FormField
                  disabled={controlsDisabled || !vectorQuantity}
                  hint={!vectorQuantity ? "The selected quantity has no vector components." : panelDisabledHint}
                  label="Show streamlines"
                  type="checkbox"
                  checked={Boolean(planar.layers.streamlines)}
                  onChange={() => patchAirbox({ layers: { ...planar.layers, streamlines: !planar.layers.streamlines } })}
                />
              ) : null}
            </InspectorGroup>
          ) : null}
          <InspectorGroup
            collapsible
            defaultOpen={false}
            icon={<ArrowRightLeft aria-hidden="true" size={16} strokeWidth={1.75} />}
            summary="Quiver"
            title="Vectors"
            variant="nav"
          >
            <FormField disabled label="Glyph" type="select" value="quiver"><option value="quiver">Quiver</option></FormField>
            <FormField
              disabled={controlsDisabled || !vectorQuantity}
              hint={!vectorQuantity ? "The selected quantity has no vector components." : panelDisabledHint}
              label="Vector scale"
              min="0"
              step="0.1"
              type="number"
              value={vectorStyle.scale}
              onChange={(event) => {
                const value = numberValue(event.currentTarget.value);
                if (value !== null && value > 0) patchVectorStyle({ scale: value });
              }}
            />
            <FormField
              disabled={controlsDisabled || !vectorQuantity}
              hint={!vectorQuantity ? "The selected quantity has no vector components." : panelDisabledHint}
              label="Vector opacity"
              max="1"
              min="0"
              step="0.05"
              type="number"
              value={vectorStyle.opacity}
              onChange={(event) => {
                const value = numberValue(event.currentTarget.value);
                if (value !== null && value >= 0 && value <= 1) patchVectorStyle({ opacity: value });
              }}
            />
            <FormField
              disabled={controlsDisabled || !vectorQuantity}
              hint={!vectorQuantity ? "The selected quantity has no vector components." : panelDisabledHint}
              label="Vector thickness"
              max="16"
              min="0.1"
              step="0.1"
              type="number"
              value={vectorStyle.thickness}
              onChange={(event) => {
                const value = numberValue(event.currentTarget.value);
                if (value !== null && value > 0 && value <= 16) patchVectorStyle({ thickness: value });
              }}
            />
            <FormField
              disabled={controlsDisabled || !vectorQuantity}
              hint={!vectorQuantity ? "The selected quantity has no vector components." : panelDisabledHint}
              label="Vector length mode"
              type="select"
              value={vectorStyle.length_mode}
              onChange={(event) => patchVectorStyle({ length_mode: event.currentTarget.value })}
            >
              {PLANAR_VECTOR_LENGTH_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </FormField>
            <FormField
              disabled={controlsDisabled || !vectorQuantity}
              hint={!vectorQuantity ? "The selected quantity has no vector components." : panelDisabledHint}
              label="Vector color mode"
              type="select"
              value={vectorStyle.color_mode}
              onChange={(event) => patchVectorStyle({ color_mode: event.currentTarget.value })}
            >
              {PLANAR_VECTOR_COLOR_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </FormField>
            {vectorStyle.color_mode === "monochrome" ? (
              <ColorField
                disabled={controlsDisabled || !vectorQuantity}
                label="Vector color"
                value={vectorStyle.monochrome_color}
                onChange={(color) => patchVectorStyle({ monochrome_color: color })}
              />
            ) : null}
          </InspectorGroup>
        </>
      ) : null}
    </InspectorGroup>
  );
}

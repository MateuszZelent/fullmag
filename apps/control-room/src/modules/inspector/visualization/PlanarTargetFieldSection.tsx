"use client";

import { useState } from "react";
import {
  ArrowRightLeft,
  CircleDashed,
  Grip,
  Layers3,
  MoveUpRight,
  Palette,
  ScanLine,
  Square,
  Triangle,
  Waves,
} from "lucide-react";

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
  effectivePass,
  layerPassFlag,
  layerPassPatch,
  layerVisible,
  patchFieldLayer,
  PLANAR_FIELD_LAYERS_MAX,
  removeFieldLayer,
  type PlanarFieldLayer,
  type PlanarFieldQuantityOption,
  type PlanarLayerPass,
  type PlanarLayerState,
} from "./planarFieldLayers";
import {
  PLANAR_FIELD_LAYERS_FULL_REASON,
  planarLayerComponentLabel,
  type PlanarFieldLayerCandidate,
} from "./PlanarFieldLayerList";

type PlanarRange = PlanarFieldLayer["range"];
type PlanarVectorStyle = PlanarFieldLayer["vector_style"];

export interface PlanarLayerWriteOptions {
  /** Send at once: the change alters sample identity (quantity, component). */
  flush?: boolean;
}

/** Disabled reason per pass; omitted passes are available. */
export type PlanarLayerPassReasons = Partial<Record<PlanarLayerPass, string>>;

type PassItem = { pass: PlanarLayerPass; label: string; icon: typeof Square };

/** The two everyday passes, shown directly under the quantity. */
const MAIN_PASS_ITEMS: readonly PassItem[] = [
  { pass: "raster", label: "Color", icon: Square },
  { pass: "vectors", label: "Arrows", icon: MoveUpRight },
];

/** Less common passes, kept in the collapsed "More drawing" group. */
const MORE_PASS_ITEMS: readonly PassItem[] = [
  { pass: "points", label: "Points", icon: Grip },
  { pass: "mesh", label: "Mesh", icon: Triangle },
  { pass: "contours", label: "Contours", icon: CircleDashed },
  { pass: "streamlines", label: "Streamlines", icon: Waves },
];

const NOT_VECTOR_REASON = "The selected quantity has no vector components.";
const NO_QUANTITY_VALUE = "";

function defaultComponent(option: PlanarFieldQuantityOption | undefined): string {
  return option?.components.find((component) => component.value === "frobenius")?.value
    ?? option?.components.find((component) => component.value === "magnitude")?.value
    ?? option?.components[0]?.value
    ?? "magnitude";
}

function quantityComponentSupportsVectors(
  quantity: PlanarFieldQuantityOption | undefined,
  component: string,
): boolean {
  const outputKind = quantity?.components.find((option) => option.value === component)?.outputKind;
  return outputKind === undefined ? quantity?.vector ?? false : outputKind === "vector";
}

function numberValue(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function quantityName(quantities: readonly PlanarFieldQuantityOption[], quantityId: string): string {
  return quantities.find((quantity) => quantity.id === quantityId)?.label ?? quantityId;
}

/** One-line answer to "what does this target show in the 2D view?". */
export function planarFieldShownText(
  layer: PlanarFieldLayer | null,
  inherited: PlanarFieldLayer | null,
  quantities: readonly PlanarFieldQuantityOption[],
): string {
  if (layer) {
    const state = layerVisible(layer) ? "Own setting" : "Own setting, hidden";
    return `${state} · ${quantityName(quantities, layer.quantity_id)} · ${planarLayerComponentLabel(layer)}`;
  }
  if (inherited) {
    return `Inherited from All objects · ${quantityName(quantities, inherited.quantity_id)} · ${planarLayerComponentLabel(inherited)}`;
  }
  return "Not drawn in the 2D view";
}

/**
 * "Field in <target>" (spec 23 §5): what the selected target shows and the
 * one place where its quantity is chosen. Without an own layer, choosing a
 * quantity is the explicit edit that creates it.
 */
export function PlanarTargetFieldSection({
  emptyTarget,
  inherited = null,
  layer,
  layers,
  passReasons,
  quantities,
  targetLabel,
  targetReason,
  viewMasks,
  onAdd,
  onWrite,
}: {
  /** Selected target that has no layer yet; choosing a quantity creates it. */
  emptyTarget?: PlanarFieldLayerCandidate | null;
  /** Layer that draws the target while it has no own layer (the `all` layer). */
  inherited?: PlanarFieldLayer | null;
  layer: PlanarFieldLayer | null;
  layers: readonly PlanarFieldLayer[];
  passReasons?: PlanarLayerPassReasons;
  quantities: readonly PlanarFieldQuantityOption[];
  targetLabel: string;
  targetReason?: string;
  viewMasks: PlanarLayerState;
  onAdd: (candidate: PlanarFieldLayerCandidate, quantityId?: string) => void;
  onWrite: (layers: PlanarFieldLayer[], touchedLayerId: string, options?: PlanarLayerWriteOptions) => void;
}) {
  const [validationErrors, setValidationErrors] = useState<Record<string, string | null>>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!layer) {
    if (!emptyTarget) {
      return (
        <InspectorGroup icon={<ScanLine aria-hidden="true" size={16} strokeWidth={1.75} />} title="Field">
          <p className="fm-planar-layer-editor__empty">
            Select an object or the Airbox in the model tree, or a row under 2D view → Field layers, to choose what it shows.
          </p>
        </InspectorGroup>
      );
    }
    const createOptions = emptyTarget.target !== "all" && emptyTarget.target.kind === "airbox"
      ? quantities.filter((quantity) => quantity.id !== "m")
      : quantities;
    const create = (quantityId: string) => {
      if (!quantityId || targetReason !== undefined) return;
      if (layers.length >= PLANAR_FIELD_LAYERS_MAX) {
        setRefusal(PLANAR_FIELD_LAYERS_FULL_REASON);
        return;
      }
      setRefusal(null);
      onAdd(emptyTarget, quantityId);
    };
    return (
      <InspectorGroup
        badge={inherited ? "Inherited" : "Not drawn"}
        icon={<ScanLine aria-hidden="true" size={16} strokeWidth={1.75} />}
        title={`Field in ${emptyTarget.label}`}
      >
        {targetReason ? <FieldRow label="Availability" value={targetReason} /> : null}
        <FieldRow label="Shown" value={planarFieldShownText(null, inherited, quantities)} />
        <FormField
          disabled={targetReason !== undefined || createOptions.length === 0}
          hint={inherited
            ? `Choose a quantity to give ${emptyTarget.label} its own setting.`
            : `Choose a quantity to draw it in ${emptyTarget.label}.`}
          label="Quantity"
          type="select"
          value={NO_QUANTITY_VALUE}
          onChange={(event) => create(event.currentTarget.value)}
        >
          <option disabled value={NO_QUANTITY_VALUE}>
            {inherited ? `As All objects (${quantityName(quantities, inherited.quantity_id)})` : "Choose a quantity…"}
          </option>
          {createOptions.map((quantity) => (
            <option key={quantity.id} value={quantity.id}>{quantity.label} ({quantity.unit || "1"})</option>
          ))}
        </FormField>
        {refusal ? <p className="fm-planar-layer-list__refusal" role="status">{refusal}</p> : null}
      </InspectorGroup>
    );
  }

  const layerId = layer.id;
  const validationError = validationErrors[layerId] ?? null;
  const setValidationError = (message: string | null) =>
    setValidationErrors((current) => ({ ...current, [layerId]: message }));
  // The Airbox carries no magnetization.
  const quantityOptions = layer.view_scope.kind === "airbox"
    ? quantities.filter((quantity) => quantity.id !== "m")
    : quantities;
  const write = (patch: Partial<PlanarFieldLayer>, options?: PlanarLayerWriteOptions) =>
    onWrite(patchFieldLayer(layers, layerId, patch), layerId, options);

  const selectedQuantity = quantityOptions.find((quantity) => quantity.id === layer.quantity_id);
  const componentOptions = selectedQuantity?.components
    ?? [{ value: String(layer.component), label: String(layer.component) }];
  const vectorQuantity = selectedQuantity
    ? quantityComponentSupportsVectors(selectedQuantity, String(layer.component))
    : layer.quantity_id === "m";
  const paletteItems = vectorQuantity
    ? [{ label: "Direction (HSL, mumax3)", value: DIRECTION_COLORMAP }, ...SCALAR_COLOR_PALETTE_ITEMS]
    : SCALAR_COLOR_PALETTE_ITEMS;
  const range = layer.range ?? { mode: "auto" as const, min: null, max: null };
  const vectorStyle = layer.vector_style;
  const disabled = targetReason !== undefined;
  const vectorHint = !vectorQuantity ? NOT_VECTOR_REASON : targetReason;
  const visible = layerVisible(layer);
  // An object or part layer falls back to the `all` layer; others leave the view.
  const fallsBackToAll = (layer.view_scope.kind === "object" || layer.view_scope.kind === "mesh_part")
    && layers.some((entry) => entry.id === "all");

  const changeQuantity = (nextQuantityId: string) => {
    const nextQuantity = quantityOptions.find((quantity) => quantity.id === nextQuantityId);
    if (!nextQuantity || disabled) return;
    const nextComponent = defaultComponent(nextQuantity);
    const nextVectors = quantityComponentSupportsVectors(nextQuantity, nextComponent);
    write({
      quantity_id: nextQuantityId,
      component: nextComponent as PlanarFieldLayer["component"],
      colormap: !nextQuantity.vector && layer.colormap === DIRECTION_COLORMAP
        ? SCALAR_COLOR_PALETTE_ITEMS[0]?.value ?? "viridis"
        : layer.colormap,
      ...(!nextVectors ? { vectors_visible: false, streamlines_visible: false } : {}),
    }, { flush: true });
  };

  const changeComponent = (component: string) => {
    const vectors = quantityComponentSupportsVectors(selectedQuantity, component);
    write({
      component: component as PlanarFieldLayer["component"],
      ...(!vectors ? { vectors_visible: false, streamlines_visible: false } : {}),
    }, { flush: true });
  };

  const updateManualRange = (field: "min" | "max", raw: string) => {
    const value = numberValue(raw);
    if (value === null) {
      setValidationError("Range limits must be finite SI values.");
      return;
    }
    const next = {
      mode: "manual" as const,
      min: range.mode === "manual" ? range.min : -1,
      max: range.mode === "manual" ? range.max : 1,
      [field]: value,
    };
    if (typeof next.min !== "number" || typeof next.max !== "number" || next.min >= next.max) {
      setValidationError("Manual range requires minimum < maximum.");
      return;
    }
    setValidationError(null);
    write({ range: next });
  };

  const patchVectorStyle = (next: Partial<PlanarVectorStyle>) =>
    write({ vector_style: { ...vectorStyle, ...next } });

  const passItems = (items: readonly PassItem[]) => items.map(({ pass, label, icon: Icon }) => {
    const state = effectivePass(layer, viewMasks, pass);
    const vectorPass = pass === "vectors" || pass === "streamlines";
    const reason = vectorPass && !vectorQuantity ? NOT_VECTOR_REASON : passReasons?.[pass];
    return {
      ariaLabel: `Toggle ${label}`,
      // An unavailable pass can still be switched off, never on.
      disabled: disabled || !visible || (reason !== undefined && !layerPassFlag(layer, pass)),
      icon: <Icon aria-hidden="true" size={13} strokeWidth={1.75} />,
      id: pass,
      label,
      note: state === "masked" ? (pass === "raster" ? "hidden in this view" : "hidden in toolbar") : undefined,
      pressed: state !== "off",
      onToggle: () => write(layerPassPatch(pass, !layerPassFlag(layer, pass))),
    };
  });
  const morePassReasons = Object.entries(passReasons ?? {})
    .filter(([pass]) => MORE_PASS_ITEMS.some((item) => item.pass === pass));
  const morePassesOn = MORE_PASS_ITEMS.filter(({ pass }) => effectivePass(layer, viewMasks, pass) !== "off")
    .map(({ label }) => label);

  return (
    <InspectorGroup
      badge="Own setting"
      icon={<ScanLine aria-hidden="true" size={16} strokeWidth={1.75} />}
      title={`Field in ${targetLabel}`}
    >
      {targetReason ? <FieldRow label="Availability" value={targetReason} /> : null}
      <FieldRow label="Shown" value={planarFieldShownText(layer, null, quantities)} />
      {!visible ? (
        <div className="fm-inspector-toolbar">
          <Button size="sm" type="button" variant="secondary" onClick={() => write({ visible: true })}>
            Show {targetLabel} in the 2D view
          </Button>
        </div>
      ) : null}
      <FormField
        disabled={disabled || quantityOptions.length === 0}
        hint={targetReason}
        label="Quantity"
        type="select"
        value={layer.quantity_id}
        onChange={(event) => changeQuantity(event.currentTarget.value)}
      >
        {!quantityOptions.some((quantity) => quantity.id === layer.quantity_id) ? (
          <option disabled value={layer.quantity_id}>{layer.quantity_id} (unavailable)</option>
        ) : null}
        {quantityOptions.map((quantity) => (
          <option key={quantity.id} value={quantity.id}>{quantity.label} ({quantity.unit || "1"})</option>
        ))}
      </FormField>
      <FormField
        disabled={disabled || componentOptions.length === 0}
        hint={targetReason}
        label="Component"
        type="select"
        value={String(layer.component)}
        onChange={(event) => changeComponent(event.currentTarget.value)}
      >
        {componentOptions.map((component) => (
          <option key={component.value} value={component.value}>{component.label}</option>
        ))}
      </FormField>
      <div className="fm-inspector-form-field">
        <span className="fm-inspector-form-field__label">Show</span>
        <VisualizationDisplayPassesControl items={passItems(MAIN_PASS_ITEMS)} />
      </div>
      <InspectorGroup
        collapsible
        defaultOpen={false}
        icon={<Palette aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary={paletteItems.find((item) => item.value === layer.colormap)?.label ?? layer.colormap}
        title="Coloring"
        variant="nav"
      >
        <FormField
          disabled={disabled}
          label="Color map"
          type="select"
          value={layer.colormap}
          onChange={(event) => write({ colormap: event.currentTarget.value })}
        >
          {paletteItems.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </FormField>
        <FormField
          disabled={disabled}
          error={validationError ?? undefined}
          label="Range mode"
          type="select"
          value={range.mode}
          onChange={(event) => write({ range: planarRangeForMode(event.currentTarget.value as PlanarRange["mode"], range) })}
        >
          {PLANAR_RANGE_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </FormField>
        {range.mode === "manual" ? (
          <>
            <FormField disabled={disabled} error={validationError ?? undefined} label="Range minimum" type="number" value={range.min ?? ""} onChange={(event) => updateManualRange("min", event.currentTarget.value)} />
            <FormField disabled={disabled} error={validationError ?? undefined} label="Range maximum" type="number" value={range.max ?? ""} onChange={(event) => updateManualRange("max", event.currentTarget.value)} />
          </>
        ) : null}
        <FormField
          disabled={disabled}
          error={validationError ?? undefined}
          label="Raster opacity"
          max="1"
          min="0"
          step="0.05"
          type="number"
          value={layer.raster_opacity}
          onChange={(event) => {
            const value = numberValue(event.currentTarget.value);
            if (value === null || value < 0 || value > 1) {
              setValidationError("Raster opacity must be between 0 and 1.");
              return;
            }
            setValidationError(null);
            write({ raster_opacity: value });
          }}
        />
      </InspectorGroup>
      <InspectorGroup
        collapsible
        defaultOpen={false}
        icon={<ArrowRightLeft aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary={vectorQuantity ? "Quiver" : "Not a vector quantity"}
        title="Arrows"
        variant="nav"
      >
        <FormField disabled={disabled || !vectorQuantity} hint={vectorHint} label="Vector scale" min="0" step="0.1" type="number" value={vectorStyle.scale} onChange={(event) => { const value = numberValue(event.currentTarget.value); if (value !== null && value > 0) patchVectorStyle({ scale: value }); }} />
        <FormField disabled={disabled || !vectorQuantity} hint={vectorHint} label="Vector opacity" max="1" min="0" step="0.05" type="number" value={vectorStyle.opacity} onChange={(event) => { const value = numberValue(event.currentTarget.value); if (value !== null && value >= 0 && value <= 1) patchVectorStyle({ opacity: value }); }} />
        <FormField disabled={disabled || !vectorQuantity} hint={vectorHint} label="Vector thickness" max="16" min="0.1" step="0.1" type="number" value={vectorStyle.thickness} onChange={(event) => { const value = numberValue(event.currentTarget.value); if (value !== null && value > 0 && value <= 16) patchVectorStyle({ thickness: value }); }} />
        <FormField disabled={disabled || !vectorQuantity} hint={vectorHint} label="Vector length mode" type="select" value={vectorStyle.length_mode} onChange={(event) => patchVectorStyle({ length_mode: event.currentTarget.value })}>
          {PLANAR_VECTOR_LENGTH_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </FormField>
        <FormField disabled={disabled || !vectorQuantity} hint={vectorHint} label="Vector color mode" type="select" value={vectorStyle.color_mode} onChange={(event) => patchVectorStyle({ color_mode: event.currentTarget.value })}>
          {PLANAR_VECTOR_COLOR_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </FormField>
        {vectorStyle.color_mode === "monochrome" ? (
          <ColorField disabled={disabled || !vectorQuantity} label="Vector color" value={vectorStyle.monochrome_color} onChange={(color) => patchVectorStyle({ monochrome_color: color })} />
        ) : null}
      </InspectorGroup>
      <InspectorGroup
        collapsible
        defaultOpen={false}
        icon={<Layers3 aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary={morePassesOn.length > 0 ? morePassesOn.join(", ") : "Off"}
        title="More drawing"
        variant="nav"
      >
        <VisualizationDisplayPassesControl items={passItems(MORE_PASS_ITEMS)} />
        {morePassReasons.length > 0 ? (
          <p className="fm-planar-layer-editor__reasons">
            {morePassReasons.map(([pass, reason]) => `${pass}: ${reason}`).join(" ")}
          </p>
        ) : null}
      </InspectorGroup>
      <div className="fm-inspector-toolbar">
        <Button
          disabled={disabled}
          disabledReason={targetReason}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onWrite(removeFieldLayer(layers, layerId), layerId, { flush: true })}
        >
          {fallsBackToAll ? "Use All objects setting" : "Remove from 2D view"}
        </Button>
      </div>
    </InspectorGroup>
  );
}

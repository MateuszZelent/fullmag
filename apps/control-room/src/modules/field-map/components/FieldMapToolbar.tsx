"use client";

import type { ReactNode } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { normalizeTensorProjection, tensorProjectionOutputKind, type TensorProjectionToken } from "@/kernel/api/tensorFieldProjection";
import { quantityDisplayName } from "@/kernel/api/quantityIds";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  PLANAR_COMPONENT_PRESETS,
  activePlanarComponentPreset,
  planarComponentPresetPatch,
  type PlanarComponentPreset,
} from "../model/planarComponentPresets";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarPatch = Partial<Omit<PlanarState, "layers">> & { layers?: PlanarState["layers"] };

export interface FieldMapToolbarQuantity {
  components: number;
  label: string;
  quantityId: string;
  unit: string;
  tensor?: boolean;
  projections?: readonly { value: TensorProjectionToken; label: string }[];
}

/**
 * One row of the most frequent 2D decisions above the map, as in the mumax3
 * Display panel: quantity, component, plane and layer, arrows and mesh. Every
 * control patches the same `visualization/state.planar` as the Inspector.
 */
export function FieldMapToolbar({
  planar,
  quantities,
  sectionStrip,
  onPatch,
}: {
  planar: PlanarState;
  quantities: readonly FieldMapToolbarQuantity[];
  sectionStrip: ReactNode;
  onPatch: (patch: PlanarPatch) => void;
}) {
  const current = quantities.find((quantity) => quantity.quantityId === planar.quantity_id);
  const tensorQuantity = current?.tensor === true || (current?.components ?? 3) > 3 ||
    normalizeTensorProjection(planar.component) !== null;
  const vectorQuantity = tensorQuantity
    ? tensorProjectionOutputKind(planar.component) === "vector" &&
      current?.projections?.some((option) => option.value === planar.component) === true
    : (current?.components ?? 3) > 1;
  const preset = activePlanarComponentPreset(planar);
  const listed: readonly FieldMapToolbarQuantity[] = current
    ? quantities
    : [
        { components: 3, label: quantityDisplayName(planar.quantity_id), quantityId: planar.quantity_id, unit: "" },
        ...quantities,
      ];

  const selectQuantity = (quantityId: string) => {
    const next = listed.find((quantity) => quantity.quantityId === quantityId);
    if (next?.tensor || (next?.components ?? 3) > 3) {
      const projection = next?.projections?.find((option) => option.value === "frobenius") ?? next?.projections?.[0];
      if (!projection) return;
      onPatch({ quantity_id: quantityId, component: projection.value, colormap: "viridis",
        layers: { ...planar.layers, vectors: false } });
      return;
    }
    const nextIsVector = (next?.components ?? 3) > 1;
    const keepPreset: PlanarComponentPreset = nextIsVector && preset ? preset : "magnitude";
    onPatch({
      quantity_id: quantityId,
      ...planarComponentPresetPatch(keepPreset, planar.range),
    });
  };

  return (
    <div aria-label="2D view controls" className="fm-field-map__controls" role="toolbar">
      <div className="fm-field-map__control">
        <span className="fm-field-map__control-label" id="fm-field-map-quantity-label">Quantity</span>
        <Select value={planar.quantity_id} onValueChange={selectQuantity}>
          <SelectTrigger
            aria-labelledby="fm-field-map-quantity-label"
            className="fm-field-map__quantity-trigger"
            density="compact"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {listed.map((quantity) => (
              <SelectItem disabled={(quantity.tensor === true || quantity.components > 3) && !quantity.projections?.length} key={quantity.quantityId} value={quantity.quantityId}>
                {quantity.label}{quantity.unit ? ` (${quantity.unit})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {tensorQuantity ? (
        <Select
          value={planar.component}
          disabled={!current?.projections?.length}
          onValueChange={(value) => {
            const projection = current?.projections?.find((option) => option.value === value);
            if (!projection) return;
            onPatch({ component: projection.value, colormap: "viridis",
              ...(tensorProjectionOutputKind(projection.value) === "scalar"
                ? { layers: { ...planar.layers, vectors: false } } : {}) });
          }}
        >
          <SelectTrigger aria-label="Tensor projection" density="compact"><SelectValue /></SelectTrigger>
          <SelectContent>{current?.projections?.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}</SelectContent>
        </Select>
      ) : vectorQuantity ? (
        <SegmentedControl
          aria-label="Component"
          className="fm-field-map__component"
          options={PLANAR_COMPONENT_PRESETS.map((item) => ({
            accessibleLabel: `${item.label} (${item.shortcut})`,
            label: item.label,
            value: item.value,
          }))}
          value={preset ?? "magnitude"}
          onValueChange={(value) => onPatch(planarComponentPresetPatch(value, planar.range))}
        />
      ) : (
        <span className="fm-field-map__control-label">Scalar field</span>
      )}
      {sectionStrip}
      <div className="fm-field-map__toggles">
        <Button
          aria-keyshortcuts="A"
          aria-pressed={planar.layers.vectors}
          disabled={!vectorQuantity}
          size="sm"
          type="button"
          variant={planar.layers.vectors ? "primary" : "ghost"}
          onClick={() => onPatch({ layers: { ...planar.layers, vectors: !planar.layers.vectors } })}
        >
          Arrows
        </Button>
        <Button
          aria-keyshortcuts="G"
          aria-pressed={planar.layers.mesh}
          size="sm"
          type="button"
          variant={planar.layers.mesh ? "primary" : "ghost"}
          onClick={() => onPatch({ layers: { ...planar.layers, mesh: !planar.layers.mesh } })}
        >
          Mesh
        </Button>
      </div>
    </div>
  );
}

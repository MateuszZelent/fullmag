"use client";

import type { Selection } from "@/kernel/selection/selectionTypes";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarFieldMetaResource } from "@/kernel/resources/planarFieldResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useFieldCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";
import {
  scalarColorbarDisplayUnitItems,
  SCALAR_COLOR_PALETTE_ITEMS,
} from "../panels/ObjectVisualizationPanelModel";
import {
  planarViewScopeForSelection,
  planarVisualizationCoverage,
} from "./VisualizationViewContext";

export function PlanarVisualizationSection({
  selection,
}: {
  selection: Selection;
}) {
  const { visualizationSync } = useKernel();
  const visualization = useVisualizationStateResource();
  const planar = visualization.data?.planar;
  const coverage = planarVisualizationCoverage(selection);
  const viewScope = planarViewScopeForSelection(selection);
  const monitors = usePlanarMonitorsResource({ enabled: coverage.supported });
  const fieldCatalog = useFieldCatalogResource({ enabled: coverage.supported });
  const monitorId = planar?.active_monitor_id ?? "";
  const quantityId = planar?.quantity_id ?? "";
  const meta = usePlanarFieldMetaResource(
    quantityId,
    monitorId,
    planar
      ? {
          component: planar.component,
          resolution_x: planar.resolution.width,
          resolution_y: planar.resolution.height,
          scope_id: planar.view_scope.kind === "mesh_part" ? planar.view_scope.scope_id : undefined,
          scope_kind: planar.view_scope.kind,
        }
      : {},
    { enabled: coverage.supported && planar !== undefined && monitorId.length > 0 },
  );
  const patch = (
    next: NonNullable<
      Parameters<typeof visualizationSync.queuePatch>[0]["planar"]
    >,
  ) => visualizationSync.queuePatch({ planar: next });
  const selectedDescriptor = fieldCatalog.data?.quantities.find(
    (quantity) => quantity.quantity_id === quantityId,
  );
  const componentItems =
    (selectedDescriptor?.components ?? 3) > 1
      ? [
          "x",
          "y",
          "z",
          "u",
          "v",
          "normal",
          "magnitude",
          "in_plane_magnitude",
          "orientation",
        ]
      : ["magnitude"];
  const canonicalUnit =
    meta.data?.canonical_unit ?? selectedDescriptor?.unit ?? "";
  const displayUnitItems = scalarColorbarDisplayUnitItems(canonicalUnit);

  if (!coverage.supported) {
    return (
      <InspectorGroup title="2D visualization">
        <FieldRow label="Availability" value="Not a spatial target" />
        <FieldRow label="Reason" value="quantity_or_target_not_spatial" />
      </InspectorGroup>
    );
  }

  if (!planar) {
    return (
      <InspectorGroup title="2D visualization">
        <FieldRow
          label="Availability"
          value={visualization.status === "error" ? "Unavailable" : "Loading planar visualization state"}
        />
      </InspectorGroup>
    );
  }

  const range = planar.range ?? { mode: "auto" as const, min: null, max: null };
  const automaticRange = range.mode === "auto";
  const rangeMin = range.min;
  const rangeMax = range.max;
  const manualRange =
    range.mode === "manual" &&
    typeof rangeMin === "number" &&
    typeof rangeMax === "number"
      ? { mode: "manual" as const, min: rangeMin, max: rangeMax }
      : { mode: "manual" as const, min: -1, max: 1 };

  return (
    <InspectorGroup title="2D visualization">
      <FieldRow label="Target" value={coverage.targetKind} />
      <FormField
        label="Monitor"
        type="select"
        value={monitorId}
        onChange={(event) =>
          patch({ active_monitor_id: event.currentTarget.value || null })
        }
      >
        <option value="">Select monitor</option>
        {(monitors.data?.monitors ?? []).map((monitor) => (
          <option key={monitor.id} value={monitor.id}>
            {monitor.name}
          </option>
        ))}
      </FormField>
      <FormField
        label="Quantity"
        type="select"
        value={quantityId}
        onChange={(event) =>
          patch({
            component: "magnitude",
            quantity_id: event.currentTarget.value,
          })
        }
      >
        {(fieldCatalog.data?.quantities ?? []).flatMap((quantity) =>
          quantity.available
            ? [(
            <option key={quantity.quantity_id} value={quantity.quantity_id}>
              {quantity.label} ({quantity.unit || "1"})
            </option>
              )]
            : [],
        )}
      </FormField>
      <FormField
        label="Component"
        type="select"
        value={planar.component}
        onChange={(event) =>
          patch({
            component: event.currentTarget.value as NonNullable<
              VisualizationStateResource["planar"]
            >["component"],
          })
        }
      >
        {componentItems.map((component) => (
          <option key={component} value={component}>
            {component.replaceAll("_", " ")}
          </option>
        ))}
      </FormField>
      <FormField
        label="Color map"
        type="select"
        value={planar.colormap}
        onChange={(event) => patch({ colormap: event.currentTarget.value })}
      >
        {SCALAR_COLOR_PALETTE_ITEMS.map((palette) => (
          <option key={palette.value} value={palette.value}>
            {palette.label}
          </option>
        ))}
      </FormField>
      {displayUnitItems.length > 1 ? (
        <FormField
          label="Display unit"
          type="select"
          value={planar.display_unit ?? displayUnitItems[0]?.value ?? ""}
          onChange={(event) =>
            patch({ display_unit: event.currentTarget.value || null })
          }
        >
          {displayUnitItems.map((unit) => (
            <option key={unit.value} value={unit.value}>
              {unit.label}
            </option>
          ))}
        </FormField>
      ) : (
        <FieldRow label="Unit" value={canonicalUnit || "dimensionless"} />
      )}
      <InspectorPropertyRow label="Automatic range">
        <Switch
          aria-label="Automatic planar color range"
          checked={automaticRange}
          onCheckedChange={(checked) =>
            patch({
              range: checked
                ? { mode: "auto", min: null, max: null }
                : manualRange,
            })
          }
        />
      </InspectorPropertyRow>
      {!automaticRange ? (
        <>
          <FormField
            label="Range minimum"
            type="number"
            value={manualRange.min}
            onChange={(event) => {
              const min = event.currentTarget.valueAsNumber;
              if (Number.isFinite(min) && min < manualRange.max) {
                patch({ range: { mode: "manual", min, max: manualRange.max } });
              }
            }}
          />
          <FormField
            label="Range maximum"
            type="number"
            value={manualRange.max}
            onChange={(event) => {
              const max = event.currentTarget.valueAsNumber;
              if (Number.isFinite(max) && manualRange.min < max) {
                patch({ range: { mode: "manual", min: manualRange.min, max } });
              }
            }}
          />
        </>
      ) : null}
      <FieldRow
        label="Availability"
        value={
          !monitorId
            ? "Select a planar monitor"
            : meta.status === "error"
              ? "Unavailable for this target"
              : meta.status
        }
      />
      {meta.data ? (
        <>
          <FieldRow label="Sampling" value={meta.data.sampling_method} />
          <FieldRow
            label="Occupancy"
            value={`${meta.data.occupancy.occupied_measure}`}
          />
        </>
      ) : null}
      <FieldRow
        label="Resolution"
        value={
          `${planar.resolution.width} × ${planar.resolution.height}`
        }
      />
      <div className="fm-inspector-toolbar">
        <Button
          disabled={!monitorId}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            patch({ view_scope: viewScope })
          }
        >
          Use target scope
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() =>
            patch({
              layers: {
                boundaries: planar.layers.boundaries,
                contours: !planar.layers.contours,
                mesh: planar.layers.mesh,
                probes: planar.layers.probes,
                raster: planar.layers.raster,
                vectors: planar.layers.vectors,
              },
            })
          }
        >
          Toggle contours
        </Button>
      </div>
    </InspectorGroup>
  );
}

"use client";

import { useRef } from "react";

import type { PlanarFieldProfileResource } from "@/kernel/api/apiTypes";
import { ChartExportControls } from "@/shared/analysis-charts/ChartExportControls";
import { EChartsCanvasSurface } from "@/shared/analysis-charts/EChartsCanvasSurface";
import type { ChartRendererOwner } from "@/shared/analysis-charts/chartRenderer";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { Button } from "@/shared/ui/Button";
import { type PlanarProfileDisplay, planarProfileChartModel } from "./PlanarProfileChart.model";

export function PlanarProfileChart({
  display,
  onClear,
  profile,
  quantityLabel,
  status,
}: {
  display: PlanarProfileDisplay;
  onClear: () => void;
  profile: PlanarFieldProfileResource | null;
  quantityLabel: string;
  status: string;
}) {
  const exportRef = useRef<ChartRendererOwner | null>(null);
  const model = profile ? planarProfileChartModel(profile, display, quantityLabel) : null;
  const faces = profile?.points.filter((point) => point.kind === "element_face").length ?? 0;
  return (
    <section aria-label="Line profile" className="fm-field-map__profile">
      <div className="fm-field-map__profile-header">
        <span>
          Line profile
          {profile
            ? ` · L = ${formatValueWithUnit(profile.length_m * display.lengthScale, display.lengthUnit)} · ${profile.points.length} points${faces ? ` (${faces} element faces)` : ""}`
            : ` · ${status}`}
        </span>
        <Button size="sm" type="button" variant="ghost" onClick={onClear}>
          Clear (Esc)
        </Button>
      </div>
      {model && model.status === "ready" ? (
        <>
          <EChartsCanvasSurface
            className="fm-field-map__profile-chart"
            exportRef={exportRef}
            model={model}
          />
          <ChartExportControls model={model} rendererRef={exportRef} />
        </>
      ) : model ? (
        <p role="status">{model.statusMessage}</p>
      ) : null}
    </section>
  );
}

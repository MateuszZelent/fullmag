"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CrossSectionQualityQuery } from "@/kernel/api/apiTypes";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import {
  useCrossSectionQualityResource,
  useCrossSectionResource,
} from "@/kernel/resources/crossSectionResources";
import type { ModuleProps } from "@/kernel/types";
import {
  activeCrossSectionPlot,
  selectCrossSectionPlot,
  type CrossSectionPlot,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";

import { Viewport2DScene } from "./layers/Viewport2DScene";
import { Viewport2DColorbar } from "./Viewport2DColorbar";
import { Viewport2DHoverInfoLayer } from "./Viewport2DHoverInfoLayer";
import { Viewport2DPlotTabs } from "./Viewport2DPlotTabs";
import {
  buildViewport2DLoadState,
  DEFAULT_VIEWPORT_2D_METRIC,
  DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
  FALLBACK_VIEWPORT_2D_QUERY,
} from "./viewport2dLoadState";
import { viewport2dHudText } from "./viewport2dHud";
import type { Viewport2DPolygonHover } from "./viewport2dHoverTooltip";
import type { Viewport2DPolygonSummary } from "./viewport2dRenderModel";
import { resolveViewport2DPolygonSelection } from "./viewport2dSelection";
import { resolveViewport2DSelectedPolygon } from "./viewport2dSelectedPolygon";

function useViewport2DThemeColors(): {
  wireframeColor: [number, number, number];
  gridColor: [number, number, number];
  axisColor: [number, number, number];
  hoverColor: [number, number, number];
  selectionColor: [number, number, number];
} {
  const [colors, setColors] = useState({
    wireframeColor: [0.85, 0.88, 0.92] as [number, number, number],
    gridColor: [0.32, 0.36, 0.42] as [number, number, number],
    axisColor: [0.72, 0.78, 0.86] as [number, number, number],
    hoverColor: [1, 0.92, 0.32] as [number, number, number],
    selectionColor: [0.58, 0.86, 1] as [number, number, number],
  });

  useEffect(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const parse = (varName: string, fallback: [number, number, number]): [number, number, number] => {
      const raw = style.getPropertyValue(varName).trim();
      if (!raw || !raw.startsWith("#")) return fallback;
      const hex = raw.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      return [r, g, b];
    };
    setColors({
      wireframeColor: parse("--fm-text-secondary", [0.85, 0.88, 0.92]),
      gridColor: parse("--fm-border-subtle", [0.32, 0.36, 0.42]),
      axisColor: parse("--fm-text-muted", [0.72, 0.78, 0.86]),
      hoverColor: parse("--fm-warning", [1, 0.92, 0.32]),
      selectionColor: parse("--fm-accent", [0.58, 0.86, 1]),
    });
  }, []);

  return colors;
}

export default function Viewport2DModule({ kernel, moduleId }: ModuleProps) {
  const [hoveredPolygon, setHoveredPolygon] =
    useState<Viewport2DPolygonHover | null>(null);
  const [fitRequestVersion, setFitRequestVersion] = useState(0);
  const themeColors = useViewport2DThemeColors();
  const activePlot = useCrossSectionWorkspaceSelector(activeCrossSectionPlot);
  const activePlotId = useCrossSectionWorkspaceSelector(
    (state) => state.activePlotId,
  );
  const plots = useCrossSectionWorkspaceSelector((state) => state.plots);
  const selectionRef = useSelectionSelector((selection) => selection.ref);
  const hasActivePlot = Boolean(activePlot);
  const query = activePlot?.query ?? FALLBACK_VIEWPORT_2D_QUERY;
  const metric = activePlot?.metric ?? DEFAULT_VIEWPORT_2D_METRIC;
  const renderOptions =
    activePlot?.renderOptions ?? DEFAULT_VIEWPORT_2D_RENDER_OPTIONS;
  const qualityQuery = useMemo<CrossSectionQualityQuery>(
    () => ({
      metric,
      plane: query.plane,
      positionPercent: query.positionPercent,
    }),
    [metric, query.plane, query.positionPercent],
  );
  const crossSection = useCrossSectionResource(query, {
    enabled: hasActivePlot,
  });
  const quality = useCrossSectionQualityResource(qualityQuery, {
    enabled:
      hasActivePlot &&
      crossSection.status === "ready" &&
      Boolean(crossSection.data),
  });
  const state = useMemo(
    () =>
      buildViewport2DLoadState({
        crossSection,
        hasActivePlot,
        metric,
        quality,
        query,
        renderOptions,
      }),
    [crossSection, hasActivePlot, metric, quality, query, renderOptions],
  );
  useEffect(
    () =>
      kernel.bus.on("viewport-2d:fit-requested", () => {
        setHoveredPolygon(null);
        setFitRequestVersion((version) => version + 1);
      }),
    [kernel.bus],
  );

  const selectPolygon = useCallback(
    (polygon: Viewport2DPolygonSummary) => {
      kernel.selection.set(
        resolveViewport2DPolygonSelection(polygon, metric),
        moduleId,
      );
      kernel.layout.setPanelVisible("right", true);
    },
    [kernel.layout, kernel.selection, metric, moduleId],
  );
  const selectPlot = useCallback(
    (plot: CrossSectionPlot) => {
      const selectedPlot = selectCrossSectionPlot(plot.id) ?? plot;
      const nodeId = `model:visualizations-2d:${selectedPlot.id}`;
      kernel.selection.set(
        {
          kind: "mesh.cross-section.plot",
          label: selectedPlot.name,
          nodeId,
          objectId: null,
          ref: {
            kind: "mesh.cross-section.plot",
            nodeId,
            plotId: selectedPlot.id,
            type: "cross-section-plot",
            visualizationTargetId: `cross-section:plot:${selectedPlot.id}`,
          },
        },
        moduleId,
      );
      kernel.layout.setPanelVisible("right", true);
    },
    [kernel.layout, kernel.selection, moduleId],
  );

  const visibleHover =
    state.status === "ready" && hoveredPolygon
      ? {
          ...hoveredPolygon,
          polygon:
            state.model.polygons[hoveredPolygon.polygon.polygonIndex] ??
            hoveredPolygon.polygon,
        }
      : null;
  const visibleHoveredPolygon = visibleHover?.polygon ?? null;
  const selectedPolygon =
    state.status === "ready"
      ? resolveViewport2DSelectedPolygon(state.model, { ref: selectionRef })
      : null;

  return (
    <div className="fm-viewport-2d">
      <Viewport2DPlotTabs
        activePlotId={activePlot?.id ?? activePlotId}
        plots={plots}
        onPlotSelect={selectPlot}
      />
      {state.status === "ready" ? (
        <Canvas
          className="fm-viewport-2d__canvas"
          frameloop="demand"
          orthographic
          camera={{ position: [0, 0, 10], zoom: 1 }}
          onPointerMissed={() => setHoveredPolygon(null)}
        >
          <Viewport2DScene
            fitRequestVersion={fitRequestVersion}
            hoveredPolygon={visibleHoveredPolygon}
            hoverColor={themeColors.hoverColor}
            model={state.model}
            onHoverPolygon={setHoveredPolygon}
            onSelectPolygon={selectPolygon}
            selectedPolygon={selectedPolygon}
            selectionColor={themeColors.selectionColor}
            wireframeColor={themeColors.wireframeColor}
          />
        </Canvas>
      ) : null}
      {state.status === "ready" ? (
        <Viewport2DColorbar
          colorScale={renderOptions.colorScale}
          metric={state.metric}
          range={state.model.qualityRange}
        />
      ) : null}
      {state.status === "ready" ? (
        <Viewport2DHoverInfoLayer hover={visibleHover} metric={state.metric} />
      ) : null}
      <div className="fm-viewport-2d__hud">
        {viewport2dHudText(state, visibleHoveredPolygon).map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </div>
    </div>
  );
}

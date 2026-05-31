"use client";

import Image from "next/image";
import { useEffect, useMemo } from "react";
import { Download } from "lucide-react";

import type { CrossSectionImageQuery } from "@/kernel/api/apiTypes";
import { useCrossSectionImageResource } from "@/kernel/resources/crossSectionResources";
import {
  activeCrossSectionPlot,
  selectCrossSectionPlot,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import { createObjectUrl, revokeObjectUrl } from "./objectUrl";

const FALLBACK_QUERY: CrossSectionImageQuery = {
  metric: "skewness",
  plane: "xy",
  positionPercent: 50,
};

export default function CrossSectionImageModule() {
  const workspace = useCrossSectionWorkspaceSelector((state) => state);
  const plot = activeCrossSectionPlot(workspace);
  const imageQuery = useMemo(
    () => (plot ? crossSectionImageQueryFromPlot(plot) : FALLBACK_QUERY),
    [plot],
  );
  const image = useCrossSectionImageResource(imageQuery, {
    enabled: Boolean(plot),
  });
  const imageUrl = useObjectUrl(image.data, "image/png");

  if (!plot) {
    return (
      <div className="fm-cross-section-image fm-cross-section-image--empty">
        <div className="fm-cross-section-image__empty">
          No cross-section image generated
        </div>
      </div>
    );
  }

  return (
    <div className="fm-cross-section-image">
      <div className="fm-cross-section-image__toolbar">
        <div className="fm-cross-section-image__plot-tabs" role="tablist">
          {workspace.plots.map((entry) => (
            <button
              key={entry.id}
              aria-selected={entry.id === plot.id}
              className="fm-cross-section-image__plot-tab"
              role="tab"
              type="button"
              onClick={() => selectCrossSectionPlot(entry.id)}
            >
              <span>{entry.name}</span>
              <small>
                {entry.plane.toUpperCase()} {entry.positionPercent}%
              </small>
            </button>
          ))}
        </div>
        {imageUrl ? (
          <Button asChild size="sm" variant="secondary">
            <a
              download={`${plot.name.replace(/\s+/g, "-").toLowerCase()}.png`}
              href={imageUrl}
            >
              <Download size={14} aria-hidden="true" />
              Download PNG
            </a>
          </Button>
        ) : null}
      </div>
      <div className="fm-cross-section-image__stage">
        {image.status === "error" ? (
          <div className="fm-cross-section-image__empty">
            {image.error?.message ?? "Cross-section image unavailable"}
          </div>
        ) : null}
        {image.status !== "error" && !imageUrl ? (
          <div className="fm-cross-section-image__empty">
            {image.status === "ready"
              ? "No cross-section image available"
              : "Generating cross-section image"}
          </div>
        ) : null}
        {imageUrl ? (
          <Image
            alt={`${plot.name} cross-section`}
            className="fm-cross-section-image__img"
            height={imageQuery.resolution ?? 4096}
            src={imageUrl}
            style={{ width: "100%", height: "auto" }}
            unoptimized
            width={imageQuery.resolution ?? 4096}
          />
        ) : null}
      </div>
    </div>
  );
}

function crossSectionImageQueryFromPlot(
  plot: NonNullable<ReturnType<typeof activeCrossSectionPlot>>,
): CrossSectionImageQuery {
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio ?? 1, 2) : 1;
  return {
    colorScale: plot.renderOptions.colorScale,
    dpr,
    edgeWidth: plot.renderOptions.edgeWidth ?? 1.5,
    filterExpression: plot.renderOptions.filterExpression,
    legend: true,
    metric: plot.metric,
    plane: plot.plane,
    positionPercent: plot.positionPercent,
    resolution: 4096,
    rotationDegrees: plot.rotationDegrees,
    shrinkFactor: plot.renderOptions.shrinkFactor,
    wireframe: plot.renderOptions.wireframeVisible,
  };
}

function useObjectUrl(data: ArrayBuffer | null, contentType: string): string | null {
  const url = useMemo(() => {
    return createObjectUrl(data, contentType);
  }, [contentType, data]);

  useEffect(() => {
    if (!url) return undefined;
    return () => {
      revokeObjectUrl(url);
    };
  }, [url]);

  return url;
}

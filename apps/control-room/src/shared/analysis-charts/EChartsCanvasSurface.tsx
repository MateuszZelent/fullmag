"use client";

import { useEffect, useReducer, useRef, type MutableRefObject, type ReactNode } from "react";

import type { ECharts } from "echarts";

import {
  createChartRendererOwner,
  type ChartRenderModel,
  type ChartRendererInstance,
  type ChartRendererListeners,
  type ChartRendererOwner,
} from "./chartRenderer";

export function EChartsCanvasSurface({
  children,
  className = "fm-analysis-plots__echarts",
  model,
  onClick,
  onDataZoom,
  onDoubleClick,
  diagnostics,
  exportRef,
}: {
  children?: ReactNode;
  diagnostics?: {
    instanceCreated?: (instance: ChartRendererInstance) => void;
    instanceDisposed?: () => void;
    modelUpdated?: (model: ChartRenderModel) => void;
    setOption?: () => void;
    resized?: () => void;
  };
  className?: string;
  exportRef?: MutableRefObject<ChartRendererOwner | null>;
  model: ChartRenderModel;
  onClick?: (event: unknown) => void;
  onDataZoom?: (event: unknown) => void;
  onDoubleClick?: (event: unknown) => void;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef(model);
  const ownerRef = useRef<ChartRendererOwner | null>(null);
  const callbacksRef = useRef({ diagnostics, onClick, onDataZoom, onDoubleClick });
  const [rendererStatus, setRendererStatus] = useReducer(
    (_: "loading" | "ready" | "error", next: "loading" | "ready" | "error") => next,
    "loading",
  );

  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    callbacksRef.current = { diagnostics, onClick, onDataZoom, onDoubleClick };
  }, [diagnostics, onClick, onDataZoom, onDoubleClick]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let cancelled = false;
    let frame = 0;
    let observer: ResizeObserver | null = null;
    const listeners: ChartRendererListeners = {
      click: (event) => callbacksRef.current.onClick?.(event),
      dataZoom: (event) => callbacksRef.current.onDataZoom?.(event),
      dblclick: (event) => callbacksRef.current.onDoubleClick?.(event),
    };

    void import("echarts")
      .then((echarts) => {
        if (cancelled) return;
        const owner = createChartRendererOwner(
          { init: (target) => {
            const instance = echarts.init(target, undefined, { renderer: "canvas" }) as ECharts;
            callbacksRef.current.diagnostics?.instanceCreated?.(instance);
            return instance;
          } },
          listeners,
        );
        ownerRef.current = owner;
        if (exportRef) exportRef.current = owner;
        owner.mount(element);
        owner.update(modelRef.current);
        callbacksRef.current.diagnostics?.modelUpdated?.(modelRef.current);
        callbacksRef.current.diagnostics?.setOption?.();
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            callbacksRef.current.diagnostics?.resized?.();
            owner.resize();
          });
        });
        observer.observe(element);
        setRendererStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setRendererStatus("error");
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      cancelAnimationFrame(frame);
      if (ownerRef.current) {
        ownerRef.current.dispose();
        callbacksRef.current.diagnostics?.instanceDisposed?.();
      }
      ownerRef.current = null;
      if (exportRef) exportRef.current = null;
    };
  }, [exportRef]);

  useEffect(() => {
    ownerRef.current?.update(model);
    if (ownerRef.current) {
      callbacksRef.current.diagnostics?.modelUpdated?.(model);
      callbacksRef.current.diagnostics?.setOption?.();
    }
  }, [model]);

  const status = surfaceStatus(model, rendererStatus);
  return (
    <div aria-label={model.ariaLabel} className="fm-analysis-chart-surface">
      <div ref={elementRef} className={className} data-chart-model-key={model.key} />
      {status ? (
        <div className="fm-analysis-plots__chart-empty" role={status.role}>
          {status.label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function surfaceStatus(
  model: ChartRenderModel,
  rendererStatus: "loading" | "ready" | "error",
): { label: string; role: "alert" | "status" } | null {
  if (model.status === "error" || rendererStatus === "error") {
    return { label: model.statusMessage ?? "Chart renderer unavailable", role: "alert" };
  }
  if (model.status === "unsupported") {
    return { label: model.statusMessage ?? "Chart unsupported", role: "status" };
  }
  if (model.status === "empty" || model.series.every((series) => series.points.length === 0)) {
    return { label: model.statusMessage ?? "No chart samples", role: "status" };
  }
  if (model.status === "loading" || rendererStatus === "loading") {
    return { label: model.statusMessage ?? "Loading chart renderer", role: "status" };
  }
  if (model.status === "stale" || model.status === "degraded") {
    return { label: model.statusMessage ?? "Chart data is degraded", role: "status" };
  }
  return null;
}

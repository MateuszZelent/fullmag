"use client";

import {
  useEffect,
  useReducer,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";

import type { ECharts } from "echarts";

import {
  createChartRendererOwner,
  type ChartRenderModel,
  type ChartRendererInstance,
  type ChartRendererListeners,
  type ChartRendererOwner,
} from "./chartRenderer";
import {
  resolveChartTokens,
  type FullmagChartTokens,
} from "./fullmagChartTokens";

export function EChartsCanvasSurface({
  children,
  className = "fm-analysis-plots__echarts",
  fitRequest = 0,
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
  fitRequest?: number;
  model: ChartRenderModel;
  onClick?: (event: unknown) => void;
  onDataZoom?: (event: unknown) => void;
  onDoubleClick?: (event: unknown) => void;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef(model);
  const ownerRef = useRef<ChartRendererOwner | null>(null);
  const tokensRef = useRef<FullmagChartTokens | null>(null);
  const callbacksRef = useRef({ diagnostics, onClick, onDataZoom, onDoubleClick });
  const [rendererStatus, setRendererStatus] = useReducer(
    (_: "loading" | "ready" | "error", next: "loading" | "ready" | "error") =>
      next,
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
          {
            init: (target) => {
              const instance = echarts.init(target, undefined, {
                renderer: "canvas",
              }) as ECharts;
              callbacksRef.current.diagnostics?.instanceCreated?.(instance);
              return instance;
            },
          },
          listeners,
        );
        ownerRef.current = owner;
        if (exportRef) exportRef.current = owner;

        // Resolve tokens once at mount
        tokensRef.current = resolveChartTokens(element);

        owner.mount(element);
        owner.update(modelRef.current, tokensRef.current ?? undefined);
        callbacksRef.current.diagnostics?.modelUpdated?.(modelRef.current);
        callbacksRef.current.diagnostics?.setOption?.();

        // Track theme changes via MutationObserver on <html data-theme>
        const htmlElement = element.ownerDocument?.documentElement;
        let themeObserver: MutationObserver | null = null;
        if (htmlElement) {
          themeObserver = new MutationObserver(() => {
            tokensRef.current = resolveChartTokens(element);
            owner.update(modelRef.current, tokensRef.current);
            callbacksRef.current.diagnostics?.modelUpdated?.(modelRef.current);
            callbacksRef.current.diagnostics?.setOption?.();
          });
          themeObserver.observe(htmlElement, {
            attributeFilter: ["data-theme"],
            attributes: true,
          });
        }

        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            callbacksRef.current.diagnostics?.resized?.();
            owner.resize();
          });
        });
        observer.observe(element);
        setRendererStatus("ready");

        // Extend cleanup to include theme observer
        const origDispose = owner.dispose.bind(owner);
        owner.dispose = () => {
          themeObserver?.disconnect();
          origDispose();
          callbacksRef.current.diagnostics?.instanceDisposed?.();
        };
      })
      .catch(() => {
        if (!cancelled) setRendererStatus("error");
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      cancelAnimationFrame(frame);
      ownerRef.current?.dispose();
      ownerRef.current = null;
      if (exportRef) exportRef.current = null;
    };
  }, [exportRef]);

  useEffect(() => {
    ownerRef.current?.update(model, tokensRef.current ?? undefined);
    if (ownerRef.current) {
      callbacksRef.current.diagnostics?.modelUpdated?.(model);
      callbacksRef.current.diagnostics?.setOption?.();
    }
  }, [model]);

  useEffect(() => {
    if (fitRequest > 0) ownerRef.current?.fitView();
  }, [fitRequest]);

  const status = surfaceStatus(model, rendererStatus);
  return (
    <div
      aria-describedby={`${model.key}-summary`}
      aria-label={model.ariaLabel}
      className="fm-analysis-chart-surface"
      role="img"
    >
      <div
        ref={elementRef}
        className={className}
        data-chart-model-key={model.key}
      />
      <p className="fm-visually-hidden" id={`${model.key}-summary`}>
        {model.ariaLabel}. {model.series.length} series and {model.series.reduce((count, series) => count + series.points.length, 0)} plotted points.
        {model.statusMessage ? ` ${model.statusMessage}.` : ""}
      </p>
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
    return {
      label: model.statusMessage ?? "Chart renderer unavailable",
      role: "alert",
    };
  }
  if (model.status === "unsupported") {
    return { label: model.statusMessage ?? "Chart unsupported", role: "status" };
  }
  if (
    model.status === "empty" ||
    model.series.every((series) => series.points.length === 0)
  ) {
    return { label: model.statusMessage ?? "No chart samples", role: "status" };
  }
  if (model.status === "loading" || rendererStatus === "loading") {
    return {
      label: model.statusMessage ?? "Loading chart renderer",
      role: "status",
    };
  }
  if (model.status === "stale" || model.status === "degraded") {
    return {
      label: model.statusMessage ?? "Chart data is degraded",
      role: "status",
    };
  }
  return null;
}

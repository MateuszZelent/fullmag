import { useCallback, useEffect, useRef } from "react";

/** Column count that keeps wrapped rows as even as possible: the fewest rows
 * that fit at the minimum readout width, then the fewest columns that still
 * hold all readouts in those rows (16 readouts on 12 slots → 8 + 8). */
export function balancedMetricColumns(count: number, width: number, minWidth: number): number {
  if (count <= 0 || !(width > 0) || !(minWidth > 0)) return Math.max(1, count);
  const fit = Math.max(1, Math.floor(width / minWidth));
  const rows = Math.ceil(count / fit);
  return Math.ceil(count / rows);
}

/** Ref for the telemetry readout container. Publishes `--fm-metric-width`
 * from the container width and its density-dependent `--fm-metric-basis`. */
export function useBalancedMetricRows(count: number): (element: HTMLElement | null) => void {
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const countRef = useRef(count);

  const apply = useCallback((element: HTMLElement) => {
    const basis = Number.parseFloat(getComputedStyle(element).getPropertyValue("--fm-metric-basis"));
    const columns = balancedMetricColumns(countRef.current, element.clientWidth, basis);
    element.style.setProperty("--fm-metric-width", `${100 / columns}%`);
  }, []);

  // Refs must not be written during render. Effects run in declaration
  // order, so the count is current before the re-apply effect below; the
  // initial callback-ref apply uses the useRef initial value.
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  useEffect(() => {
    if (elementRef.current) apply(elementRef.current);
  }, [apply, count]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return useCallback(
    (element: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      elementRef.current = element;
      if (!element || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => apply(element));
      observer.observe(element);
      observerRef.current = observer;
      apply(element);
    },
    [apply],
  );
}

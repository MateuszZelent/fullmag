"use client";

import { GripHorizontal, RefreshCw, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useDataPreviewFieldVector } from "@/kernel/resources/dataPreviewResources";
import { Button } from "@/shared/ui/Button";

import {
  buildDataPreviewRows,
  buildDataPreviewSignature,
  normalizeDataPreviewSampleCount,
} from "./dataPreviewModel";

interface DataPreviewDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface DragState {
  offsetX: number;
  offsetY: number;
  pointerId: number;
}

const COMPONENT_OPTIONS = ["full", "magnitude", "x", "y", "z"];

export function DataPreviewDialog({
  onOpenChange,
  open,
}: DataPreviewDialogProps) {
  const [quantityId, setQuantityId] = useState("m");
  const [component, setComponent] = useState("full");
  const [sampleCountInput, setSampleCountInput] = useState("17");
  const [position, setPosition] = useState({ x: 96, y: 96 });
  const dragRef = useRef<DragState | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sampleCount = normalizeDataPreviewSampleCount(sampleCountInput);
  const resolvedQuantityId = quantityId.trim() || "m";
  const { resource, resourceKey, resourceRevision } = useDataPreviewFieldVector({
    component,
    enabled: open,
    maxSamples: sampleCount,
    quantityId: resolvedQuantityId,
  });
  const rows = useMemo(
    () => buildDataPreviewRows(resource.data, sampleCount),
    [resource.data, sampleCount],
  );
  const signature = useMemo(
    () => buildDataPreviewSignature(resource.data, sampleCount),
    [resource.data, sampleCount],
  );

  useEffect(() => {
    if (!open) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const panel = panelRef.current;
      const width = panel?.offsetWidth ?? 420;
      const height = panel?.offsetHeight ?? 360;
      setPosition({
        x: clamp(event.clientX - drag.offsetX, 8, window.innerWidth - width - 8),
        y: clamp(event.clientY - drag.offsetY, 8, window.innerHeight - height - 8),
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null;
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [open]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0) return;
    const bounds = panel.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      pointerId: event.pointerId,
    };
  };

  if (!open) return null;

  // This panel is intentionally non-modal so it can stay open while the
  // workspace receives clicks during live solver diagnostics.
  return (
    <section
      ref={panelRef}
      aria-label="Data Preview"
      aria-modal="false"
      className="fm-data-preview"
      role="dialog"
      style={{ left: position.x, top: position.y }}
    >
      <div className="fm-data-preview__handle" onPointerDown={beginDrag}>
        <GripHorizontal size={15} aria-hidden="true" />
        <div className="fm-data-preview__heading">
          <h2>Data Preview</h2>
          <span>{resource.status}</span>
        </div>
        <Button
          aria-label="Refresh data preview"
          className="fm-data-preview__icon-btn"
          size="icon"
          title="Refresh"
          type="button"
          variant="ghost"
          onClick={resource.refetch}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
        <Button
          aria-label="Close data preview"
          className="fm-data-preview__icon-btn"
          size="icon"
          title="Close"
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>

      <form
        className="fm-data-preview__controls"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          <span>Quantity</span>
          <input
            value={quantityId}
            onChange={(event) => setQuantityId(event.target.value)}
          />
        </label>
        <label>
          <span>Component</span>
          <select
            value={component}
            onChange={(event) => setComponent(event.target.value)}
          >
            {COMPONENT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Samples</span>
          <input
            inputMode="numeric"
            value={sampleCountInput}
            onChange={(event) => setSampleCountInput(event.target.value)}
          />
        </label>
      </form>

      <dl className="fm-data-preview__meta">
        <div>
          <dt>Revision</dt>
          <dd>{String(resource.revision ?? resourceRevision ?? "none")}</dd>
        </div>
        <div>
          <dt>Signature</dt>
          <dd>{signature}</dd>
        </div>
        <div>
          <dt>Shape</dt>
          <dd>
            {resource.data
              ? `${resource.data.pointCount} points x ${resource.data.nComp}`
              : "no data"}
          </dd>
        </div>
        <div>
          <dt>Loaded</dt>
          <dd>{resource.status === "ready" ? "ready" : "waiting"}</dd>
        </div>
      </dl>

      {resource.error ? (
        <pre className="fm-data-preview__error">{resource.error.message}</pre>
      ) : null}

      <div className="fm-data-preview__table-wrap">
        <table className="fm-data-preview__table">
          <thead>
            <tr>
              <th>#</th>
              <th>source</th>
              <th>values</th>
            </tr>
          </thead>
          <tbody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <tr key={`${row.sourceIndex}:${row.index}`}>
                  <td>{row.index}</td>
                  <td>{row.sourceIndex}</td>
                  <td>{row.values.join("  ")}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={3}>No preview rows</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="fm-data-preview__resource" title={resourceKey}>
        {resourceKey}
      </div>
    </section>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

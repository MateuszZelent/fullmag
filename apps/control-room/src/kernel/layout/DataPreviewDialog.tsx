"use client";

import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useDataPreviewFieldVector } from "@/kernel/resources/dataPreviewResources";
import { useSolverStatusResource } from "@/kernel/resources/studyRuntimeResources";
import { Button } from "@/shared/ui/Button";
import { DraggablePanel } from "@/shared/ui/DraggablePanel";

import {
  buildDataPreviewRows,
  buildDataPreviewSignature,
  buildDataPreviewStepSignature,
  buildDataPreviewStepTimestamp,
  normalizeDataPreviewSampleCount,
} from "./dataPreviewModel";

interface DataPreviewDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const COMPONENT_OPTIONS = ["full", "magnitude", "x", "y", "z"];

export function DataPreviewDialog({
  onOpenChange,
  open,
}: DataPreviewDialogProps) {
  const [quantityId, setQuantityId] = useState("m");
  const [component, setComponent] = useState("full");
  const [sampleCountInput, setSampleCountInput] = useState("17");
  const sampleCount = normalizeDataPreviewSampleCount(sampleCountInput);
  const resolvedQuantityId = quantityId.trim() || "m";
  const solverStatus = useSolverStatusResource({ enabled: open });
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
  const stepSignature = useMemo(
    () => buildDataPreviewStepSignature(solverStatus.data),
    [solverStatus.data],
  );
  const stepTimestamp = useMemo(
    () => buildDataPreviewStepTimestamp(solverStatus.data),
    [solverStatus.data],
  );

  if (!open) return null;

  return (
    <DraggablePanel
      open={open}
      onOpenChange={onOpenChange}
      title="Data Preview"
      subtitle={resource.status}
      className="fm-data-preview"
      headerActions={
        <Button
          aria-label="Refresh data preview"
          className="fm-data-preview__icon-btn"
          size="icon"
          title="Refresh"
          type="button"
          variant="ghost"
          onClick={resource.refetch}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      }
    >
      <div className="fm-data-preview__controls">
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
      </div>

      <dl className="fm-data-preview__meta">
        <div>
          <dt>Step</dt>
          <dd>{stepSignature}</dd>
        </div>
        <div>
          <dt>Last step</dt>
          <dd>{stepTimestamp}</dd>
        </div>
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
          <dt>Visible</dt>
          <dd>
            {resource.data ? `${rows.length} non-zero rows` : "no data"}
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
    </DraggablePanel>
  );
}

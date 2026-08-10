"use client";

import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useDataPreviewFieldVector } from "@/kernel/resources/dataPreviewResources";
import {
  useFieldCatalogResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
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

const FULLMAG_KNOWN_QUANTITIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "m", label: "m (Magnetization)" },
  { id: "H_eff", label: "H_eff (Effective Field)" },
  { id: "H_demag", label: "H_demag (Demagnetization Field)" },
  { id: "H_ex", label: "H_ex (Exchange Field)" },
  { id: "H_zeeman", label: "H_zeeman (Zeeman Field)" },
  { id: "H_ext", label: "H_ext (External Field)" },
  { id: "H_ani", label: "H_ani (Anisotropy Field)" },
  { id: "H_dmi", label: "H_dmi (DMI Field)" },
  { id: "H_drive", label: "H_drive (Drive Field)" },
  { id: "B_drive", label: "B_drive (Drive Induction Field)" },
  { id: "H_oe", label: "H_oe (Oersted Field)" },
  { id: "H_therm", label: "H_therm (Thermal Field)" },
  { id: "dm_dt", label: "dm_dt (Magnetization Time Derivative)" },
  { id: "eden_total", label: "eden_total (Total Energy Density)" },
  { id: "eden_ex", label: "eden_ex (Exchange Energy Density)" },
  { id: "eden_demag", label: "eden_demag (Demag Energy Density)" },
  { id: "eden_ani", label: "eden_ani (Anisotropy Energy Density)" },
  { id: "eden_dmi", label: "eden_dmi (DMI Energy Density)" },
  { id: "eden_ext", label: "eden_ext (Zeeman Energy Density)" },
  { id: "mat_ms", label: "mat_ms (Saturation Magnetization Ms)" },
  { id: "mat_aex", label: "mat_aex (Exchange Stiffness Aex)" },
  { id: "mat_alpha", label: "mat_alpha (Gilbert Damping Alpha)" },
  { id: "mat_dind", label: "mat_dind (Interface DMI)" },
  { id: "mat_dbulk", label: "mat_dbulk (Bulk DMI)" },
  { id: "torque", label: "torque (Torque)" },
];

export function DataPreviewDialog({
  onOpenChange,
  open,
}: DataPreviewDialogProps) {
  const [quantityId, setQuantityId] = useState("m");
  const [component, setComponent] = useState("full");
  const [sampleCountInput, setSampleCountInput] = useState("17");
  const [copied, setCopied] = useState(false);
  const sampleCount = normalizeDataPreviewSampleCount(sampleCountInput);
  const resolvedQuantityId = quantityId.trim() || "m";
  const solverStatus = useSolverStatusResource({ enabled: open });
  const fieldCatalog = useFieldCatalogResource({ enabled: open });
  const { resource, resourceKey, resourceRevision } = useDataPreviewFieldVector({
    component,
    enabled: open,
    maxSamples: sampleCount,
    quantityId: resolvedQuantityId,
  });

  const quantityOptions = useMemo(() => {
    const catalogQuantities = fieldCatalog.data?.quantities ?? [];
    const map = new Map<string, string>();

    // 1. Add fields dynamically reported by backend catalog
    for (const item of catalogQuantities) {
      if (item.quantity_id) {
        const displayLabel = item.label
          ? `${item.quantity_id} (${item.label})`
          : item.quantity_id;
        map.set(item.quantity_id, displayLabel);
      }
    }

    // 2. Add standard Fullmag micromagnetic quantities
    for (const known of FULLMAG_KNOWN_QUANTITIES) {
      if (!map.has(known.id)) {
        map.set(known.id, known.label);
      }
    }

    // 3. Add currently selected quantity if custom
    if (quantityId && !map.has(quantityId)) {
      map.set(quantityId, quantityId);
    }

    return Array.from(map.entries()).map(([id, label]) => ({
      id,
      label,
    }));
  }, [fieldCatalog.data?.quantities, quantityId]);

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

  const handleCopy = useCallback(() => {
    const metaLines = [
      `Quantity: ${resolvedQuantityId}`,
      `Component: ${component}`,
      `Samples: ${sampleCountInput}`,
      `Step: ${stepSignature}`,
      `Last step: ${stepTimestamp}`,
      `Revision: ${String(resource.revision ?? resourceRevision ?? "none")}`,
      `Signature: ${signature}`,
      `Shape: ${
        resource.data
          ? `${resource.data.pointCount} points x ${resource.data.nComp}`
          : "no data"
      }`,
      `Visible: ${resource.data ? `${rows.length} non-zero rows` : "no data"}`,
      `Loaded: ${resource.status === "ready" ? "ready" : "waiting"}`,
    ];

    const tableHeader = "#\tsource\tvalues";
    const tableRows =
      rows.length > 0
        ? rows
            .map(
              (row) => `${row.index}\t${row.sourceIndex}\t${row.values.join("  ")}`,
            )
            .join("\n")
        : "No preview rows";

    const errorSection = resource.error
      ? `\nError:\n${resource.error.message}\n`
      : "";

    const formattedLog = [
      "=== Data Preview ===",
      metaLines.join("\n"),
      errorSection,
      "\n[Data]",
      tableHeader,
      tableRows,
      "\n[Resource]",
      resourceKey ?? "",
    ]
      .filter(Boolean)
      .join("\n");

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(formattedLog);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [
    resolvedQuantityId,
    component,
    sampleCountInput,
    stepSignature,
    stepTimestamp,
    resource.revision,
    resourceRevision,
    resource.data,
    resource.status,
    resource.error,
    signature,
    rows,
    resourceKey,
  ]);

  if (!open) return null;

  return (
    <DraggablePanel
      open={open}
      onOpenChange={onOpenChange}
      title="Data Preview"
      subtitle={resource.status}
      className="fm-data-preview"
      headerActions={
        <>
          <Button
            aria-label="Copy data preview log"
            className="fm-data-preview__icon-btn"
            size="icon"
            title={copied ? "Copied!" : "Copy log to clipboard"}
            type="button"
            variant="ghost"
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
          </Button>
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
        </>
      }
    >
      <div className="fm-data-preview__controls">
        <label>
          <span>Quantity</span>
          <select
            value={quantityId}
            onChange={(event) => setQuantityId(event.target.value)}
          >
            {quantityOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
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

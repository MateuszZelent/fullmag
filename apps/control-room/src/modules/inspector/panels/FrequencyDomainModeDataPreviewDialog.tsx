"use client";

import { useMemo } from "react";
import { RefreshCw, X } from "lucide-react";

import {
  buildDataPreviewRows,
  buildDataPreviewSignature,
} from "@/kernel/layout/dataPreviewModel";
import { useDataPreviewFieldVector } from "@/kernel/resources/dataPreviewResources";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  analysisFieldViewLabel,
  DEFAULT_ANALYSIS_FIELD_VIEW,
  normalizeAnalysisFieldView,
} from "./FrequencyDomainModeDisplayControls";

const MODE_DATA_PREVIEW_SAMPLE_COUNT = 12;

export interface FrequencyDomainModeDataPreviewFieldMeta {
  binary_layout?: string | null;
  component_basis?: string | null;
  component_count?: number | null;
  components?: readonly string[] | null;
  complex_pair_count?: number | null;
  default_view?: string | null;
  payload_encoding?: string | null;
  payload_value_count?: number | null;
  value_kind?: string | null;
}

interface FrequencyDomainModeDataPreviewDialogProps {
  fieldId: string | null;
  fieldMeta: FrequencyDomainModeDataPreviewFieldMeta | null | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  phaseRad: number | null;
  view: string | null;
}

export function FrequencyDomainModeDataPreviewDialog({
  fieldId,
  fieldMeta,
  onOpenChange,
  open,
  phaseRad,
  view,
}: FrequencyDomainModeDataPreviewDialogProps) {
  const previewView = normalizeAnalysisFieldView(
    view ?? fieldMeta?.default_view ?? DEFAULT_ANALYSIS_FIELD_VIEW,
  );
  const previewPhaseRad = phaseRad ?? 0;
  const { resource, resourceKey, resourceRevision } = useDataPreviewFieldVector({
    component: "full",
    enabled: open && Boolean(fieldId),
    maxSamples: MODE_DATA_PREVIEW_SAMPLE_COUNT,
    phaseRad: previewPhaseRad,
    quantityId: fieldId ?? "",
    view: previewView,
  });
  const rows = useMemo(
    () => buildDataPreviewRows(resource.data, MODE_DATA_PREVIEW_SAMPLE_COUNT),
    [resource.data],
  );
  const signature = useMemo(
    () =>
      buildDataPreviewSignature(resource.data, MODE_DATA_PREVIEW_SAMPLE_COUNT),
    [resource.data],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="fm-mode-data-preview-description"
        className="fm-mode-data-preview"
      >
        <DialogHeader>
          <div className="fm-mode-data-preview__title-row">
            <div>
              <DialogTitle>Mode Data Preview</DialogTitle>
              <DialogDescription
                className="fm-visually-hidden"
                id="fm-mode-data-preview-description"
              >
                Decoded vector payload metadata and representative node samples
                for the selected eigen mode.
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button
                aria-label="Close mode data preview"
                size="icon"
                title="Close"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" size={14} />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="fm-dialog__body">
          <dl className="fm-mode-data-preview__meta">
            <div>
              <dt>Field</dt>
              <dd>{fieldId ?? "not selected"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{resource.status}</dd>
            </div>
            <div>
              <dt>Shape</dt>
              <dd>
                {resource.data
                  ? `${resource.data.pointCount} nodes x ${resource.data.nComp}`
                  : "not loaded"}
              </dd>
            </div>
            <div>
              <dt>Grid</dt>
              <dd>
                {resource.data ? resource.data.grid.join(" x ") : "not loaded"}
              </dd>
            </div>
            <div>
              <dt>Values</dt>
              <dd>
                {resource.data
                  ? String(resource.data.valueCount)
                  : formatMetaNumber(fieldMeta?.payload_value_count)}
              </dd>
            </div>
            <div>
              <dt>Components</dt>
              <dd>
                {resource.data
                  ? String(resource.data.nComp)
                  : formatMetaNumber(fieldMeta?.component_count)}
              </dd>
            </div>
            <div>
              <dt>Component basis</dt>
              <dd>{fieldMeta?.component_basis ?? "not available"}</dd>
            </div>
            <div>
              <dt>Value kind</dt>
              <dd>{fieldMeta?.value_kind ?? "not available"}</dd>
            </div>
            <div>
              <dt>Indexing</dt>
              <dd>{resource.data?.indexing ?? "not loaded"}</dd>
            </div>
            <div>
              <dt>Encoding</dt>
              <dd>{fieldMeta?.payload_encoding ?? "not available"}</dd>
            </div>
            <div>
              <dt>Layout</dt>
              <dd>{fieldMeta?.binary_layout ?? "not available"}</dd>
            </div>
            <div>
              <dt>Complex pairs</dt>
              <dd>{formatMetaNumber(fieldMeta?.complex_pair_count)}</dd>
            </div>
            <div>
              <dt>View</dt>
              <dd>{analysisFieldViewLabel(previewView)}</dd>
            </div>
            <div>
              <dt>Phase</dt>
              <dd>{previewPhaseRad} rad</dd>
            </div>
            <div>
              <dt>Signature</dt>
              <dd>{signature}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{String(resource.revision ?? resourceRevision ?? "none")}</dd>
            </div>
          </dl>

          {resource.error ? (
            <pre className="fm-dialog__error">
              {formatPreviewError(resource.error)}
            </pre>
          ) : null}

          <div className="fm-mode-data-preview__table-wrap">
            <table className="fm-frequency-domain-table fm-mode-data-preview__table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>node</th>
                  <th>values</th>
                </tr>
              </thead>
              <tbody>
                {rows.length > 0 ? (
                  rows.map((row) => (
                    <tr key={`${row.sourceIndex}:${row.index}`}>
                      <td>{row.index}</td>
                      <td>
                        {modePreviewNodeLabel(resource.data, row.sourceIndex)}
                      </td>
                      <td>
                        {modePreviewValues(row.values, fieldMeta?.components)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3}>
                      {resource.status === "loading"
                        ? "Loading mode data"
                        : "No preview rows"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="fm-mode-data-preview__resource" title={resourceKey}>
            {resourceKey}
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={!fieldId}
            size="sm"
            title="Refresh mode data preview"
            type="button"
            variant="secondary"
            onClick={resource.refetch}
          >
            <RefreshCw aria-hidden="true" size={13} />
            Refresh
          </Button>
          <DialogClose asChild>
            <Button size="sm" type="button" variant="ghost">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function modePreviewNodeLabel(
  fieldVector: { nodeIndices?: readonly number[] | Uint32Array | null } | null,
  sourceIndex: number,
): string {
  const nodeIndex = fieldVector?.nodeIndices?.[sourceIndex];
  return nodeIndex == null ? String(sourceIndex) : String(nodeIndex);
}

function modePreviewValues(
  values: readonly string[],
  components: readonly string[] | null | undefined,
): string {
  return values
    .map((value, index) => `${components?.[index] ?? `c${index}`}=${value}`)
    .join("  ");
}

function formatMetaNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? String(value) : "not available";
}

function formatPreviewError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "resource load failed";
}

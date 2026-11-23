"use client";

import { useMemo, useState } from "react";

import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import { useMaterializedDatasetSliceResource } from "@/kernel/resources/materializedDatasetSliceResources";
import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import { InspectorGroup } from "../primitives/InspectorGroup";
import { SAVED_FIELD_PAGE_BYTES, savedFieldValuesWindow } from "./materializedDatasetValuesWindow";

const MAX_RENDERED_DOM_ROWS = 50;

/** Local state owns navigation only; decoded arrays stay in the resource runtime. */
export function MaterializedDatasetValues({ dataset }: { dataset: MaterializedDatasetResource }) {
  const window = savedFieldValuesWindow(dataset.field.coverage);
  const supported =
    window !== null &&
    dataset.field.plane === "values" &&
    dataset.field.descriptor.complex_encoding === "real" &&
    dataset.field.descriptor.harmonic_convention === null;
  if (!supported || window === null) {
    return (
      <p role="status" className="text-fm-xs text-fm-muted">
        Numeric preview is unavailable for this field encoding or element size.
      </p>
    );
  }
  return <ValuesPage dataset={dataset} pageSize={window.pageSize} total={window.total} />;
}

function ValuesPage({
  dataset,
  pageSize,
  total,
}: {
  dataset: MaterializedDatasetResource;
  pageSize: bigint;
  total: bigint;
}) {
  const [offset, setOffset] = useState(() => BigInt(0));
  const [subPageOffset, setSubPageOffset] = useState(0);
  const [component, setComponent] = useState(0);
  const count = total - offset < pageSize ? total - offset : pageSize;
  const range = useMemo(
    () => ({
      elementOffset: offset.toString(),
      elementCount: count.toString(),
      maxResponseBytes: String(SAVED_FIELD_PAGE_BYTES),
    }),
    [offset, count],
  );
  const resource = useMaterializedDatasetSliceResource(dataset, range);
  const components = Math.max(1, Number(dataset.field.coverage.component_count));
  const error = resource.error ?? resource.refreshError;
  const numericCount = Number(count);
  const clampedSubOffset = Math.min(subPageOffset, Math.max(0, numericCount - 1));
  const visibleRowCount = Math.min(MAX_RENDERED_DOM_ROWS, Math.max(0, numericCount - clampedSubOffset));

  return (
    <InspectorGroup
      title="Saved field values"
      description="Read-only virtualized numeric window (<=50 DOM rows). Element and component indices follow the saved field layout."
    >
      <div className="grid min-w-0 gap-2" data-materialized-dataset-values="bounded">
        <p className="m-0 text-fm-xs text-fm-muted">
          {dataset.field.descriptor.quantity_id} · unit {dataset.field.descriptor.unit} · elements{" "}
          {(offset + BigInt(clampedSubOffset)).toString()}–
          {(offset + BigInt(clampedSubOffset + Math.max(0, visibleRowCount - 1))).toString()} of{" "}
          {total.toString()}
        </p>
        <div className="flex items-center justify-between gap-2 text-fm-xs">
          <span>Component index</span>
          <div className="w-32">
            <Select
              value={String(component)}
              onValueChange={(val) => {
                const parsed = Number(val);
                if (Number.isInteger(parsed) && parsed >= 0 && parsed < components) {
                  setComponent(parsed);
                }
              }}
            >
              <SelectTrigger aria-label="Saved field component index" density="compact">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: components }, (_, idx) => (
                  <SelectItem key={idx} value={String(idx)}>
                    Component {idx}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && (
          <p role="alert" className="m-0 text-fm-xs text-fm-danger">
            Could not verify saved field values: {error.message}
          </p>
        )}
        {resource.status === "loading" && (
          <p role="status" className="m-0 text-fm-xs text-fm-muted">
            Reading saved field values…
          </p>
        )}
        {resource.data && !error && (
          <div
            aria-label="Saved field values"
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-fm-accent"
            role="region"
            tabIndex={0}
          >
            <table aria-label="Saved field values" className="w-full text-fm-xs tabular-nums">
              <thead>
                <tr>
                  <th scope="col" className="text-left">
                    Element index
                  </th>
                  <th scope="col" className="text-right">
                    Component {component} [{dataset.field.descriptor.unit}]
                  </th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: visibleRowCount }, (_, idx) => {
                  const sliceIndex = clampedSubOffset + idx;
                  const globalIndex = offset + BigInt(sliceIndex);
                  const val = resource.data!.values[sliceIndex * components + component];
                  return (
                    <tr key={globalIndex.toString()}>
                      <th scope="row" className="text-left font-normal">
                        {globalIndex.toString()}
                      </th>
                      <td className="text-right font-mono">
                        {typeof val === "number" ? val.toPrecision(8) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={offset === BigInt(0) && clampedSubOffset === 0}
            onClick={() => {
              if (clampedSubOffset >= MAX_RENDERED_DOM_ROWS) {
                setSubPageOffset(clampedSubOffset - MAX_RENDERED_DOM_ROWS);
              } else {
                setOffset(offset > pageSize ? offset - pageSize : BigInt(0));
                setSubPageOffset(0);
              }
            }}
          >
            Previous values
          </Button>
          <Button
            size="sm"
            disabled={
              offset + count >= total &&
              clampedSubOffset + visibleRowCount >= numericCount
            }
            onClick={() => {
              if (clampedSubOffset + MAX_RENDERED_DOM_ROWS < numericCount) {
                setSubPageOffset(clampedSubOffset + MAX_RENDERED_DOM_ROWS);
              } else {
                setOffset(offset + count);
                setSubPageOffset(0);
              }
            }}
          >
            Next values
          </Button>
          <Button
            size="sm"
            disabled={resource.status === "loading"}
            onClick={resource.refetch}
          >
            Reload values
          </Button>
        </div>
      </div>
    </InspectorGroup>
  );
}

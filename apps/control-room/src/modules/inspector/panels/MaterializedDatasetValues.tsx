"use client";

import { useMemo, useState } from "react";

import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import { useMaterializedDatasetSliceResource } from "@/kernel/resources/materializedDatasetSliceResources";
import { Button } from "@/shared/ui/Button";

import { InspectorGroup } from "../primitives/InspectorGroup";
import { SAVED_FIELD_PAGE_BYTES, savedFieldValuesWindow } from "./materializedDatasetValuesWindow";

/** Local state owns navigation only; decoded arrays stay in the resource runtime. */
export function MaterializedDatasetValues({ dataset }: { dataset: MaterializedDatasetResource }) {
  const window = savedFieldValuesWindow(dataset.field.coverage);
  const supported = window !== null &&
    dataset.field.plane === "values" && dataset.field.descriptor.complex_encoding === "real" &&
    dataset.field.descriptor.harmonic_convention === null;
  if (!supported || window === null) {
    return <p role="status" className="text-fm-xs text-fm-muted">Numeric preview is unavailable for this field encoding or element size.</p>;
  }
  return <ValuesPage dataset={dataset} pageSize={window.pageSize} total={window.total} />;
}

function ValuesPage({ dataset, pageSize, total }: {
  dataset: MaterializedDatasetResource; pageSize: bigint; total: bigint;
}) {
  const [offset, setOffset] = useState(BigInt(0));
  const [component, setComponent] = useState(0);
  const count = total - offset < pageSize ? total - offset : pageSize;
  const range = useMemo(() => ({
    elementOffset: offset.toString(), elementCount: count.toString(), maxResponseBytes: String(SAVED_FIELD_PAGE_BYTES),
  }), [offset, count]);
  const resource = useMaterializedDatasetSliceResource(dataset, range);
  const components = Number(dataset.field.coverage.component_count);
  const error = resource.error ?? resource.refreshError;
  return (
    <InspectorGroup title="Saved field values" description="Read-only numeric window. Element and component indices follow the saved field layout; spatial preview requires its pinned topology.">
      <div className="grid min-w-0 gap-2" data-materialized-dataset-values="bounded">
        <p className="m-0 text-fm-xs text-fm-muted">{dataset.field.descriptor.quantity_id} · unit {dataset.field.descriptor.unit} · elements {offset.toString()}–{(offset + count - BigInt(1)).toString()} of {total.toString()}</p>
        <label className="flex items-center gap-2 text-fm-xs">
          Component index
          <input aria-label="Saved field component index" className="min-w-0 border border-fm-border bg-fm-raised text-fm-primary" type="number" min={0} max={components - 1} value={component}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value < components) setComponent(value);
            }} />
        </label>
        {error && <p role="alert" className="m-0 text-fm-xs text-fm-danger">Could not verify saved field values: {error.message}</p>}
        {resource.status === "loading" && <p role="status" className="m-0 text-fm-xs text-fm-muted">Reading saved field values…</p>}
        {resource.data && !error && (
          <table aria-label="Saved field values" className="w-full text-fm-xs">
            <thead><tr><th scope="col" className="text-left">Element index</th><th scope="col" className="text-right">Component {component} [{dataset.field.descriptor.unit}]</th></tr></thead>
            <tbody>{Array.from({ length: Number(count) }, (_, index) => (
              <tr key={(offset + BigInt(index)).toString()}><th scope="row" className="text-left font-normal">{(offset + BigInt(index)).toString()}</th><td className="text-right font-mono">{resource.data!.values[index * components + component].toPrecision(8)}</td></tr>
            ))}</tbody>
          </table>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={offset === BigInt(0)} onClick={() => setOffset(offset > pageSize ? offset - pageSize : BigInt(0))}>Previous values</Button>
          <Button size="sm" disabled={offset + count >= total} onClick={() => setOffset(offset + count)}>Next values</Button>
          <Button size="sm" disabled={resource.status === "loading"} onClick={resource.refetch}>Reload values</Button>
        </div>
      </div>
    </InspectorGroup>
  );
}

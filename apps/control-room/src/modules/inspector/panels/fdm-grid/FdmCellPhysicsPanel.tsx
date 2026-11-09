"use client";

import type { ReactNode } from "react";

import {
  useFdmCellPhysicsResource,
  type FdmCellPhysicsSnapshot,
  type FdmCellPhysicsTarget,
  type FdmCellQuantitySample,
} from "@/kernel/resources/fdmCellPhysicsResources";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

export interface FdmCellPhysicsPanelProps {
  target: FdmCellPhysicsTarget | null;
  notice?: string | null;
}

const MATERIAL_LABELS: Readonly<Record<string, string>> = {
  mat_aex: "Aex",
  mat_alpha: "α",
  mat_ms: "Ms",
};

const MATERIAL_NAMES: Readonly<Record<string, string>> = {
  mat_aex: "Exchange stiffness",
  mat_alpha: "Gilbert damping",
  mat_ms: "Saturation magnetization",
};

const MATERIAL_ORDER: Readonly<Record<string, number>> = {
  mat_ms: 0,
  mat_aex: 1,
  mat_alpha: 2,
};

const ENERGY_LABELS: Readonly<Record<string, string>> = {
  eden_ani: "Anisotropy",
  eden_demag: "Demagnetizing",
  eden_dmi: "DMI",
  eden_ex: "Exchange",
  eden_ext: "Zeeman",
  eden_total: "Total",
};

const ENERGY_ORDER: Readonly<Record<string, number>> = {
  eden_ex: 0,
  eden_demag: 1,
  eden_ani: 2,
  eden_dmi: 3,
  eden_ext: 4,
  eden_total: 5,
};

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute < 1e-3 || absolute >= 1e6) return value.toExponential(3);
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value);
}

function formatPosition(values: readonly number[]): string {
  return `[${values.map(formatNumber).join(", ")}]`;
}

function energyDensityUnit(unit: string): boolean {
  return unit.trim() === "J/m³" || unit.trim() === "J/m^3";
}

function materialLabel(row: FdmCellQuantitySample): string {
  return MATERIAL_LABELS[row.id] ?? (row.id.replace(/^mat_/, "") || row.id);
}

function materialName(row: FdmCellQuantitySample): string {
  const label = row.label.replace(/^material\s+/i, "").trim();
  return MATERIAL_NAMES[row.id] ?? (label || row.id.replace(/^mat_/, ""));
}

function energyLabel(row: FdmCellQuantitySample): string {
  return ENERGY_LABELS[row.id] ?? (row.label
    .replace(/^energy\s+/i, "")
    .replace(/\s+energy\s+density$/i, "")
    .trim() || row.id.replace(/^eden_/, ""));
}

function sourceText(row: FdmCellQuantitySample): string | null {
  const parts: string[] = [];
  if (row.sourceStep !== null && Number.isFinite(row.sourceStep)) {
    parts.push(`step ${row.sourceStep.toLocaleString("en-US")}`);
  }
  if (row.sourceTimeSeconds !== null && Number.isFinite(row.sourceTimeSeconds)) {
    parts.push(`t = ${formatNumber(row.sourceTimeSeconds)} s`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function NumberValue({
  value,
  name,
}: {
  value: number;
  name: "mx" | "my" | "mz" | "magnitude" | "scalar" | "cell-energy";
}) {
  return (
    <data data-fdm-value={name} value={String(value)} title={String(value)}>
      {formatNumber(value)}
    </data>
  );
}

function QuantityMarker({
  children,
  row,
  status = row.status,
}: {
  children: ReactNode;
  row: FdmCellQuantitySample;
  status?: "ready" | "unavailable";
}) {
  return (
    <div
      className="fm-fdm-cell-physics__quantity"
      data-fdm-quantity-id={row.id}
      data-fdm-sample-status={status}
    >
      {children}
    </div>
  );
}

function unavailableText(row: FdmCellQuantitySample, fallback: string): string {
  return row.reason?.trim() || fallback;
}

function MaterialReadout({ row }: { row: FdmCellQuantitySample }) {
  const usable = row.status === "ready" && row.scalar !== null && Number.isFinite(row.scalar);
  const rawUnit = row.unit.trim();
  const unit = rawUnit === "1" || rawUnit.toLowerCase() === "dimensionless" ? null : rawUnit || null;
  return (
    <QuantityMarker row={row} status={usable ? "ready" : "unavailable"}>
      <div className="fm-fdm-cell-physics__material-row">
        <div className="fm-fdm-cell-physics__material-identity">
          <span className="fm-fdm-cell-physics__material-symbol">{materialLabel(row)}</span>
          <span className="fm-fdm-cell-physics__material-name">{materialName(row)}</span>
        </div>
        <div className="fm-fdm-cell-physics__material-value">
          {usable
            ? <NumberValue name="scalar" value={row.scalar!} />
            : <span className="fm-fdm-cell-physics__unavailable-value">Unavailable</span>}
          {unit ? <span className="fm-fdm-cell-physics__material-unit">{unit}</span> : null}
        </div>
      </div>
      {!usable ? (
        <p className="fm-fdm-cell-physics__reason">
          {unavailableText(row, "No current coefficient is published for this cell.")}
        </p>
      ) : null}
    </QuantityMarker>
  );
}

function MagnetizationReadout({ row }: { row: FdmCellQuantitySample }) {
  const vector = row.vector;
  const components = row.status === "ready" && vector?.length === 3 && vector.every(Number.isFinite)
    ? vector as readonly [number, number, number]
    : null;
  const magnitude = components ? Math.hypot(...components) : null;
  if (!components || magnitude === null || !Number.isFinite(magnitude)) {
    return (
      <QuantityMarker row={row} status="unavailable">
        <div className="fm-fdm-cell-physics__unavailable">
          <span>Magnetization unavailable</span>
          <small>{unavailableText(row, "Three finite components are not published for this cell.")}</small>
        </div>
      </QuantityMarker>
    );
  }

  return (
    <QuantityMarker row={row} status="ready">
      <>
        <div className="fm-fdm-cell-physics__readout-heading">
          <span>Components</span>
          <span className="fm-fdm-cell-physics__unit">
            {row.unit.trim().toLowerCase() === "dimensionless" || row.unit.trim() === "1"
              ? "Dimensionless"
              : `Dimensionless · ${row.unit || "1"}`}
          </span>
        </div>
        <dl className="fm-fdm-cell-physics__components" aria-label="Magnetization components">
          {(["mx", "my", "mz"] as const).map((name, index) => (
            <div className="fm-fdm-cell-physics__component" key={name}>
              <dt>{name}</dt>
              <dd><NumberValue name={name} value={components[index]} /></dd>
            </div>
          ))}
        </dl>
        <dl className="fm-fdm-cell-physics__magnitude" aria-label="Magnetization norm">
          <div>
            <dt>|m|</dt>
            <dd><NumberValue name="magnitude" value={magnitude} /></dd>
          </div>
        </dl>
      </>
    </QuantityMarker>
  );
}

function sortedMaterialRows(rows: readonly FdmCellQuantitySample[]): readonly FdmCellQuantitySample[] {
  return [...rows].sort((left, right) =>
    (MATERIAL_ORDER[left.id] ?? 100) - (MATERIAL_ORDER[right.id] ?? 100) || left.id.localeCompare(right.id),
  );
}

function sortedEnergyRows(rows: readonly FdmCellQuantitySample[]): readonly FdmCellQuantitySample[] {
  return [...rows].sort((left, right) =>
    (ENERGY_ORDER[left.id] ?? 100) - (ENERGY_ORDER[right.id] ?? 100) || left.id.localeCompare(right.id),
  );
}

function EnergyTable({
  rows,
  volumeM3,
}: {
  rows: readonly FdmCellQuantitySample[];
  volumeM3: number;
}) {
  if (rows.length === 0) {
    return <p className="fm-fdm-cell-physics__empty">No local energy fields are published for this cell.</p>;
  }
  const orderedRows = sortedEnergyRows(rows);

  return (
    <div className="fm-fdm-cell-physics__table-wrap">
      <table className="fm-fdm-cell-physics__energy-table">
        <caption className="fm-visually-hidden">Published energy density and energy for the selected cell</caption>
        <thead>
          <tr>
            <th scope="col">Term</th>
            <th scope="col">Density <small>(J/m³)</small></th>
            <th scope="col">Cell energy <small>(J)</small></th>
          </tr>
        </thead>
        <tbody>
          {orderedRows.map((row) => {
            const supportedUnit = energyDensityUnit(row.unit);
            const usable = row.status === "ready" && supportedUnit && row.scalar !== null && Number.isFinite(row.scalar);
            const cellEnergy = usable ? row.scalar! * volumeM3 : null;
            const usableCellEnergy = cellEnergy !== null && Number.isFinite(cellEnergy);
            const reason = !supportedUnit
              ? `Cannot interpret ${row.unit || "an unspecified unit"} as energy density in J/m³.`
              : usable && !usableCellEnergy
                ? "Cell energy is outside the supported numeric range."
                : unavailableText(row, "This energy density is not currently published for this cell.");

            return (
              <tr
                data-fdm-quantity-id={row.id}
                data-fdm-sample-status={usable ? "ready" : "unavailable"}
                data-fdm-energy-term={row.id === "eden_total" ? "total" : undefined}
                key={row.id}
              >
                <th scope="row">{energyLabel(row)}</th>
                <td>
                  {usable
                    ? <NumberValue name="scalar" value={row.scalar!} />
                    : <span className="fm-fdm-cell-physics__unavailable-value" title={reason}>Unavailable</span>}
                </td>
                <td>
                  {usableCellEnergy
                    ? <NumberValue name="cell-energy" value={cellEnergy!} />
                    : <span className="fm-fdm-cell-physics__unavailable-value" title={reason}>Unavailable</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {orderedRows.map((row) => {
        const supported = energyDensityUnit(row.unit);
        const usable = row.status === "ready" && supported && row.scalar !== null && Number.isFinite(row.scalar);
        const cellEnergy = usable ? row.scalar! * volumeM3 : null;
        if (usable && cellEnergy !== null && Number.isFinite(cellEnergy)) return null;
        const reason = !supported
          ? `Cannot interpret ${row.unit || "an unspecified unit"} as energy density in J/m³.`
          : usable
            ? "Cell energy is outside the supported numeric range."
            : unavailableText(row, "This energy density is not currently published for this cell.");
        return (
          <p className="fm-fdm-cell-physics__table-note" key={`${row.id}-reason`}>
            <strong>{energyLabel(row)}:</strong> {reason}
          </p>
        );
      })}
    </div>
  );
}

function StatusLabel({ status }: { status: ReturnType<typeof useFdmCellPhysicsResource>["status"] }) {
  const labels: Record<typeof status, string> = {
    error: "Read error",
    idle: "Waiting",
    loading: "Loading",
    ready: "Current",
    stale: "Refreshing",
  };
  return <span className="fm-fdm-cell-physics__status" data-state={status}>{labels[status]}</span>;
}

function FieldSourceDetails({ rows }: { rows: readonly FdmCellQuantitySample[] }) {
  const sourcedRows = rows.filter((row) => row.status === "ready" && sourceText(row));
  if (!sourcedRows.length) return <FieldRow label="Field sources" value="No current sample provenance" />;
  return (
    <div className="fm-fdm-cell-physics__sources" aria-label="Per-field source provenance">
      {sourcedRows.map((row) => (
        <FieldRow key={row.id} label={`${row.group === "material" ? materialLabel(row) : row.group === "energy" ? energyLabel(row) : "m"} source`} value={sourceText(row)!} />
      ))}
    </div>
  );
}

function EmptyReadout({ children }: { children: ReactNode }) {
  return <p className="fm-fdm-cell-physics__empty">{children}</p>;
}

export function FdmCellPhysicsPanel({ target, notice = null }: FdmCellPhysicsPanelProps) {
  const resource = useFdmCellPhysicsResource(target);
  const snapshot: FdmCellPhysicsSnapshot | null =
    target !== null && resource.status === "ready" ? resource.data : null;
  const rows = snapshot?.rows ?? [];
  const materialRows = rows.filter((row) => row.group === "material");
  const magnetizationRows = rows.filter((row) => row.group === "magnetization");
  const energyRows = rows.filter((row) => row.group === "energy");
  const waiting = target !== null && snapshot === null && resource.status !== "error";

  return (
    <div
      className="fm-inspector-panel fm-fdm-cell-physics"
      data-fdm-cell-physics-status={target ? resource.status : "unavailable"}
      data-fdm-cell-ordinal={target?.ordinal}
    >
      <header className="fm-fdm-cell-physics__summary">
        <div className="fm-fdm-cell-physics__identity">
          <strong>{target ? `Cell ${target.ordinal}` : "No current cell"}</strong>
        </div>
        {target ? <StatusLabel status={resource.status} /> : <span className="fm-fdm-cell-physics__status" data-state="unavailable">Unavailable</span>}
      </header>

      {notice ? <FeedbackBanner kind="warning" message={notice} /> : null}
      {!target && !notice ? (
        <FeedbackBanner kind="warning" message="Select a current FDM cell to inspect its published physics." />
      ) : null}
      {resource.status === "error" && target ? (
        <div className="fm-fdm-cell-physics__error" role="alert">
          <FeedbackBanner kind="error" message={resource.error?.message ?? "The current cell fields could not be read."} />
          <Button type="button" size="sm" variant="secondary" onClick={resource.refetch}>
            Retry cell physics read
          </Button>
        </div>
      ) : null}
      {waiting ? (
        <p className="fm-fdm-cell-physics__read-status" role="status" aria-live="polite">
          {resource.status === "stale"
            ? "Refreshing current fields. Previous values are hidden."
            : resource.status === "loading"
              ? "Reading published fields for this cell."
              : "Waiting for the current cell field resource."}
        </p>
      ) : null}

      <InspectorGroup title="Material parameters">
        {snapshot ? materialRows.length ? sortedMaterialRows(materialRows).map((row) => <MaterialReadout key={row.id} row={row} />) : (
          <EmptyReadout>No material coefficients are published for this cell.</EmptyReadout>
        ) : <EmptyReadout>{target ? "Current values appear when the read completes." : "Select a cell to view its material coefficients."}</EmptyReadout>}
      </InspectorGroup>

      <InspectorGroup title="Magnetization (m)">
        {snapshot ? magnetizationRows.length ? magnetizationRows.map((row) => <MagnetizationReadout key={row.id} row={row} />) : (
          <EmptyReadout>Magnetization is not published for this cell.</EmptyReadout>
        ) : <EmptyReadout>{target ? "Current values appear when the read completes." : "Select a cell to view its magnetization."}</EmptyReadout>}
      </InspectorGroup>

      <InspectorGroup title="Cell energies">
        {snapshot ? <EnergyTable rows={energyRows} volumeM3={snapshot.volumeM3} /> : (
          <EmptyReadout>{target ? "Current values appear when the read completes." : "Select a cell to view its local energies."}</EmptyReadout>
        )}
      </InspectorGroup>

      {target ? (
        <InspectorGroup title="Details" collapsible defaultOpen={false}>
          <FieldRow label="Run ID" value={snapshot ? <span title={snapshot.runId}>{snapshot.runId}</span> : "Not available"} mono />
          <FieldRow label="Cell center [m]" value={<span title={formatPosition(target.centerM)}>{formatPosition(target.centerM)}</span>} mono />
          <FieldRow
            label="Cell volume [m³]"
            value={formatNumber(snapshot?.volumeM3 ?? target.cellSizeM.reduce((a, b) => a * b, 1))}
            mono
          />
          {snapshot ? <FieldSourceDetails rows={rows} /> : <FieldRow label="Field sources" value="Shown when current values are available" />}
        </InspectorGroup>
      ) : null}
    </div>
  );
}

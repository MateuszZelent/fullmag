"use client";

import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { QuantityDescriptor, ScalarRow } from "@/lib/session/types";
import { fmtSI, fmtExp, normalizeUnitLabel } from "../../lib/format";
import { defaultScalarTableSeries } from "../../lib/quantities/scalars";

/* ── Column definition ── */

interface Column {
  key: string;
  label: string;
  unit?: string;
  format: (v: number) => string;
}

function numericCell(row: ScalarRow, key: string): number {
  const value = Reflect.get(row, key);
  return typeof value === "number" ? value : 0;
}

function textCell(row: ScalarRow, key: string): string {
  const value = Reflect.get(row, key);
  if (value == null) return "";
  return String(value);
}

function fmtFloat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(6);
}

/* ── Component ── */

interface ScalarTableProps {
  rows: ScalarRow[];
  quantities?: QuantityDescriptor[];
}

export default function ScalarTable({ rows, quantities = [] }: ScalarTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const columns = useMemo<Column[]>(
    () =>
      defaultScalarTableSeries(quantities).map((meta) => ({
        key: meta.key,
        label: meta.label,
        unit: meta.unit,
        format: (value) => formatScalarValue(meta.key, value, meta.unit),
      })),
    [quantities],
  );
  const [sortKey, setSortKey] = useState<string>("step");
  const [sortAsc, setSortAsc] = useState(true);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = numericCell(a, sortKey);
      const vb = numericCell(b, sortKey);
      return sortAsc ? va - vb : vb - va;
    });
    return copy;
  }, [rows, sortKey, sortAsc]);

  /* Auto-scroll to bottom when new rows arrive */
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [rows.length, autoScroll]);

  const handleHeaderClick = useCallback((key: string) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  }, [sortKey]);

  const handleCopyCSV = useCallback(() => {
    const header = columns.map((c) => c.label).join("\t");
    const body = rows.map((r) => columns.map((c) => textCell(r, c.key)).join("\t")).join("\n");
    void navigator.clipboard
      .writeText(`${header}\n${body}`)
      .catch((error) => {
        console.warn("[ScalarTable] Clipboard copy failed", error);
      });
  }, [columns, rows]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground italic opacity-60">
        Waiting for scalar data…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border/40 bg-muted/20 shrink-0">
        <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground font-bold">{rows.length} rows</span>
        <button className="appearance-none bg-transparent border-none text-[0.65rem] uppercase tracking-widest font-bold text-muted-foreground cursor-pointer hover:text-foreground" onClick={handleCopyCSV} title="Copy as TSV">
          📋 Copy
        </button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground accent-primary cursor-pointer select-none">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
      </div>
      <div
        className="flex-1 overflow-auto min-h-0 scrollbar-thin scrollbar-thumb-muted-foreground/20"
        ref={containerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
        }}
      >
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="sticky top-0 bg-primary/5 backdrop-blur-md p-2 font-semibold text-[0.65rem] uppercase tracking-widest text-muted-foreground border-b border-border/40 whitespace-nowrap select-none cursor-pointer hover:bg-muted/50 data-[sorted=true]:text-primary"
                  data-sorted={col.key === sortKey}
                  onClick={() => handleHeaderClick(col.key)}
                >
                  {col.unit ? `${col.label} (${normalizeUnitLabel(col.unit)})` : col.label}
                  {col.key === sortKey && (
                    <span className="ml-1 inline-block shrink-0">{sortAsc ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={row.step} className="border-b border-border/20 last:border-0 hover:bg-muted/10 data-[latest=true]:bg-primary/5 font-mono" data-latest={i === sorted.length - 1}>
                {columns.map((col) => (
                  <td key={col.key} className="p-2 whitespace-nowrap">
                    {col.format(numericCell(row, col.key))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatScalarValue(key: string, value: number, unit: string): string {
  if (key === "step") {
    return Number.isFinite(value) ? value.toLocaleString() : "—";
  }
  if (key === "mx" || key === "my" || key === "mz") {
    return fmtFloat(value);
  }
  if (unit === "s") {
    return fmtSI(value, "s");
  }
  if (unit) {
    return fmtSI(value, unit, key);
  }
  return fmtExp(value);
}

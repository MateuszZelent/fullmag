"use client";

import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { ScalarRow } from "../../lib/useSessionStream";
import s from "./ScalarTable.module.css";

/* ── Column definition ── */

interface Column {
  key: keyof ScalarRow;
  label: string;
  unit?: string;
  format: (v: number) => string;
}

function fmtSI(v: number, unit: string): string {
  if (!Number.isFinite(v) || v === 0) return `0 ${unit}`;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(3)} M${unit}`;
  if (abs >= 1e3) return `${(v / 1e3).toPrecision(3)} k${unit}`;
  if (abs >= 1) return `${v.toPrecision(3)} ${unit}`;
  if (abs >= 1e-3) return `${(v * 1e3).toPrecision(3)} m${unit}`;
  if (abs >= 1e-6) return `${(v * 1e6).toPrecision(3)} µ${unit}`;
  if (abs >= 1e-9) return `${(v * 1e9).toPrecision(3)} n${unit}`;
  if (abs >= 1e-12) return `${(v * 1e12).toPrecision(3)} p${unit}`;
  return v.toExponential(2);
}

function fmtExp(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return v.toExponential(3);
}

function fmtFloat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(6);
}

const COLUMNS: Column[] = [
  { key: "step",        label: "Step",      format: (v) => v.toLocaleString() },
  { key: "time",        label: "Time",      unit: "s", format: (v) => fmtSI(v, "s") },
  { key: "solver_dt",   label: "Δt",        unit: "s", format: fmtExp },
  { key: "mx",          label: "⟨mx⟩",      format: fmtFloat },
  { key: "my",          label: "⟨my⟩",      format: fmtFloat },
  { key: "mz",          label: "⟨mz⟩",      format: fmtFloat },
  { key: "e_total",     label: "E_total",   unit: "J", format: fmtExp },
  { key: "max_dm_dt",   label: "max dm/dt", format: fmtExp },
  { key: "max_h_eff",   label: "max H_eff", format: fmtExp },
];

/* ── Component ── */

interface ScalarTableProps {
  rows: ScalarRow[];
}

export default function ScalarTable({ rows }: ScalarTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sortKey, setSortKey] = useState<keyof ScalarRow>("step");
  const [sortAsc, setSortAsc] = useState(true);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = a[sortKey] as number;
      const vb = b[sortKey] as number;
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

  const handleHeaderClick = useCallback((key: keyof ScalarRow) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  }, [sortKey]);

  const handleCopyCSV = useCallback(() => {
    const header = COLUMNS.map((c) => c.label).join("\t");
    const body = rows.map((r) => COLUMNS.map((c) => String(r[c.key])).join("\t")).join("\n");
    void navigator.clipboard.writeText(`${header}\n${body}`);
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className={s.empty}>
        Waiting for scalar data…
      </div>
    );
  }

  return (
    <div className={s.wrapper}>
      <div className={s.toolbar}>
        <span className={s.toolbarLabel}>{rows.length} rows</span>
        <button className={s.toolbarBtn} onClick={handleCopyCSV} title="Copy as TSV">
          📋 Copy
        </button>
        <label className={s.toolbarToggle}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
      </div>
      <div
        className={s.tableContainer}
        ref={containerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
        }}
      >
        <table className={s.table}>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={s.th}
                  data-sorted={col.key === sortKey}
                  onClick={() => handleHeaderClick(col.key)}
                >
                  {col.label}
                  {col.key === sortKey && (
                    <span className={s.sortArrow}>{sortAsc ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={row.step} className={s.tr} data-latest={i === sorted.length - 1}>
                {COLUMNS.map((col) => (
                  <td key={col.key} className={s.td}>
                    {col.format(row[col.key] as number)}
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

"use client";

import { Download } from "lucide-react";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/Sheet";

export interface HysteresisDiagnosticTableSheetProps {
  onBookmarkPoint?: (point: HysteresisPointSchema) => void;
  onExportCsv?: (points: readonly HysteresisPointSchema[]) => void;
  onLoadPointIn3D?: (point: HysteresisPointSchema) => void;
  onOpenChange: (open: boolean) => void;
  onUsePointAsInitialState?: (point: HysteresisPointSchema) => void;
  open: boolean;
  points: readonly HysteresisPointSchema[];
  stageId: string;
}

function formatVecComponent(values: readonly number[] | undefined, idx: number): string {
  const v = values?.[idx];
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(5) : "—";
}

function formatOrientationCell(value: unknown): string {
  if (!value || typeof value !== "object") return "—";
  const record = value as Record<string, unknown>;
  if (typeof record.preset_name === "string" && record.preset_name) {
    return record.preset_name;
  }
  if (typeof record.theta_deg === "number" && typeof record.phi_deg === "number") {
    return `${record.theta_deg.toFixed(1)} deg, ${record.phi_deg.toFixed(1)} deg`;
  }
  if (typeof record.kind === "string" && record.kind) {
    return record.kind;
  }
  return "Custom";
}

export function HysteresisDiagnosticTableSheet({
  onBookmarkPoint,
  onExportCsv,
  onLoadPointIn3D,
  onOpenChange,
  onUsePointAsInitialState,
  open,
  points,
  stageId,
}: HysteresisDiagnosticTableSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-[92vw] w-[1120px] overflow-y-auto" side="right">
        <SheetHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <div>
              <SheetTitle>Hysteresis Diagnostic Point Table ({stageId})</SheetTitle>
              <SheetDescription>
                Full 15-column field-sweep ledger with vector magnetization components, settle convergence status, and 3D snapshot actions.
              </SheetDescription>
            </div>
            {onExportCsv ? (
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => onExportCsv(points)}
              >
                <Download size={14} aria-hidden="true" />
                <span>Export CSV</span>
              </Button>
            ) : null}
          </div>
        </SheetHeader>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums border-collapse">
            <thead>
              <tr className="border-b border-fm-border text-fm-muted">
                <th className="py-1.5 px-2">Point #</th>
                <th className="py-1.5 px-2">Role</th>
                <th className="py-1.5 px-2">Branch</th>
                <th className="py-1.5 px-2">Source</th>
                <th className="py-1.5 px-2">mu0 H (mT)</th>
                <th className="py-1.5 px-2">Angle</th>
                <th className="py-1.5 px-2">m_parallel</th>
                <th className="py-1.5 px-2">m_oop</th>
                <th className="py-1.5 px-2">m_ip</th>
                <th className="py-1.5 px-2">m_x</th>
                <th className="py-1.5 px-2">m_y</th>
                <th className="py-1.5 px-2">m_z</th>
                <th className="py-1.5 px-2">Solver &amp; Status</th>
                <th className="py-1.5 px-2">Snapshot</th>
                <th className="py-1.5 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => {
                const branchLabel =
                  point.branch_id ??
                  (Array.isArray(point.branch_ids) && point.branch_ids.length > 0
                    ? point.branch_ids.join(", ")
                    : "—");
                const hasSnapshot = Boolean(point.snapshot_id);
                return (
                  <tr
                    className="border-b border-fm-border-subtle"
                    key={point.point_id}
                  >
                    <td className="py-1.5 px-2">{point.point_id}</td>
                    <td className="py-1.5 px-2">{point.protocol_role ?? "—"}</td>
                    <td className="py-1.5 px-2">{branchLabel}</td>
                    <td className="py-1.5 px-2">
                      {point.adaptive_inserted ? "Adaptive" : "Planned"}
                    </td>
                    <td className="py-1.5 px-2">{point.field_value_mT.toFixed(2)}</td>
                    <td className="py-1.5 px-2">
                      {formatOrientationCell(point.field_orientation)}
                    </td>
                    <td className="py-1.5 px-2">{point.m_parallel.toFixed(5)}</td>
                    <td className="py-1.5 px-2">{point.m_oop.toFixed(5)}</td>
                    <td className="py-1.5 px-2">{point.m_ip.toFixed(5)}</td>
                    <td className="py-1.5 px-2">
                      {formatVecComponent(point.m_avg, 0)}
                    </td>
                    <td className="py-1.5 px-2">
                      {formatVecComponent(point.m_avg, 1)}
                    </td>
                    <td className="py-1.5 px-2">
                      {formatVecComponent(point.m_avg, 2)}
                    </td>
                    <td className="py-1.5 px-2">
                      {point.settle_status ?? point.status}
                    </td>
                    <td className="py-1.5 px-2">
                      {point.snapshot_storage_status ??
                        (hasSnapshot ? "available" : "none")}
                    </td>
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-1">
                        <Button
                          aria-label={`Load point ${point.point_id} in 3D`}
                          disabled={!hasSnapshot}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => onLoadPointIn3D?.(point)}
                        >
                          3D
                        </Button>
                        <Button
                          aria-label={`Use point ${point.point_id} as initial state`}
                          disabled={!hasSnapshot}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => onUsePointAsInitialState?.(point)}
                        >
                          Init
                        </Button>
                        <Button
                          aria-label={`Bookmark point ${point.point_id}`}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => onBookmarkPoint?.(point)}
                        >
                          Pin
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SheetContent>
    </Sheet>
  );
}

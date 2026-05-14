"use client";

import {
  Clock3,
  FileText,
  Gauge,
  Radio,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
import { FullmagMark } from "@/shared/brand/FullmagLogo";

export function FooterTelemetry() {
  const { data: status } = useSessionStatus();
  const telemetry = buildFooterTelemetryModel(status);

  return (
    <div className="fm-footer-telemetry" role="status" aria-label="Live telemetry">
      <div className="fm-footer-telemetry__brand">
        <FullmagMark size={24} className="fm-footer-telemetry__mark-wrapper" />
        <div className="fm-footer-telemetry__brand-copy">
          <span className="fm-footer-telemetry__brand-title">Fullmag</span>
          <span className="fm-footer-telemetry__brand-subtitle">
            Micromagnetics
          </span>
        </div>
      </div>

      <div className="fm-footer-telemetry__separator" aria-hidden="true" />

      <div className="fm-footer-telemetry__system">
        <StatusBadge
          detail={telemetry.statusDetail}
          state={telemetry.statusState}
          title={telemetry.statusTitle}
        />
        <div className="fm-footer-telemetry__online">
          <span className="fm-footer-telemetry__online-title">
            {telemetry.onlineTitle}
          </span>
          <span className="fm-footer-telemetry__online-detail">
            {telemetry.onlineDetail}
          </span>
        </div>
      </div>

      <TelemetryMetric
        detail={telemetry.timeDetail}
        icon={<Clock3 size={13} aria-hidden="true" />}
        label="Time"
        subdetail={telemetry.timeSubdetail}
        value={telemetry.timeValue}
      />
      <TelemetryMetric
        detail={telemetry.torqueDetail}
        icon={<Gauge size={13} aria-hidden="true" />}
        label="Max Torque"
        subdetail={telemetry.torqueSubdetail}
        unit={telemetry.torqueUnit}
        value={telemetry.torqueValue}
      />
      <TelemetryMetric
        detail={telemetry.energyDetail}
        icon={<Zap size={13} aria-hidden="true" />}
        label="Energy"
        subdetail={telemetry.energySubdetail}
        unit={telemetry.energyUnit}
        value={telemetry.energyValue}
      />
      <TelemetryMetric
        detail={telemetry.stepsDetail}
        icon={<Radio size={13} aria-hidden="true" />}
        label="Steps/s"
        subdetail={telemetry.stepsSubdetail}
        value={telemetry.stepsValue}
      />

      <div className="fm-footer-telemetry__links" aria-label="Footer links">
        <div className="fm-footer-telemetry__link-row">
          <span>Data Logs</span>
          <span>Reports</span>
          <span>API Docs</span>
          <span>Support</span>
        </div>
        <div className="fm-footer-telemetry__copyright">
          <FileText size={12} aria-hidden="true" />
          <span>© 2026 Fullmag.</span>
          <span>Desgined by Mateusz Zelent.</span>
        </div>
      </div>
    </div>
  );
}

function buildFooterTelemetryModel(status: LiveStatusResource | null | undefined) {
  const solverState = status?.solver?.state ?? "unknown";
  const runTimeSeconds = status?.run?.solver_time ?? 0;
  const totalSteps = status?.run?.solver_steps ?? status?.metrics?.total_steps ?? 0;
  const stepsPerSecond = status?.metrics?.steps_per_second;
  const maxTorque = status?.solver?.max_torque;
  const totalEnergy = status?.energies?.total;
  const runtimeState = status?.solver?.state ?? "unknown";
  const statusTitle =
    solverState === "running"
      ? "System Status: Running"
      : `System Status: ${titleCase(solverState)}`;
  const online = solverState === "running" || solverState === "idle";

  return {
    energyDetail: "Total",
    energySubdetail: "Latest sample",
    energyUnit: "J",
    energyValue: formatScientific(totalEnergy, "0.000e+0"),
    onlineDetail: status ? "Live session channel" : "Awaiting session",
    onlineTitle: online ? "Online / Active" : "Local / Standby",
    statusDetail: status ? "Runtime telemetry" : "Waiting for runtime",
    statusState: solverState,
    statusTitle,
    stepsDetail: "Throughput",
    stepsSubdetail: `${formatInteger(totalSteps)} steps`,
    stepsValue: formatFixed(stepsPerSecond, 1, "0.0"),
    timeDetail: "Elapsed Time",
    timeSubdetail: status ? "Last sync: now" : "Last sync: pending",
    timeValue: formatDuration(runTimeSeconds),
    torqueDetail: "Peak Load",
    torqueSubdetail: `State: ${titleCase(runtimeState)}`,
    torqueUnit: "",
    torqueValue: formatScientific(maxTorque, "0.000e+0"),
  };
}

function StatusBadge({
  detail,
  state,
  title,
}: {
  detail: string;
  state: string;
  title: string;
}) {
  return (
    <div className="fm-footer-telemetry__badge" data-state={state}>
      <span className="fm-footer-telemetry__badge-dot" aria-hidden="true" />
      <span className="fm-footer-telemetry__badge-copy">
        <span className="fm-footer-telemetry__badge-label">{title}</span>
        <span className="fm-footer-telemetry__badge-detail">{detail}</span>
      </span>
    </div>
  );
}

function TelemetryMetric({
  detail,
  icon,
  label,
  subdetail,
  unit,
  value,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  subdetail: string;
  unit?: string;
  value: string;
}) {
  return (
    <div className="fm-footer-telemetry__metric">
      <div className="fm-footer-telemetry__metric-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className="fm-footer-telemetry__metric-value">
        <span>{value}</span>
        {unit ? (
          <span className="fm-footer-telemetry__metric-unit">{unit}</span>
        ) : null}
      </div>
      <div className="fm-footer-telemetry__metric-detail">
        <span>{detail}</span>
        <span>{subdetail}</span>
      </div>
    </div>
  );
}

function formatDuration(seconds: number | null | undefined): string {
  const totalSeconds = Math.max(
    0,
    Math.floor(typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0),
  );
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function formatFixed(
  value: number | null | undefined,
  digits: number,
  fallback: string,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : fallback;
}

function formatInteger(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
    : "0";
}

function formatScientific(
  value: number | null | undefined,
  fallback: string,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (Math.abs(value) >= 1e-2 && Math.abs(value) < 1e4) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 3,
    }).format(value);
  }
  return value.toExponential(3);
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

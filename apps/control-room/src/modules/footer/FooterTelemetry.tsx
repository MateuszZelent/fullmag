"use client";

import {
  Clock3,
  FileText,
  Gauge,
  Hash,
  Magnet,
  Radio,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";

import type {
  LiveStatusResource,
  ObjectMetricsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useObjectMetricsResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
import { FullmagMark } from "@/shared/brand/FullmagLogo";

export function FooterTelemetry() {
  const { data: status } = useSessionStatus();
  const scene = useSceneResource();
  const objectId = useMemo(() => resolvePrimaryTelemetryObjectId(scene.data), [scene.data]);
  const objectMetrics = useObjectMetricsResource(objectId);
  const telemetry = buildFooterTelemetryModel(status, objectMetrics.data);

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

      <div className="fm-footer-telemetry__metrics-grid" aria-label="Runtime metrics">
        {telemetry.metrics.map((metric) => (
          <TelemetryMetric key={metric.id} {...metric} />
        ))}
      </div>

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
          <span>Designed by Mateusz Zelent.</span>
        </div>
      </div>
    </div>
  );
}

type FooterTelemetryMetric = {
  detail: string;
  icon: ReactNode;
  id: string;
  label: string;
  subdetail: string;
  unit?: string;
  value: string;
};

export function buildFooterTelemetryModel(
  status: LiveStatusResource | null | undefined,
  objectMetrics: ObjectMetricsResource | null | undefined,
) {
  const solverState = status?.solver?.state ?? "unknown";
  const runTimeSeconds = status?.run?.solver_time ?? 0;
  const totalSteps = status?.run?.solver_steps ?? status?.metrics?.total_steps ?? 0;
  const stepsPerSecond = status?.metrics?.steps_per_second;
  const maxTorque = status?.solver?.max_torque;
  const totalEnergy = objectMetrics?.energies.total ?? status?.energies?.total;
  const runtimeState = status?.solver?.state ?? "unknown";
  const magnetization = objectMetrics?.magnetization_average;
  const magnetizationMagnitude = magnetization
    ? Math.hypot(magnetization.mx, magnetization.my, magnetization.mz)
    : null;
  const statusTitle =
    solverState === "running"
      ? "System Status: Running"
      : `System Status: ${titleCase(solverState)}`;
  const online = solverState === "running" || solverState === "idle";
  const energySource = objectMetrics
    ? `Object: ${objectMetrics.object_id}`
    : "Session summary";

  return {
    metrics: [
      {
        detail: "Elapsed Time",
        icon: <Clock3 size={13} aria-hidden="true" />,
        id: "time",
        label: "Time",
        subdetail: status ? "Last sync: now" : "Last sync: pending",
        value: formatDuration(runTimeSeconds),
      },
      {
        detail: "Throughput",
        icon: <Radio size={13} aria-hidden="true" />,
        id: "steps-per-second",
        label: "Steps/s",
        subdetail: `${formatInteger(totalSteps)} steps`,
        value: formatFixed(stepsPerSecond, 1, "0.0"),
      },
      {
        detail: "Latest step",
        icon: <Hash size={13} aria-hidden="true" />,
        id: "step",
        label: "Step",
        subdetail: `t=${formatScientific(objectMetrics?.time_seconds ?? runTimeSeconds, "0.000e+0")} s`,
        value: formatInteger(objectMetrics?.step ?? totalSteps),
      },
      {
        detail: "Solver timestep",
        icon: <Clock3 size={13} aria-hidden="true" />,
        id: "dt",
        label: "dt",
        subdetail: `State: ${titleCase(runtimeState)}`,
        unit: "s",
        value: formatScientific(status?.solver?.dt, "0.000e+0"),
      },
      {
        detail: "Peak Load",
        icon: <Gauge size={13} aria-hidden="true" />,
        id: "max-torque",
        label: "Max Torque",
        subdetail: `Converged: ${formatBoolean(status?.solver?.converged)}`,
        value: formatScientific(maxTorque, "0.000e+0"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-mx",
        label: "avg mx",
        subdetail: objectMetrics?.source ?? "No object sample",
        value: formatFixed(magnetization?.mx, 3, "0.000"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-my",
        label: "avg my",
        subdetail: objectMetrics?.source ?? "No object sample",
        value: formatFixed(magnetization?.my, 3, "0.000"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-mz",
        label: "avg mz",
        subdetail: objectMetrics?.source ?? "No object sample",
        value: formatFixed(magnetization?.mz, 3, "0.000"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-m",
        label: "|avg m|",
        subdetail: objectMetrics?.has_solver_sample ? "Solver sample" : "Initial state",
        value: formatFixed(magnetizationMagnitude, 3, "0.000"),
      },
      {
        detail: "Total",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-total",
        label: "Energy",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(totalEnergy, "0.000e+0"),
      },
      {
        detail: "Exchange",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-exchange",
        label: "Exchange",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(objectMetrics?.energies.exchange ?? status?.energies?.exchange, "0.000e+0"),
      },
      {
        detail: "Demag",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-demag",
        label: "Demag",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(objectMetrics?.energies.demag ?? status?.energies?.demag, "0.000e+0"),
      },
      {
        detail: "Zeeman",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-zeeman",
        label: "Zeeman",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(objectMetrics?.energies.zeeman ?? status?.energies?.zeeman, "0.000e+0"),
      },
      {
        detail: "Anisotropy",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-anisotropy",
        label: "Anisotropy",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(objectMetrics?.energies.anisotropy ?? status?.energies?.anisotropy, "0.000e+0"),
      },
      {
        detail: "DMI",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-dmi",
        label: "DMI",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(objectMetrics?.energies.dmi ?? status?.energies?.dmi, "0.000e+0"),
      },
    ] satisfies FooterTelemetryMetric[],
    onlineDetail: status ? "Live session channel" : "Awaiting session",
    onlineTitle: online ? "Online / Active" : "Local / Standby",
    statusDetail: status ? "Runtime telemetry" : "Waiting for runtime",
    statusState: solverState,
    statusTitle,
  };
}

export function resolvePrimaryTelemetryObjectId(
  scene: SceneResource | null | undefined,
): string | null {
  const sceneRecord = asRecord(scene);
  const objects = sceneRecord?.objects;
  if (!Array.isArray(objects)) return null;

  for (const object of objects) {
    const objectId = asString(asRecord(object)?.id);
    if (objectId) return objectId;
  }

  return null;
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

function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

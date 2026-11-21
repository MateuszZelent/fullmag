"use client";

import {
  AlertTriangle,
  Clipboard,
  ClipboardCheck,
  Cpu,
  FileText,
  HardDrive,
  Server,
  Timer,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  useCpuTelemetryResource,
  useEngineLogResource,
  useGpuTelemetryResource,
  useSolverProfileResource,
} from "@/kernel/resources/studyRuntimeResources";
import { Button } from "@/shared/ui/Button";

import { AutomaticPerformancePanel } from "./AutomaticPerformancePanel";
import { buildCpuTelemetryPanelModel, buildSolverProfilePanelModel, buildSolverTracePanelModel, buildTimestepQualificationPanelModel, serializeSolverProfileRows, titleCase, formatPercent, formatMemory, type SolverTracePanelModel, formatNs } from "./FooterDiagnostics.model";

type SolverProfileCopyStatus = "copied" | "failed" | "idle";

export function FooterDiagnostics() {
  const engineLog = useEngineLogResource();
  const cpu = useCpuTelemetryResource();
  const gpu = useGpuTelemetryResource();
  const solverProfile = useSolverProfileResource();
  const latestEntries = engineLog.data?.entries.slice(-5).reverse() ?? [];
  const cpuModel = buildCpuTelemetryPanelModel(cpu.data);
  const gpuDevices = gpu.data?.devices ?? [];
  const gpuStatus = gpu.data?.status ?? "pending";
  const profileModel = buildSolverProfilePanelModel(solverProfile.data);
  const traceModel = buildSolverTracePanelModel(solverProfile.data);
  const timestepQualificationModel = buildTimestepQualificationPanelModel(
    solverProfile.data,
  );
  const [profileCopyStatus, setProfileCopyStatus] =
    useState<SolverProfileCopyStatus>("idle");
  const profileCopyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (profileCopyResetTimerRef.current !== null) {
        window.clearTimeout(profileCopyResetTimerRef.current);
      }
    };
  }, []);

  const copyProfileRows = async () => {
    try {
      await navigator.clipboard.writeText(
        serializeSolverProfileRows(profileModel.allRows),
      );
      setProfileCopyStatus("copied");
    } catch {
      setProfileCopyStatus("failed");
    }
    if (profileCopyResetTimerRef.current !== null) {
      window.clearTimeout(profileCopyResetTimerRef.current);
    }
    profileCopyResetTimerRef.current = window.setTimeout(() => {
      setProfileCopyStatus("idle");
      profileCopyResetTimerRef.current = null;
    }, 2000);
  };

  return (
    <div className="fm-footer-diagnostics">
      <section
        className="fm-footer-diagnostics__panel"
        aria-label="Engine log"
      >
        <div className="fm-footer-diagnostics__heading">
          <FileText size={14} aria-hidden="true" />
          <span>Engine Log</span>
          <span className="fm-footer-diagnostics__meta">
            {engineLog.data?.total ?? 0} entries
          </span>
        </div>
        {latestEntries.length > 0 ? (
          <table className="fm-footer-diagnostics__log" aria-label="Engine log entries">
            <tbody>
              {latestEntries.map((entry) => (
                <tr
                  className="fm-footer-diagnostics__log-row"
                  key={`${entry.timestamp_unix_ms}:${entry.level}:${entry.message}`}
                >
                  <td><time>{formatTime(entry.timestamp_unix_ms)}</time></td>
                  <td data-level={entry.level}>
                    {entry.level}
                  </td>
                  <td>{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="fm-footer__empty" role="status">
            No engine log entries.
          </div>
        )}
      </section>

      <AutomaticPerformancePanel />

      <section
        className="fm-footer-diagnostics__panel"
        aria-label="FEM solver profiler"
      >
        <div className="fm-footer-diagnostics__heading">
          <Timer size={14} aria-hidden="true" />
          <span>Profiler</span>
          <span className="fm-footer-diagnostics__meta">
            {titleCase(profileModel.state)} | {profileModel.sampleCount} samples
            {profileCopyStatus === "copied" ? " | copied" : ""}
            {profileCopyStatus === "failed" ? " | copy failed" : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Copy profiler table to clipboard"
            title={`Copy ${profileModel.allRows.length} profiler rows to clipboard`}
            disabled={profileModel.allRows.length === 0}
            onClick={copyProfileRows}
          >
            {profileCopyStatus === "copied" ? (
              <ClipboardCheck size={14} aria-hidden="true" />
            ) : (
              <Clipboard size={14} aria-hidden="true" />
            )}
          </Button>
        </div>
        {timestepQualificationModel ? (
          <div
            className={
              timestepQualificationModel.warning
                ? "fm-footer-diagnostics__warning"
                : "fm-footer-diagnostics__threading"
            }
            role="status"
          >
            {timestepQualificationModel.warning ? (
              <AlertTriangle size={13} aria-hidden="true" />
            ) : (
              <Server size={13} aria-hidden="true" />
            )}
            <span>
              {timestepQualificationModel.label} — {timestepQualificationModel.detail}
            </span>
          </div>
        ) : null}
        {profileModel.rows.length > 0 ? (
          <div className="fm-footer-diagnostics__profile">
            <div className="fm-footer-diagnostics__threading">
              <Cpu size={13} aria-hidden="true" />
              <span>{profileModel.threadSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Server size={13} aria-hidden="true" />
              <span>{profileModel.livePublisherSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.previewModeSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.windowPhaseSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.rateSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.overheadSummary}</span>
            </div>
            <div
              className="fm-footer-diagnostics__threading"
              title={profileModel.timingSemanticsTooltip}
            >
              <Timer size={13} aria-hidden="true" />
              <span>
                RK checkpoint: {profileModel.timingSummary.rkCheckpoint}
              </span>
            </div>
            <div
              className="fm-footer-diagnostics__threading"
              title={profileModel.timingSemanticsTooltip}
            >
              <Timer size={13} aria-hidden="true" />
              <span>
                HYPRE host API: {profileModel.timingSummary.hypreHostApi}
              </span>
            </div>
            <div
              className="fm-footer-diagnostics__threading"
              title={profileModel.timingSemanticsTooltip}
            >
              <Timer size={13} aria-hidden="true" />
              <span>
                HYPRE GPU elapsed: {profileModel.timingSummary.hypreGpuElapsed}
              </span>
            </div>
            <div
              className="fm-footer-diagnostics__threading"
              title={profileModel.timingSemanticsTooltip}
            >
              <Timer size={13} aria-hidden="true" />
              <span>Rollback: {profileModel.timingSummary.rollback}</span>
            </div>
            <SolverTracePanel model={traceModel} />
            {profileModel.hasSingleThreadWarning ? (
              <div className="fm-footer-diagnostics__warning" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>Effective OpenMP thread count is 1.</span>
              </div>
            ) : null}
            <table className="fm-footer-diagnostics__profile-table">
              <caption className="fm-footer-diagnostics__threading">
                Last-step phases (interval aggregates are shown separately above)
              </caption>
              <thead>
                <tr
                  className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header"
                >
                  <th scope="col">Last step</th>
                  <th scope="col">Clock</th>
                  <th scope="col">Span steps</th>
                  <th scope="col">Span wall</th>
                  <th scope="col">Gap total</th>
                  <th scope="col">Gap/step</th>
                  <th scope="col">Total (last step)</th>
                  <th scope="col">Exchange (last step)</th>
                  <th scope="col">Demag (last step)</th>
                  <th scope="col">Demag detail</th>
                  <th scope="col">Setup</th>
                  <th scope="col">Relax prec.</th>
                  <th scope="col">RHS</th>
                  <th scope="col">Preview</th>
                  <th scope="col">Cache</th>
                  <th scope="col">Field copy</th>
                  <th scope="col">Artifact</th>
                  <th scope="col">Finalization</th>
                  <th scope="col">GPU sync</th>
                  <th scope="col">Native</th>
                  <th scope="col">Orchestr.</th>
                  <th scope="col">Missing</th>
                  <th scope="col">Deep clones (last step)</th>
                </tr>
              </thead>
              <tbody>
                {profileModel.rows.map((row) => (
                  <tr
                    className="fm-footer-diagnostics__profile-row"
                    key={row.id}
                  >
                    <td>{row.step}</td>
                    <td>{row.clock}</td>
                    <td>{row.spanSteps}</td>
                    <td>{row.spanWall}</td>
                    <td>{row.gapTotal}</td>
                    <td>{row.gapPerStep}</td>
                    <td>{row.total}</td>
                    <td>{row.exchange}</td>
                    <td>{row.demag}</td>
                    <td>{row.demagDetail}</td>
                    <td>{row.demagSetup}</td>
                    <td>{row.relaxPreconditioner}</td>
                    <td>{row.rhs}</td>
                    <td>{row.preview}</td>
                    <td>{row.cache}</td>
                    <td>{row.fieldCopy}</td>
                    <td>{row.artifact}</td>
                    <td>{row.finalization}</td>
                    <td>{row.gpuSync}</td>
                    <td>{row.nativeFfi}</td>
                    <td>{row.orchestration}</td>
                    <td>{row.missing}</td>
                    <td>{row.deepClones}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="fm-footer-diagnostics__phase-stack" aria-hidden="true">
              {profileModel.rows[0]?.phases.map((phase, index) => (
                <span
                  className="fm-footer-diagnostics__phase"
                  data-phase-index={index % 5}
                  key={phase.id}
                  style={{ width: `${phase.percent}%` }}
                  title={`${phase.label}: ${phase.percent.toFixed(1)}%`}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            Solver profiler is inactive.
          </div>
        )}
      </section>

      <section
        className="fm-footer-diagnostics__panel"
        aria-label="CPU telemetry"
      >
        <div className="fm-footer-diagnostics__heading">
          <Cpu size={14} aria-hidden="true" />
          <span>CPU</span>
          <span className="fm-footer-diagnostics__meta">
            {titleCase(cpuModel.status)}
          </span>
        </div>
        {cpuModel.rows.length > 0 ? (
          <div className="fm-footer-diagnostics__cpu-list">
            {cpuModel.rows.map((row) => (
              <div className="fm-footer-diagnostics__cpu" key={row.id}>
                <span>
                  <Server size={13} aria-hidden="true" />
                  {row.label}
                </span>
                <span>
                  <Cpu size={13} aria-hidden="true" />
                  {row.utilization}
                </span>
                <span>
                  <HardDrive size={13} aria-hidden="true" />
                  {row.memory}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            {cpuModel.reason ?? "CPU telemetry pending."}
          </div>
        )}
      </section>

      <section
        className="fm-footer-diagnostics__panel"
        aria-label="GPU telemetry"
      >
        <div className="fm-footer-diagnostics__heading">
          <Cpu size={14} aria-hidden="true" />
          <span>GPU</span>
          <span className="fm-footer-diagnostics__meta">
            {titleCase(gpuStatus)}
          </span>
        </div>
        {gpuDevices.length > 0 ? (
          <div className="fm-footer-diagnostics__gpu-list">
            {gpuDevices.map((device) => (
              <div
                className="fm-footer-diagnostics__gpu"
                key={`${device.index}-${device.name}`}
              >
                <span>
                  <Server size={13} aria-hidden="true" />
                  {device.name}
                </span>
                <span>
                  <Cpu size={13} aria-hidden="true" />
                  {formatPercent(device.utilization_gpu_percent)}
                </span>
                <span>
                  <HardDrive size={13} aria-hidden="true" />
                  {formatMemory(device.memory_used_mb, device.memory_total_mb)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            {gpu.data?.reason ?? "GPU telemetry pending."}
          </div>
        )}
      </section>
    </div>
  );
}

function SolverTracePanel({ model }: { model: SolverTracePanelModel }) {
  const statusIcon =
    model.completeness === "partial" ? (
      <AlertTriangle size={13} aria-hidden="true" />
    ) : (
      <Timer size={13} aria-hidden="true" />
    );

  return (
    <div role="group"
      className="fm-footer-diagnostics__trace"
      data-completeness={model.completeness}
      aria-label="Solver to render trace"
    >
      <div className="fm-footer-diagnostics__trace-heading">
        <span>Solver → render trace</span>
        <span
          className="fm-footer-diagnostics__trace-status"
          data-completeness={model.completeness}
        >
          {statusIcon}
          {model.completenessLabel}
        </span>
      </div>
      {model.traceId ? (
        <>
          <div className="fm-footer-diagnostics__trace-meta" title={model.traceId}>
            Sampled step {model.step} · {model.traceId}
          </div>
          {model.segments.length > 0 ? (
            <>
              <div
                className="fm-footer-diagnostics__trace-waterfall"
                role="img"
                aria-label={`Trace waterfall, ${formatNs(model.totalNs)} accounted`}
              >
                {model.segments.map((segment) => (
                  <span
                    className="fm-footer-diagnostics__trace-bar"
                    data-domain={segment.clockDomain}
                    key={segment.id}
                    style={{ width: `${segment.percent}%` }}
                    title={`${segment.label}: ${segment.duration}`}
                  />
                ))}
              </div>
              <ul className="fm-footer-diagnostics__trace-rows">
                {model.segments.map((segment) => (
                  <li
                    className="fm-footer-diagnostics__trace-row"
                    key={segment.id}
                  >
                    <span>{segment.label}</span>
                    <span data-domain={segment.clockDomain}>
                      {segment.clockDomain}
                    </span>
                    <span>{segment.duration}</span>
                    <span>{segment.percent.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
              <div className="fm-footer-diagnostics__trace-unaccounted">
                Unaccounted: server {model.unaccountedServer} · browser {model.unaccountedBrowser}
              </div>
            </>
          ) : (
            <div className="fm-footer-diagnostics__trace-empty" role="status">
              Server trace identity is present; no timing segments were published.
            </div>
          )}
        </>
      ) : (
        <div className="fm-footer-diagnostics__trace-empty" role="status">
          No sampled solver trace in the latest profile response.
        </div>
      )}
    </div>
  );
}

function formatTime(value: number): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? `${timestamp.toISOString().slice(11, 19)} UTC` : "Invalid time";
}

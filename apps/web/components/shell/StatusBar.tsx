"use client";

import {
  Activity, Clock, Cpu, HardDrive, Wifi, WifiOff,
  Loader2, CheckCircle2, XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import s from "./shell.module.css";

interface StatusBarProps {
  connection: "connecting" | "connected" | "disconnected";
  step: number;
  stepDisplay?: string;
  simTime: string;
  wallTime: string;
  throughput: string;
  backend: string;
  runtimeEngine?: string;
  precision: string;
  status: string;
  activityLabel?: string;
  activityDetail?: string;
  progressMode?: "idle" | "indeterminate" | "determinate";
  progressValue?: number;
  nodeCount?: string;
}

export default function StatusBar({
  connection,
  step,
  stepDisplay,
  simTime,
  wallTime,
  throughput,
  backend,
  runtimeEngine,
  precision,
  status,
  activityLabel,
  activityDetail,
  progressMode: _progressMode = "idle",
  progressValue: _progressValue,
  nodeCount,
}: StatusBarProps) {
  return (
    <div className={s.statusBar}>
      {(activityLabel || activityDetail) && (
        <div className={s.statusBarActivity}>
          <div className={s.statusBarActivityRow}>
            <span className={s.statusBarActivityLabel}>{activityLabel ?? "Workspace"}</span>
            {activityDetail && (
              <span className={s.statusBarActivityDetail} title={activityDetail}>
                {activityDetail}
              </span>
            )}
          </div>
        </div>
      )}
      <div className={s.statusBarMain}>
      {/* Left section: status + connection */}
      <div className={s.statusBarSection}>
        <span className={cn(s.statusBarItem, s.statusBarPrimary)} data-status={status}>
          {status === "running" ? <Activity size={12} className={s.statusBarSpinner} /> :
           status === "completed" ? <CheckCircle2 size={12} /> :
           status === "failed" ? <XCircle size={12} /> :
           <Loader2 size={12} />}
          {status}
        </span>
        <span className={s.statusBarDivider} />
        <span className={s.statusBarItem} data-connection={connection}>
          {connection === "connected" ? <Wifi size={11} /> : 
           connection === "connecting" ? <Loader2 size={11} className={s.statusBarSpinner} /> : 
           <WifiOff size={11} />}
          {connection}
        </span>
      </div>

      {/* Center: simulation metrics */}
      <div className={s.statusBarSection}>
        <span className={s.statusBarItem}>
          <Clock size={11} />
          {simTime}
        </span>
        <span className={s.statusBarDivider} />
        <span className={s.statusBarItem}>
          Step {stepDisplay ?? step.toLocaleString()}
        </span>
        <span className={s.statusBarDivider} />
        <span className={s.statusBarItem}>
          <Activity size={11} />
          {throughput}
        </span>
        {wallTime !== "—" && (
          <>
            <span className={s.statusBarDivider} />
            <span className={s.statusBarItem}>Elapsed: {wallTime}</span>
          </>
        )}
      </div>

      {/* Right: backend info */}
      <div className={s.statusBarSection}>
        {nodeCount && (
          <>
            <span className={s.statusBarItem}>
              <HardDrive size={11} />
              {nodeCount}
            </span>
            <span className={s.statusBarDivider} />
          </>
        )}
        <span className={s.statusBarItem}>
          <Cpu size={11} />
          {runtimeEngine ? `${runtimeEngine} · ${precision}` : `${backend.toUpperCase()} · ${precision}`}
        </span>
      </div>
      </div>
    </div>
  );
}

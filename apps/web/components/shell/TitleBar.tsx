"use client";

import { Pause, Play, Square, Target } from "lucide-react";
import s from "./shell.module.css";

interface TitleBarProps {
  problemName: string;
  backend: string;
  runtimeEngine?: string;
  status: string;
  connection: "connecting" | "connected" | "disconnected";
  interactiveEnabled?: boolean;
  runEnabled?: boolean;
  relaxEnabled?: boolean;
  pauseEnabled?: boolean;
  stopEnabled?: boolean;
  commandMessage?: string | null;
  onSimAction?: (action: string) => void;
}

export default function TitleBar({
  problemName,
  backend,
  runtimeEngine,
  status,
  connection,
  interactiveEnabled = false,
  runEnabled = false,
  relaxEnabled = false,
  pauseEnabled = false,
  stopEnabled = false,
  commandMessage,
  onSimAction,
}: TitleBarProps) {
  const controls = [
    { id: "relax", label: "Relax", icon: <Target size={11} />, tone: "relax", enabled: relaxEnabled },
    { id: "run", label: "Run", icon: <Play size={11} />, tone: "run", enabled: runEnabled },
    { id: "pause", label: "Pause", icon: <Pause size={11} />, tone: "pause", enabled: pauseEnabled },
    { id: "stop", label: "Stop", icon: <Square size={11} />, tone: "stop", enabled: stopEnabled },
  ] as const;
  const controlsTitle = commandMessage
    ?? (interactiveEnabled ? "Interactive simulation controls" : "Interactive controls are unavailable for this session");

  return (
    <div className={s.titleBar}>
      <span className={s.titleBarText}>
        {problemName}
        {backend && <> — <span className={s.titleBarMuted}>{backend.toUpperCase()}</span></>}
        {runtimeEngine && <> · <span className={s.titleBarMuted}>{runtimeEngine}</span></>}
      </span>

      <span className={s.titleBarSpacer} />

      <div className={s.titleBarControls} title={controlsTitle} aria-label="Simulation controls">
        {controls.map((control) => (
          <button
            key={control.id}
            type="button"
            className={s.titleBarAction}
            data-tone={control.tone}
            disabled={!control.enabled}
            onClick={() => onSimAction?.(control.id)}
            title={control.label}
          >
            {control.icon}
            <span>{control.label}</span>
          </button>
        ))}
      </div>

      <span className={s.titleBarStatus} data-connection={connection}>
        <span className={s.statusDotInline} data-connection={connection} />
        {status}
      </span>

      <span className={s.titleBarBrand}>Fullmag</span>
    </div>
  );
}

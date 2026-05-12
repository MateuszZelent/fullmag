"use client";

import StatusBadge from "./StatusBadge";

interface HeaderProps {
  status: string;
  scriptPath: string;
  problemName: string;
  connection: "connecting" | "connected" | "disconnected";
}

export default function Header({
  status,
  scriptPath,
  problemName,
  connection,
}: HeaderProps) {
  const solverTone =
    status === "running"
      ? "success"
      : status === "completed"
        ? "info"
        : status === "failed"
          ? "danger"
          : "warn";

  const solverLabel =
    status ? status[0].toUpperCase() + status.slice(1) : "Idle";

  const connTone =
    connection === "connected"
      ? "success"
      : connection === "connecting"
        ? "warn"
        : "danger";

  const connLabel =
    connection === "connected"
      ? "Connected"
      : connection === "connecting"
        ? "Reconnecting"
        : "Disconnected";

  return (
    <header className="sticky top-0 z-[40] grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 px-4 border border-border/40 rounded-xl bg-gradient-to-b from-card/30 to-card/10 backdrop-blur-xl shadow-sm overflow-hidden min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge label={connLabel} tone={connTone} pulse={connection !== "connected"} />
        <StatusBadge label={solverLabel} tone={solverTone} pulse={status === "running"} />
      </div>

      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Workspace</span>
        <strong className="text-base font-bold tracking-tight truncate whitespace-nowrap text-foreground min-w-0">
          {problemName || scriptPath || "No simulation file loaded"}
        </strong>
      </div>

      <span className="text-sm text-muted-foreground">fullmag</span>
    </header>
  );
}

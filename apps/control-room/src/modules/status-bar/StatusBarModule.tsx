"use client";

import { useEffect, useState } from "react";

import { useSessionStatus } from "@/kernel/resources/useSessionStatus";

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export default function StatusBarModule() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const status = useSessionStatus();
  const sessionState = mounted
    ? readString(status.data?.solver.state, status.status)
    : "loading";
  const sessionName = mounted
    ? readString(status.data?.session.name, "session unavailable")
    : "—";
  const runtimeVersion = mounted
    ? readString(status.data?.runtime_bundle_version, "runtime unavailable")
    : "—";
  const dotStatus = mounted ? status.status : "loading";

  return (
    <div className="fm-status-bar" role="status" aria-label="Session status">
      <span
        className="fm-status-bar__dot"
        data-status={dotStatus}
        aria-hidden="true"
      />
      <span className="fm-status-bar__item">{sessionState}</span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span className="fm-status-bar__item">{sessionName}</span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span className="fm-status-bar__item">{runtimeVersion}</span>
    </div>
  );
}

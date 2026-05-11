"use client";

import { useSessionStatus } from "@/kernel/resources/useSessionStatus";

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export default function StatusBarModule() {
  const status = useSessionStatus();
  const sessionState = readString(status.data?.session.state, status.status);
  const runtimeVersion = readString(
    status.data?.runtime_bundle_version,
    "runtime unavailable",
  );

  return (
    <div className="fm-slot__module" data-resource-status={status.status}>
      <span>{sessionState}</span>
      <span aria-hidden="true">&nbsp;|&nbsp;</span>
      <span>{runtimeVersion}</span>
    </div>
  );
}

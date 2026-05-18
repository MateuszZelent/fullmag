"use client";

import { useSyncExternalStore } from "react";

import { useCurrentRunResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";

import {
  buildStatusBarEngineModel,
  formatRuntimeBundleVersionLabel,
} from "./statusBarModel";

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function subscribeToMounted(): () => void {
  return () => {};
}

function clientMountedSnapshot(): boolean {
  return true;
}

function serverMountedSnapshot(): boolean {
  return false;
}

export default function StatusBarModule() {
  const mounted = useSyncExternalStore(
    subscribeToMounted,
    clientMountedSnapshot,
    serverMountedSnapshot,
  );

  const status = useSessionStatus();
  const currentRun = useCurrentRunResource({ enabled: mounted });
  const engine = buildStatusBarEngineModel(mounted ? currentRun.data : null);
  const sessionState = mounted
    ? readString(status.data?.solver.state, status.status)
    : "loading";
  const sessionName = mounted
    ? readString(status.data?.session.name, "session unavailable")
    : "—";
  const runtimeVersion = mounted
    ? formatRuntimeBundleVersionLabel(
        readString(status.data?.runtime_bundle_version, "runtime unavailable"),
      )
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
      <span className="fm-status-bar__spacer" aria-hidden="true" />
      <span
        className="fm-status-bar__engine"
        data-state={engine.state}
        title={engine.title}
      >
        <span className="fm-status-bar__engine-label">{engine.label}</span>
        <span className="fm-status-bar__engine-sep" aria-hidden="true">
          {" | "}
        </span>
        <span className="fm-status-bar__engine-detail">{engine.detail}</span>
      </span>
    </div>
  );
}

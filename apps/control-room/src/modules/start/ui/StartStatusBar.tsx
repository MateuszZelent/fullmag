import type { ComputeProbeState, RecentIndexState } from "../model/types";
import type { StartPreferencesController } from "../model/useStartPreferences";

import { TelemetrySwitch, UpdateNoticeItem } from "./TelemetrySwitch";
import { describeCompute, describeIndexCount } from "./StartStatusBar.model";

export interface StartStatusBarProps {
  readonly compute: ComputeProbeState;
  readonly index: RecentIndexState;
  readonly sessionLabel?: string;
  /** Stored preferences; omitted, the strip shows neither the switch nor an update notice. */
  readonly preferences?: StartPreferencesController;
}

/**
 * The bottom strip of the mockup. Every item is something this page knows.
 * The telemetry switch records a preference and says plainly that this build
 * sends nothing; the update notice appears only when an updater stored one.
 * The mockup's build number stays out until the host exposes it.
 */
export function StartStatusBar({ compute, index, preferences, sessionLabel = "No active session" }: StartStatusBarProps) {
  const items = [
    sessionLabel,
    describeCompute(compute),
    describeIndexCount(index),
  ].filter((item): item is string => item !== null);
  return (
    <footer aria-label="Status" className="fm-start-status">
      {items.map((item) => (
        <span className="fm-start-status__item" key={item}>
          {item}
        </span>
      ))}
      {preferences?.state.kind === "ready" ? <UpdateNoticeItem notice={preferences.state.update} /> : null}
      {preferences ? (
        <TelemetrySwitch onChange={preferences.setTelemetry} saving={preferences.saving} state={preferences.state} />
      ) : null}
    </footer>
  );
}

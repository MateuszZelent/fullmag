"use client";

import { useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { startSettings, type RecentView } from "../model/startSettings";
import type { RecentIndexController } from "../model/useRecentIndex";
import type { WorkspaceItemsController } from "../model/useWorkspaceItems";
import type { ComputeProbeState, ScannedLocation } from "../model/types";

import { ComputeEnvironmentSettings } from "./ComputeEnvironmentSettings";
import { IndexedLocations } from "./IndexedLocations";

const VIEW_OPTIONS = [
  { label: "List", value: "list" },
  { label: "Grid", value: "grid" },
] as const satisfies readonly { label: string; value: RecentView }[];

interface SettingsSectionProps {
  readonly recent: RecentIndexController;
  /** The workspace database API; "Indexed locations" is shown when it answers. */
  readonly workspace?: WorkspaceItemsController;
  readonly compute?: ComputeProbeState;
  readonly refreshing?: boolean;
  readonly stale?: boolean;
  readonly computeError?: string | null;
  readonly onRefreshCompute?: () => void;
}

export function SettingsSection({
  recent,
  workspace,
  compute,
  refreshing = false,
  stale = false,
  computeError = null,
  onRefreshCompute,
}: SettingsSectionProps) {
  const settings = useSyncExternalStore(
    startSettings.subscribe,
    startSettings.getSnapshot,
    startSettings.getServerSnapshot,
  );
  const locations =
    recent.state.kind === "ready" ? (recent.state.index.scannedLocations ?? []) : [];

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Settings</h1>
          <p>What the start screen needs. Changes apply immediately.</p>
        </div>
      </div>

      <ComputeEnvironmentSettings
        compute={compute}
        error={computeError}
        onRefresh={onRefreshCompute}
        refreshing={refreshing}
        stale={stale}
      />

      <section aria-labelledby="fm-start-set-appearance" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-set-appearance">
          Recent projects
        </h2>
        <div className="fm-start-setting">
          <span id="fm-start-set-view">Default view</span>
          <SegmentedControl
            aria-label="Default view of the recent projects list"
            onValueChange={(value) => startSettings.update({ defaultView: value })}
            options={VIEW_OPTIONS}
            value={settings.defaultView}
          />
        </div>
      </section>

      {workspace && workspace.state.kind === "ready" ? (
        <IndexedLocations workspace={workspace} />
      ) : (
        <ScannedLocations recent={recent} locations={locations} />
      )}
    </>
  );
}

function ScannedLocations({
  recent,
  locations,
}: {
  readonly recent: RecentIndexController;
  readonly locations: readonly ScannedLocation[];
}) {
  return (
      <section aria-labelledby="fm-start-set-locations" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-set-locations">
          Scanned locations
        </h2>
        {locations.length > 0 ? (
          <ul className="fm-start-locations">
            {locations.map((location) => (
              <li key={location.path}>
                <span className="fm-start-locations__path">{location.path}</span>
                <span className="fm-start-locations__state">
                  {location.reachable === false ? "unreachable" : "scanned"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fm-start-inspector__note">
            {recent.state.kind === "unavailable"
              ? "Project folders are scanned by the desktop app."
              : "No folder has been scanned yet."}
          </p>
        )}
        <Button
          disabled={recent.rebuilding || recent.state.kind === "unavailable"}
          onClick={() => void recent.rebuild()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {recent.rebuilding ? "Scanning…" : "Rebuild index"}
        </Button>
      </section>
  );
}

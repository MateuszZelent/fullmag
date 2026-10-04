"use client";

import { useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { startSettings, type RecentView } from "../model/startSettings";
import type { RecentIndexController } from "../model/useRecentIndex";

const VIEW_OPTIONS = [
  { label: "List", value: "list" },
  { label: "Grid", value: "grid" },
] as const satisfies readonly { label: string; value: RecentView }[];

export function SettingsSection({ recent }: { readonly recent: RecentIndexController }) {
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
    </>
  );
}

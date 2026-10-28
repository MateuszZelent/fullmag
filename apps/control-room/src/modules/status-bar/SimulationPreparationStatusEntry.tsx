"use client";

import {
  simulationPreparationWindow,
  useSimulationPreparationWindow,
} from "@/kernel/layout/simulationPreparationWindow";

/**
 * Status bar entry of the latest simulation preparation. It stays available
 * after the window is closed or the preparation finished, and reopens it.
 */
export function SimulationPreparationStatusEntry() {
  const preparation = useSimulationPreparationWindow().summary;
  if (!preparation) return null;

  return (
    <>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <button
        type="button"
        aria-label={`Show simulation preparation: ${preparation.title}`}
        className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable fm-status-bar__preparation"
        data-preparation-status-entry
        data-tone={preparation.tone}
        title={preparation.title}
        onClick={simulationPreparationWindow.open}
      >
        Preparation: {preparation.label}
      </button>
    </>
  );
}

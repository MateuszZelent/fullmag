import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY, serializeAnalysisViewPreferences } from "./analysisViewPreferences";
import { useAnalysisViewPreferencesHydration } from "./useAnalysisViewPreferencesHydration";

function PreferencesProbe() {
  const { isHydrated, preferences } = useAnalysisViewPreferencesHydration();
  return <span>{`${preferences.activeSurface}:${isHydrated}`}</span>;
}

let mountedPreferences: ReturnType<typeof useAnalysisViewPreferencesHydration> | null = null;
function MountedPreferencesProbe() {
  const preferences = useAnalysisViewPreferencesHydration();
  useEffect(() => { mountedPreferences = preferences; }, [preferences]);
  return <span>{preferences.preferences.descriptorPreferences["artifact:frequency-response:artifact://response"]?.displayUnits.amplitude ?? "base"}</span>;
}

function MountedSubviewProbe() {
  const preferences = useAnalysisViewPreferencesHydration();
  useEffect(() => { mountedPreferences = preferences; }, [preferences]);
  return <span>{preferences.preferences.activeSubviews["resonance-fmr"]}</span>;
}

describe("analysis preference hydration", () => {
  it("uses the stable server snapshot during SSR", () => {
    expect(renderToStaticMarkup(<PreferencesProbe />)).toContain("dynamics:false");
  });

  it("hydrates an artifact display-unit preference from storage and retains it across remount", async () => {
    const dom = installSimulationPreparationTestDom();
    const values = new Map<string, string>();
    values.set(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY, serializeAnalysisViewPreferences({
      activeSurface: "resonance-fmr",
      descriptorPreferences: {
        "artifact:frequency-response:artifact://response": { displayUnits: { amplitude: "mJ" }, range: null, selectedSeriesIds: ["response"] },
      },
      schemaVersion: 2,
      selectedDatasetRef: null,
    })!);
    Object.defineProperty(globalThis.window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<MountedPreferencesProbe />));
      expect(container.textContent).toBe("mJ");
      await act(async () => {
        mountedPreferences?.setDescriptorPreference("artifact:frequency-response:artifact://response", {
          displayUnits: { amplitude: "nJ" },
          range: null,
          selectedSeriesIds: ["response"],
        });
      });
      await act(async () => root.render(<MountedPreferencesProbe />));
      expect(container.textContent).toBe("nJ");
      expect(values.get(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY)).toContain("nJ");

      await act(async () => {
        (mountedPreferences?.setDescriptorPreference as unknown as ((id: string, value: unknown) => void))(
          "artifact:frequency-response:partial",
          { displayUnits: { amplitude: "J" } },
        );
      });
      await act(async () => root.render(<MountedPreferencesProbe />));
      expect(mountedPreferences?.preferences.descriptorPreferences["artifact:frequency-response:partial"]).toBeUndefined();
    } finally {
      mountedPreferences = null;
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("persists a canonical contextual subview change", async () => {
    const dom = installSimulationPreparationTestDom();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis.window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<MountedSubviewProbe />));
      await act(async () => mountedPreferences?.setActiveSubview("resonance-fmr", "resonance.modal-driven"));

      expect(container.textContent).toBe("resonance.modal-driven");
      expect(values.get(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY)).toContain('"resonance-fmr":"resonance.modal-driven"');
    } finally {
      mountedPreferences = null;
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

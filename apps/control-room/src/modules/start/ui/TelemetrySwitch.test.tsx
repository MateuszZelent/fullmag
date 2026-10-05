import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PreferencesState } from "../model/startPreferences";
import type { StartPreferencesController } from "../model/useStartPreferences";

import { StartStatusBar } from "./StartStatusBar";
import { TelemetrySwitch, UpdateNoticeItem, telemetryLabel } from "./TelemetrySwitch";

const ready = (telemetryEnabled: boolean, update?: { version?: string }): PreferencesState => ({
  kind: "ready",
  telemetryEnabled,
  update,
});
const render = (state: PreferencesState, saving = false) =>
  renderToStaticMarkup(<TelemetrySwitch onChange={vi.fn(async () => null)} saving={saving} state={state} />);

describe("TelemetrySwitch", () => {
  it("is an unchecked switch that says this build sends no data when off", () => {
    const html = render(ready(false));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Telemetry off — this build sends no data");
    expect(html).not.toContain("disabled");
  });

  it("is checked and still says no collector is configured when on", () => {
    const html = render(ready(true));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Telemetry on — no collector is configured in this build");
  });

  it("has an explanatory popover trigger that starts closed", () => {
    const html = render(ready(false));
    expect(html).toContain('aria-label="About telemetry"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="note"');
  });

  it("is disabled while loading, unavailable or saving", () => {
    expect(render({ kind: "loading" })).toContain("disabled");
    const unavailable = render({ kind: "unavailable", reason: "This backend does not store settings yet." });
    expect(unavailable).toContain("disabled");
    expect(unavailable).toContain("Telemetry setting unavailable — This backend does not store settings yet.");
    expect(render(ready(false), true)).toContain("disabled");
  });

  it("labels states without inventing one", () => {
    expect(telemetryLabel({ kind: "loading" })).toBe("Reading the telemetry setting…");
  });
});

describe("update notice", () => {
  it("renders nothing without a stored notice and the version with one", () => {
    expect(renderToStaticMarkup(<UpdateNoticeItem notice={undefined} />)).toBe("");
    const html = renderToStaticMarkup(<UpdateNoticeItem notice={{ version: "0.9.0" }} />);
    expect(html).toContain("Update available: 0.9.0");
    expect(html).toContain('data-status="update-available"');
  });
});

describe("StartStatusBar preferences", () => {
  const controller = (state: PreferencesState): StartPreferencesController => ({
    state,
    saving: false,
    setTelemetry: vi.fn(async () => null),
  });
  const bar = (preferences?: StartPreferencesController) =>
    renderToStaticMarkup(<StartStatusBar compute={null} index={{ kind: "loading" }} preferences={preferences} />);

  it("shows neither the switch nor a notice without preferences", () => {
    const html = bar();
    expect(html).not.toContain("Telemetry");
    expect(html).not.toContain("Update available");
  });

  it("shows the switch always and the update notice only when stored", () => {
    expect(bar(controller(ready(false)))).toContain("Telemetry off");
    expect(bar(controller(ready(false)))).not.toContain("Update available");
    expect(bar(controller(ready(false, { version: "2.0.0" })))).toContain("Update available: 2.0.0");
  });
});

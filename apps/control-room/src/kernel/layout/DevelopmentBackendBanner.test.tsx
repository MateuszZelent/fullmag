import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DevelopmentBackendResource } from "../api/apiTypes";
import { useDevelopmentBackendResource } from "../resources/developmentBackendResource";
import { DevelopmentBackendBanner } from "./DevelopmentBackendBanner";

vi.mock("../KernelContext", () => ({ useKernel: () => ({}) }));
vi.mock("../resources/developmentBackendResource", () => ({ useDevelopmentBackendResource: vi.fn() }));
vi.mock("../development/useDevelopmentWorkspacePaused", () => ({
  useDevelopmentWorkspacePublicationError: () => null,
}));

afterEach(() => vi.resetAllMocks());

function renderState(state: DevelopmentBackendResource["state"], reason: DevelopmentBackendResource["reason"]) {
  vi.mocked(useDevelopmentBackendResource).mockReturnValue({
    data: { schema_version: "1.0.0", configured: true, revision: 1, state, reason, restart_available: false },
    status: "ready", error: null, revision: 1, refetch: vi.fn(),
  });
  return renderToStaticMarkup(<DevelopmentBackendBanner />);
}

describe("development backend observation diagnostics", () => {
  it.each([
    ["configuration_invalid", "configuration is invalid"],
    ["observation_unavailable", "status file could not be read"],
    ["observation_invalid", "different workspace generation"],
    ["observation_stale", "heartbeat is out of date"],
    ["watcher_stopped", "watcher has stopped"],
  ] as const)("explains unknown status reason %s", (reason, message) => {
    const html = renderState("unknown", reason);
    expect(html).toContain(message);
    expect(html).toContain("Retry");
    expect(html).not.toContain("Status is unknown.");
    expect(html).not.toContain("Restart backend");
  });

  it("distinguishes a stopped watcher from a superseded build", () => {
    expect(renderState("stopped", "watcher_stopped")).toContain("Retry only checks its status");
    expect(renderState("superseded", "build_pending")).toContain("sources changed during the build");
  });

  it("does not show a banner for disabled development observation", () => {
    expect(renderState("disabled", "disabled")).toBe("");
  });
});

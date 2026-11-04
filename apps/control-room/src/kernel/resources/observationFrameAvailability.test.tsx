import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";
import { useObservationFrameListResource } from "./observationFrameResources";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  useResource: vi.fn(),
  status: null as LiveStatusResource | null,
  sessionIdentity: { sessionId: "session-a" } as { sessionId: string } | null,
}));

vi.mock("../KernelContext", () => ({
  useKernel: () => ({ api: { data: { observationFrames: { list: mocks.list } } } }),
}));
vi.mock("./useResource", () => ({ useResource: mocks.useResource }));
vi.mock("./useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (key: string) => ({
    resourceKey: `scope:${key}`,
    sessionIdentity: mocks.sessionIdentity,
  }),
}));
vi.mock("./useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (value: { data: LiveStatusResource | null }) => unknown) =>
    selector({ data: mocks.status }),
}));

function optionsFor(options: Parameters<typeof useObservationFrameListResource>[0] = {}) {
  function Harness() {
    useObservationFrameListResource(options);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return mocks.useResource.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.useResource.mockReset();
  mocks.useResource.mockReturnValue({ data: null, status: "idle" });
  mocks.sessionIdentity = { sessionId: "session-a" };
  mocks.status = { session: { session_id: "session-a" }, run: null } as LiveStatusResource;
});

describe("observation frame list availability", () => {
  it("does not load a synthetic observation run in an authoring-only session", () => {
    expect(optionsFor().enabled).toBe(false);
  });

  it("does not treat a blank run filter as a retained run", () => {
    expect(optionsFor({ runId: "   " }).enabled).toBe(false);
  });

  it("loads an explicitly selected retained run without a current simulation", async () => {
    const options = optionsFor({ runId: " retained-run " });
    expect(options.enabled).toBe(true);
    const signal = new AbortController().signal;
    await options.load({ sessionScopeKey: "scope-key", signal });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "retained-run" }),
      { sessionScopeKey: "scope-key", signal },
    );
  });

  it("loads the default list once the current simulation run exists", () => {
    mocks.status = { session: { session_id: "session-a" }, run: { run_id: "run-a" } } as LiveStatusResource;
    expect(optionsFor().enabled).toBe(true);
  });

  it("keeps explicit disable authoritative for retained runs", () => {
    expect(optionsFor({ enabled: false, runId: "retained-run" }).enabled).toBe(false);
  });

  it("requires a confirmed session scope even for retained runs", () => {
    mocks.sessionIdentity = null;
    expect(optionsFor({ runId: "retained-run" }).enabled).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildVisualizationStateFetchIdentity,
  shouldFetchVisualizationStateResource,
} from "../useVisualizationStateResource";

describe("useVisualizationStateResource helpers", () => {
  it("builds session/revision fetch identities", () => {
    expect(
      buildVisualizationStateFetchIdentity({
        sessionKey: "session-1",
        revision: 4,
      }),
    ).toBe("session-1:4");

    expect(
      buildVisualizationStateFetchIdentity({
        sessionKey: "session-1",
        revision: null,
      }),
    ).toBe("session-1:no-revision");

    expect(
      buildVisualizationStateFetchIdentity({
        sessionKey: null,
        revision: 4,
      }),
    ).toBeNull();
  });

  it("fetches only enabled positive revisions that did not already 404", () => {
    expect(
      shouldFetchVisualizationStateResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 2,
        fetchIdentity: "session-1:2",
        notFoundIdentity: null,
      }),
    ).toBe(true);

    expect(
      shouldFetchVisualizationStateResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 2,
        fetchIdentity: "session-1:2",
        notFoundIdentity: "session-1:2",
      }),
    ).toBe(false);

    expect(
      shouldFetchVisualizationStateResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 0,
        fetchIdentity: "session-1:0",
        notFoundIdentity: null,
      }),
    ).toBe(false);

    expect(
      shouldFetchVisualizationStateResource({
        enabled: false,
        sessionKey: "session-1",
        revision: 2,
        fetchIdentity: "session-1:2",
        notFoundIdentity: null,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { shouldFetchStageExecutionResource } from "../useStageExecution";

describe("shouldFetchStageExecutionResource", () => {
  it("does not fetch until a positive stages revision exists", () => {
    expect(
      shouldFetchStageExecutionResource({
        enabled: true,
        sessionKey: "session-1",
        revision: null,
        fetchIdentity: "session-1:no-revision",
        notFoundIdentity: null,
      }),
    ).toBe(false);

    expect(
      shouldFetchStageExecutionResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 0,
        fetchIdentity: "session-1:0",
        notFoundIdentity: null,
      }),
    ).toBe(false);
  });

  it("fetches positive revisions unless the same identity already returned 404", () => {
    expect(
      shouldFetchStageExecutionResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 2,
        fetchIdentity: "session-1:2",
        notFoundIdentity: null,
      }),
    ).toBe(true);

    expect(
      shouldFetchStageExecutionResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 2,
        fetchIdentity: "session-1:2",
        notFoundIdentity: "session-1:2",
      }),
    ).toBe(false);

    expect(
      shouldFetchStageExecutionResource({
        enabled: true,
        sessionKey: "session-1",
        revision: 3,
        fetchIdentity: "session-1:3",
        notFoundIdentity: "session-1:2",
      }),
    ).toBe(true);
  });
});

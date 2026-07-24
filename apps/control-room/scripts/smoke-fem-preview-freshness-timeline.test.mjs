import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  classifyFieldRequestFailure,
  classifyFieldResponseInspectionFailure,
  isPreterminalPendingOrStaleField,
  observeFirstTerminalAt,
  selectPreterminalFieldResponse,
  selectTerminalFieldResponse,
} from "./smoke-fem-preview-freshness-timeline.mjs";

const smokeSource = readFileSync(
  new URL("./smoke-fem-preview-freshness.mjs", import.meta.url),
  "utf8",
);

describe("FEM preview browser observation timeline", () => {
  it("selects the full-cache target quantity before mounting the workspace", () => {
    const selectionPatch = smokeSource.indexOf(
      'selectedDisplay = await patchJson("/v2/sessions/current/visualization/display"',
    );
    const workspaceNavigation = smokeSource.indexOf("await page.goto(workspaceUrl");

    expect(selectionPatch).toBeGreaterThan(-1);
    expect(workspaceNavigation).toBeGreaterThan(selectionPatch);
  });

  it("accepts a same-attempt stale meta abort followed by newer successful meta", () => {
    expect(
      classifyFieldRequestFailure({
        failure: {
          attemptId: "attempt-1",
          errorText: "net::ERR_ABORTED",
          method: "GET",
          observedAt: 20,
          url: "/v2/sessions/current/data/fields/H_demag/meta?component=full",
        },
        firstTerminalObservedAt: null,
        responseAttempts: [
          {
            attemptId: "attempt-1",
            fieldRevision: null,
            receivedAt: 15,
            status: 404,
            url: "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/meta?component=full",
          },
          {
            attemptId: "attempt-2",
            fieldRevision: "2",
            receivedAt: 30,
            status: 200,
            url: "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/meta?component=full",
          },
        ],
        validResponses: [],
      }),
    ).toEqual({ intentionalStaleInflightAbort: true });
  });

  it("accepts a same-attempt stale meta abort superseded by a terminal field body", () => {
    expect(
      classifyFieldRequestFailure({
        failure: {
          attemptId: "attempt-1",
          errorText: "net::ERR_ABORTED",
          method: "GET",
          observedAt: 20,
          url: "/v2/sessions/current/data/fields/H_demag/meta?component=full",
        },
        firstTerminalObservedAt: 30,
        responseAttempts: [
          {
            attemptId: "attempt-1",
            fieldRevision: null,
            receivedAt: 15,
            status: 404,
            url: "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/meta?component=full",
          },
        ],
        validResponses: [
          {
            bodySha256: "terminal-body",
            fieldRevision: "2",
            receivedAt: 40,
            responseUrl:
              "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/samples/vector?component=full",
          },
        ],
      }),
    ).toEqual({ intentionalStaleInflightAbort: true });
  });

  it.each([
    {
      label: "has no response from the same attempt",
      overrides: { responseAttempts: [] },
    },
    {
      label: "was aborted on a non-meta URL",
      overrides: {
        failure: {
          attemptId: "attempt-1",
          errorText: "net::ERR_ABORTED",
          method: "GET",
          observedAt: 20,
          url: "/v2/sessions/current/data/fields/H_demag/samples/vector?component=full",
        },
      },
    },
    {
      label: "was not aborted",
      overrides: {
        failure: {
          attemptId: "attempt-1",
          errorText: "net::ERR_FAILED",
          method: "GET",
          observedAt: 20,
          url: "/v2/sessions/current/data/fields/H_demag/meta?component=full",
        },
      },
    },
    {
      label: "only has a pre-terminal field body",
      overrides: { firstTerminalObservedAt: 50 },
    },
    {
      label: "has a terminal body for another quantity",
      overrides: {
        validResponses: [
          {
            bodySha256: "other-terminal-body",
            fieldRevision: "2",
            receivedAt: 40,
            responseUrl:
              "http://127.0.0.1/v2/sessions/current/data/fields/m/samples/vector?component=full",
          },
        ],
      },
    },
    {
      label: "has an older terminal revision",
      overrides: {
        responseAttempts: [
          {
            attemptId: "attempt-1",
            fieldRevision: "3",
            receivedAt: 15,
            status: 200,
            url: "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/meta?component=full",
          },
        ],
      },
    },
  ])("keeps a meta request failure fatal when it $label", ({ overrides }) => {
    const base = {
      failure: {
        attemptId: "attempt-1",
        errorText: "net::ERR_ABORTED",
        method: "GET",
        observedAt: 20,
        url: "/v2/sessions/current/data/fields/H_demag/meta?component=full",
      },
      firstTerminalObservedAt: 30,
      responseAttempts: [
        {
          attemptId: "attempt-1",
          fieldRevision: null,
          receivedAt: 15,
          status: 404,
          url: "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/meta?component=full",
        },
      ],
      validResponses: [
        {
          bodySha256: "terminal-body",
          fieldRevision: "2",
          receivedAt: 40,
          responseUrl:
            "http://127.0.0.1/v2/sessions/current/data/fields/H_demag/samples/vector?component=full",
        },
      ],
    };
    expect(classifyFieldRequestFailure({ ...base, ...overrides })).toEqual({
      intentionalStaleInflightAbort: false,
    });
  });

  it("keeps a page-consumed response that arrived before a later terminal poll", () => {
    const responses = [{ payloadSha256: "preterminal", receivedAt: 10 }];
    const firstTerminalObservedAt = observeFirstTerminalAt(null, true, 20);

    expect(
      selectPreterminalFieldResponse(responses, firstTerminalObservedAt),
    ).toBe(responses[0]);
  });

  it("rejects a page-consumed response that arrived after terminal was observed", () => {
    const firstTerminalObservedAt = observeFirstTerminalAt(null, true, 10);
    const responses = [{ payloadSha256: "terminal", receivedAt: 20 }];

    expect(
      selectPreterminalFieldResponse(responses, firstTerminalObservedAt),
    ).toBeNull();
  });

  it("preserves the first terminal observation across later polls", () => {
    const first = observeFirstTerminalAt(null, true, 10);

    expect(observeFirstTerminalAt(first, true, 30)).toBe(10);
    expect(observeFirstTerminalAt(first, false, 40)).toBe(10);
  });

  it.each(["pending", "stale_complete"])(
    "accepts %s as an explicit pre-terminal full-cache state",
    (state) => {
      expect(
        isPreterminalPendingOrStaleField(
          { source_step: 50, state },
          52,
        ),
      ).toBe(true);
    },
  );

  it("rejects complete and terminal-step metadata as pre-terminal pending proof", () => {
    expect(
      isPreterminalPendingOrStaleField(
        { source_step: 50, state: "complete" },
        52,
      ),
    ).toBe(false);
    expect(
      isPreterminalPendingOrStaleField(
        { source_step: 52, state: "pending" },
        52,
      ),
    ).toBe(false);
  });

  it("selects a page-consumed field body observed at or after terminal", () => {
    const responses = [
      { payloadSha256: "preterminal", receivedAt: 10 },
      { payloadSha256: "terminal", receivedAt: 30 },
    ];

    expect(selectTerminalFieldResponse(responses, 20)).toBe(responses[1]);
    expect(selectTerminalFieldResponse(responses, null)).toBeNull();
  });

  it("classifies a stale in-flight CDP body miss after a valid response", () => {
    expect(
      classifyFieldResponseInspectionFailure({
        attemptId: "attempt-2",
        errorMessage:
          "response.body: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
        receivedAt: 20,
        requestFailure: { errorText: "net::ERR_ABORTED" },
        requestFailureAttemptId: "attempt-2",
        responseUrl:
          "http://127.0.0.1:8197/v2/sessions/current/data/fields/H_demag/samples/vector?component=full",
        validResponses: [{ bodySha256: "valid", receivedAt: 10 }],
      }),
    ).toEqual({ intentionalStaleInflightAbort: true });
  });

  it.each([
    {
      label: "has no earlier valid body",
      overrides: { validResponses: [] },
    },
    {
      label: "uses an unexpected URL",
      overrides: {
        responseUrl:
          "http://127.0.0.1:8197/v2/sessions/current/data/fields/H_demag/meta",
      },
    },
    {
      label: "was aborted by an unrelated request",
      overrides: { requestFailureAttemptId: "attempt-1" },
    },
    {
      label: "was not aborted",
      overrides: { requestFailure: { errorText: "net::ERR_FAILED" } },
    },
    {
      label: "failed FMVP validation instead of CDP body retrieval",
      overrides: { errorMessage: "field response is not a valid FMVP payload" },
    },
  ])("keeps the response inspection failure fatal when it $label", ({ overrides }) => {
    expect(
      classifyFieldResponseInspectionFailure({
        attemptId: "attempt-2",
        errorMessage:
          "response.body: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
        receivedAt: 20,
        requestFailure: { errorText: "net::ERR_ABORTED" },
        requestFailureAttemptId: "attempt-2",
        responseUrl:
          "http://127.0.0.1:8197/v2/sessions/current/data/fields/H_demag/samples/vector?component=full",
        validResponses: [{ bodySha256: "valid", receivedAt: 10 }],
        ...overrides,
      }),
    ).toEqual({ intentionalStaleInflightAbort: false });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_FIELD_AVAILABILITY_PATH } from "../api/apiPaths";
import type {
  FieldAvailabilityResource,
  ResourceRevision,
} from "../api/apiTypes";

import {
  resolveFieldAvailabilityDataState,
  resolveFieldAvailabilityResourceKey,
  resolveFieldAvailabilityResultState,
  resolveFieldAvailabilityRevision,
  useFieldAvailabilityResource,
} from "./fieldAvailabilityResources";

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  useResource: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      data: {
        fields: {
          availability: mocks.availability,
        },
      },
    },
  }),
}));

vi.mock("./useResource", () => ({
  useResource: mocks.useResource,
}));

const availabilityResource = (
  overrides: Partial<FieldAvailabilityResource> = {},
): FieldAvailabilityResource => ({
  carrier_id: null,
  generation: "generation-1",
  materialized: false,
  pending: false,
  quantity_id: "H_demag",
  reason_code: null,
  revision: null,
  scope_id: "airbox",
  scope_kind: "airbox",
  state: "supported",
  supported: true,
  target_id: "airbox",
  ...overrides,
});

describe("fieldAvailabilityResources", () => {
  beforeEach(() => {
    mocks.availability.mockReset();
    mocks.useResource.mockReset();
    mocks.useResource.mockReturnValue({
      data: null,
      error: null,
      refetch: vi.fn(),
      revision: null,
      status: "loading",
    });
  });

  it("builds a canonical, ordered and normalized availability resource key", () => {
    const expectedPath = DATA_FIELD_AVAILABILITY_PATH.replace(
      "{quantity_id}",
      "H_demag",
    );

    expect(
      resolveFieldAvailabilityResourceKey(" h_demag ", {
        owner_object_id: " object:1 ",
        scope_id: " layer 1 ",
        scope_kind: " AIRBOX ",
        target_id: " target/one ",
      }),
    ).toBe(
      `${expectedPath}?target_id=target%2Fone&scope_kind=airbox&scope_id=layer+1&owner_object_id=object%3A1`,
    );
  });

  it("encodes analysis quantities and omits blank optional query values", () => {
    const key = resolveFieldAvailabilityResourceKey(
      " analysis:eigen:sample 1/mode?2 ",
      {
        owner_object_id: " ",
        scope_id: null,
        scope_kind: "  ",
        target_id: undefined,
      },
    );

    expect(key).toBe(
      `${DATA_FIELD_AVAILABILITY_PATH.replace(
        "{quantity_id}",
        "analysis%3Aeigen%3Asample%201%2Fmode%3F2",
      )}`,
    );
  });

  it("resolves the field revision before falling back to carrier generation", () => {
    expect(
      resolveFieldAvailabilityRevision(
        availabilityResource({ generation: "generation-7", revision: 12 }),
      ),
    ).toBe(12);
    expect(
      resolveFieldAvailabilityRevision(
        availabilityResource({ generation: "generation-7", revision: null }),
      ),
    ).toBe("generation-7");
    expect(resolveFieldAvailabilityRevision(null)).toBeNull();
  });

  it.each([
    [
      "ready",
      availabilityResource({ materialized: true, revision: 4, state: "ready" }),
      "ready",
    ],
    [
      "supported but not materialized",
      availabilityResource({ state: "supported" }),
      "partial",
    ],
    [
      "materializing",
      availabilityResource({ pending: true, state: "materializing" }),
      "pending",
    ],
    [
      "unsupported",
      availabilityResource({ state: "unavailable", supported: false }),
      "unavailable",
    ],
  ] as const)("maps %s availability data to %s", (_name, data, expected) => {
    expect(resolveFieldAvailabilityDataState(data)).toBe(expected);
  });

  it("keeps transport errors distinct from backend availability states", () => {
    const data = availabilityResource({ materialized: true, state: "ready" });

    expect(
      resolveFieldAvailabilityResultState({ data, status: "ready" }),
    ).toBe("ready");
    expect(
      resolveFieldAvailabilityResultState({ data, status: "error" }),
    ).toBe("error");
  });

  it("wires the normalized query and AbortSignal through the data facade", async () => {
    const data = availabilityResource({ materialized: true, revision: 9, state: "ready" });
    mocks.availability.mockResolvedValue(data);

    function Harness() {
      useFieldAvailabilityResource({
        enabled: false,
        owner_object_id: " object:1 ",
        quantityId: " h_demag ",
        scope_id: " layer 1 ",
        scope_kind: " AIRBOX ",
        target_id: " target/one ",
      });
      return null;
    }

    renderToStaticMarkup(<Harness />);

    const options = mocks.useResource.mock.calls[0]?.[0] as {
      enabled: boolean;
      load: (context: { signal: AbortSignal }) => Promise<FieldAvailabilityResource | null>;
      resolveRevision: (value: FieldAvailabilityResource | null) => ResourceRevision | null;
      resourceKey: string;
    };
    const controller = new AbortController();

    expect(options.enabled).toBe(false);
    expect(options.resourceKey).toBe(
      resolveFieldAvailabilityResourceKey("H_demag", {
        owner_object_id: "object:1",
        scope_id: "layer 1",
        scope_kind: "airbox",
        target_id: "target/one",
      }),
    );
    await expect(options.load({ signal: controller.signal })).resolves.toBe(data);
    expect(mocks.availability).toHaveBeenCalledWith(
      "H_demag",
      {
        owner_object_id: "object:1",
        scope_id: "layer 1",
        scope_kind: "airbox",
        target_id: "target/one",
      },
      { signal: controller.signal },
    );
    expect(options.resolveRevision(data)).toBe(9);
  });
});

import { describe, expect, it, vi } from "vitest";

const useDomainResourceMock = vi.fn();

vi.mock("../useDomainResource", () => ({
  useDomainResource: (...args: unknown[]) => useDomainResourceMock(...args),
}));

import { useTopology } from "../useTopology";

describe("useTopology", () => {
  it("adapts domain resource to topology alias", () => {
    const adapter = { discretization: "fem" };
    useDomainResourceMock.mockReturnValue({
      adapter,
      loading: false,
      error: null,
    });

    const result = useTopology(17);

    expect(useDomainResourceMock).toHaveBeenCalledWith(17);
    expect(result.topology).toEqual(adapter);
    expect(result.loading).toBe(false);
    expect(result.error).toBeNull();
  });
});

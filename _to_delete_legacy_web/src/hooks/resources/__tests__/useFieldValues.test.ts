import { describe, expect, it, vi } from "vitest";

const useFieldVectorMock = vi.fn();

vi.mock("../useFieldVector", () => ({
  useFieldVector: (...args: unknown[]) => useFieldVectorMock(...args),
}));

import { useFieldValues } from "../useFieldValues";

describe("useFieldValues", () => {
  it("enforces explicit component and forwards to useFieldVector", () => {
    const vector = { nComp: 1, values: new Float64Array([1, 2, 3]) };
    useFieldVectorMock.mockReturnValue({
      field: vector,
      loading: true,
      error: null,
    });

    const result = useFieldValues("m", 5, {
      component: "x",
      domainGenerationId: 42,
    });

    expect(useFieldVectorMock).toHaveBeenCalledWith("m", 5, {
      component: "x",
      domainGenerationId: 42,
    });
    expect(result.values).toEqual(vector);
    expect(result.loading).toBe(true);
    expect(result.error).toBeNull();
  });
});

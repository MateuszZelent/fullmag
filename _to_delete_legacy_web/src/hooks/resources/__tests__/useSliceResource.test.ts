import { describe, expect, it, vi } from "vitest";

const useFieldSlice2DMock = vi.fn();

vi.mock("../useFieldSlice2D", () => ({
  useFieldSlice2D: (...args: unknown[]) => useFieldSlice2DMock(...args),
}));

import { useSliceResource } from "../useSliceResource";

describe("useSliceResource", () => {
  it("maps arrows to vectors while preserving other fields", () => {
    const payload = {
      meta: { quantity_id: "m" },
      scalar: { values: new Float64Array([1, 2]) },
      arrows: { values: new Float64Array([0.1, 0.2]), arrowCount: 1 },
      loading: false,
      error: null,
    };
    useFieldSlice2DMock.mockReturnValue(payload);

    const result = useSliceResource("m", 11, 7, { plane: "xy" });

    expect(useFieldSlice2DMock).toHaveBeenCalledWith("m", 11, 7, {
      plane: "xy",
    });
    expect(result.meta).toEqual(payload.meta);
    expect(result.scalar).toEqual(payload.scalar);
    expect(result.arrows).toEqual(payload.arrows);
    expect(result.vectors).toEqual(payload.arrows);
    expect(result.loading).toBe(false);
    expect(result.error).toBeNull();
  });
});

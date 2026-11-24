import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MaterializedDatasetResource } from "../api/apiTypes";
import { useSavedAntennaSourceContextResources } from "./savedAntennaSourceContextResources";

const observed = vi.hoisted(() => ({ refetch: vi.fn(), enabled: false, key: "" }));
vi.mock("../KernelContext", () => ({
  useKernel: () => ({ api: { persistence: { projects: {} } } }),
}));
vi.mock("./useResource", () => ({
  useResource: (options: { enabled: boolean; resourceKey: string }) => {
    observed.enabled = options.enabled;
    observed.key = options.resourceKey;
    return {
      data: { status: "unavailable", reason: "Source provenance was unavailable." },
      error: null, status: "ready", revision: null, refetch: observed.refetch,
    };
  },
}));

function field(quantity = "H_ant"): MaterializedDatasetResource {
  return {
    integrity: "verified", project_id: "project-a", run_id: "run-a",
    field: {
      producer_id: "fullmag.closed-loop-inspection", producer_version: "2",
      accepted_state: null, coverage: { component_count: "3" },
      descriptor: {
        quantity_id: quantity, unit: "A/m", value_representation: "physical_field",
        normalization: "none", complex_encoding: "real", sample_location: "node",
      },
    },
  } as unknown as MaterializedDatasetResource;
}

function inspect(dataset: MaterializedDatasetResource | null, enabled = true) {
  const results: ReturnType<typeof useSavedAntennaSourceContextResources>[] = [];
  function Probe() {
    results.push(useSavedAntennaSourceContextResources(dataset, enabled));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return results[0]!;
}

describe("saved antenna source retry scope", () => {
  beforeEach(() => { observed.refetch.mockClear(); });

  it("allows an explicit resource refetch after unavailable provenance without accepting it", () => {
    const context = inspect(field());
    expect(context.status).toBe("unavailable");
    expect(observed.enabled).toBe(true);
    context.refetch?.();
    expect(observed.refetch).toHaveBeenCalledTimes(1);
    expect(context.status).toBe("unavailable");
  });

  it.each([field("m"), field("V_electric"), null])("offers no antenna retry for an unrelated or absent field", (dataset) => {
    expect(inspect(dataset).refetch).toBeNull();
    expect(observed.enabled).toBe(false);
    expect(observed.refetch).not.toHaveBeenCalled();
  });

  it("offers no retry for an inactive saved selection", () => {
    expect(inspect(field(), false).refetch).toBeNull();
    expect(observed.enabled).toBe(false);
  });

  it("keys the resource by the pinned run rather than the live selection", () => {
    const a = field(); inspect(a); const first = observed.key;
    inspect({ ...a, run_id: "run-b" });
    expect(observed.key).not.toBe(first);
    expect(observed.key).toContain("run-b");
  });
});

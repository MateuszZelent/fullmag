import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSimulationPreparationTestDom } from "../layout/simulationPreparationTestDom.test-support";
import { useMaterialLibraryResource } from "./materialLibraryResources";

const mocks = vi.hoisted(() => {
  const listMaterials = vi.fn();
  return {
  loadCatalog: listMaterials, api: { workspace: { listMaterials } }, refetch: vi.fn(), options: null as Record<string, unknown> | null,
  data: null as { revision: number; entries: unknown[] } | null,
};
});
vi.mock("../KernelContext", () => ({ useKernel: () => ({ api: mocks.api }) }));
vi.mock("./useResource", () => ({ useResource: (options: Record<string, unknown>) => {
  mocks.options = options;
  return { data: mocks.data, status: mocks.data ? "ready" : "loading", error: null, refetch: mocks.refetch, revision: mocks.data?.revision ?? null };
} }));

beforeEach(() => { mocks.data = null; mocks.options = null; mocks.loadCatalog.mockReset(); mocks.refetch.mockReset(); });
function Probe({ enabled }: { enabled: boolean }) { useMaterialLibraryResource({ enabled }); return null; }

async function mount(enabled = true) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div"); dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const render = async (value: boolean) => { await act(async () => root.render(<Probe enabled={value} />)); };
  await render(enabled);
  return { render, dispose: async () => { await act(async () => root.unmount()); dom.restore(); } };
}

describe("material library resource lifetime", () => {
  it("loads through the central catalog facade without a project/session scope", async () => {
    const mounted = await mount();
    try {
      expect(mocks.options).toMatchObject({ enabled: true, resourceKey: "/v2/workspace/material-library" });
      const signal = new AbortController().signal;
      await (mocks.options!.load as (context: { signal: AbortSignal }) => Promise<unknown>)({ signal });
      expect(mocks.loadCatalog).toHaveBeenCalledWith({ signal });
      expect(mocks.refetch).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });

  it("refreshes a cached catalog on opening and reopening, retaining project-independent identity", async () => {
    mocks.data = { revision: 4, entries: [] };
    const mounted = await mount(false);
    try {
      expect(mocks.refetch).not.toHaveBeenCalled();
      await mounted.render(true);
      expect(mocks.refetch).toHaveBeenCalledTimes(1);
      await mounted.render(true);
      expect(mocks.refetch).toHaveBeenCalledTimes(1);
      await mounted.render(false);
      await mounted.render(true);
      expect(mocks.refetch).toHaveBeenCalledTimes(2);
      expect(mocks.options!.resourceKey).toBe("/v2/workspace/material-library");
    } finally { await mounted.dispose(); }
  });
});

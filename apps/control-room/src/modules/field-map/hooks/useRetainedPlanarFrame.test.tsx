import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { useRetainedPlanarFrame } from "./useRetainedPlanarFrame";

describe("mounted planar frame retention", () => {
  it("preserves the renderer during refresh, bounds renders, and rejects another epoch", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    let renders = 0;
    function Surface({ identity, value }: { identity: string | null; value: number | null }) {
      renders++;
      // Deliberately use a new model on every render to catch publication loops.
      const model = useRetainedPlanarFrame(identity, value === null ? null : { value });
      return model ? <output>{model.value}</output> : <span>loading</span>;
    }
    try {
      await act(async () => root.render(<Surface identity="A:1" value={1} />));
      const renderer = container.firstChild;
      await act(async () => root.render(<Surface identity="A:1" value={null} />));
      expect(container.firstChild).toBe(renderer);
      expect(container.textContent).toBe("1");
      await act(async () => root.render(<Surface identity="A:1" value={2} />));
      expect(container.firstChild).toBe(renderer);
      expect(container.textContent).toBe("2");
      await act(async () => root.render(<Surface identity="A:2" value={null} />));
      expect(container.textContent).toBe("loading");
      await act(async () => root.render(<Surface identity={null} value={3} />));
      expect(container.textContent).toBe("loading");
      expect(renders).toBeLessThanOrEqual(5);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

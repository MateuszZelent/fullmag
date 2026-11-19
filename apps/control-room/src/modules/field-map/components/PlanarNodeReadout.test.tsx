import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { planarToolStore } from "@/kernel/visualization/planarToolStore";

import type { PlanarNodeProbeResult } from "../hooks/usePlanarNodeProbes";
import { PlanarNodeInspector, PlanarNodeReadout, planarNodeReadoutText } from "./PlanarNodeReadout";

vi.mock("@/kernel/resources/planarFieldResources", () => ({ usePlanarProbeLoader: () => null }));

const formatLength = (metres: number) => `${Number((metres * 1e9).toFixed(3))} nm`;
const formatPosition = (uv: { u_m: number; v_m: number }) => `y ${formatLength(uv.u_m)} · z ${formatLength(uv.v_m)}`;

const okResult: PlanarNodeProbeResult = {
  label: "film · m",
  layerId: "object:film",
  node: {
    in_plane_distance_m: 3.1e-10,
    kind: "fem_node",
    node_id: 18_204,
    normal_offset_m: 0,
    u_m: 1.24e-8,
    v_m: 0,
    vector: [0.969, 0.121, 0],
    world_m: [0, 1.24e-8, 0],
  },
  point: { scalar: null, vector: [0.97, 0.12, 0] },
  status: "ok",
  unit: "",
};

const render = (results: PlanarNodeProbeResult[], pinned = false) => renderToStaticMarkup(
  <PlanarNodeReadout
    anchor={{ left: 20, top: 20 }}
    formatLength={formatLength}
    formatPosition={formatPosition}
    pinned={pinned}
    results={results}
  />,
);

describe("PlanarNodeReadout", () => {
  afterEach(() => planarToolStore.reset());

  it("names the node, its coordinates, distance and a vector as three labelled components", () => {
    const html = render([okResult]);
    expect(html).toContain("film · m · node 18,204");
    expect(html).toContain("y 12.4 nm · z 0 nm");
    expect(html).toContain("<th scope=\"row\">In-plane distance</th><td>0.31 nm</td>");
    expect(html).toContain("<th scope=\"row\">x</th><td>0.969</td>");
    expect(html).toContain("<th scope=\"row\">y</th><td>0.121</td>");
    expect(html).toContain("<th scope=\"row\">z</th><td>0</td>");
    expect(html).not.toContain("(0.969");
    expect(html).not.toContain("Offset from plane");
  });

  it("shows the offset from the plane for an off-plane node and the unit of a scalar", () => {
    const html = render([{
      ...okResult,
      node: { ...okResult.node!, kind: "fdm_cell_center", normal_offset_m: 1e-9, scalar: 2.5, vector: null },
      unit: "kA/m",
    }]);
    expect(html).toContain("cell 18,204");
    expect(html).toContain("<th scope=\"row\">Offset from plane</th><td>1 nm</td>");
    expect(html).toContain("<td>2.5 kA/m</td>");
  });

  it("reports thickness averaging with the point value instead of a node", () => {
    const html = render([{
      ...okResult,
      node: null,
      point: { scalar: 1.5, vector: null },
      status: "unsupported_operator",
      unit: "T",
    }]);
    expect(html).toContain("Node unavailable for thickness averaging");
    expect(html).toContain("<th scope=\"row\">point value</th><td>1.5 T</td>");
    expect(html).not.toContain("node 18,204");
  });

  it("keeps the pinned table name and offers copy and close only when pinned", () => {
    expect(render([okResult])).not.toContain("Copy probe values");
    const pinned = renderToStaticMarkup(
      <PlanarNodeReadout anchor={{ left: 80, top: 80 }} formatLength={formatLength} formatPosition={formatPosition}
        pinned results={[]} onClose={() => undefined} />,
    );
    expect(pinned).toContain('aria-label="Pinned planar probe"');
    expect(pinned).toContain("No visible field layer at this point");
    expect(pinned).toContain("Copy probe values");
    expect(pinned).toContain("Close pinned probe");
    expect(pinned).toContain("fm-planar-node-readout--flip-x fm-planar-node-readout--flip-y");
  });

  it("copies the values as text and closes with the button or Escape", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const writeText = vi.fn(() => Promise.resolve());
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText } } });
    const onClose = vi.fn();
    try {
      await act(async () => {
        root.render(
          <PlanarNodeReadout anchor={{ left: 20, top: 20 }} formatLength={formatLength} formatPosition={formatPosition}
            pinned results={[okResult]} onClose={onClose} />,
        );
      });
      const button = (label: string) => findElement(container, (element) => element.getAttribute("aria-label") === label, label);
      await act(async () => { button("Copy probe values").dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(writeText).toHaveBeenCalledWith(planarNodeReadoutText([okResult], formatPosition, formatLength));
      await act(async () => { button("Close pinned probe").dispatchEvent(new TestEvent("click", { bubbles: true })); });
      const group = findElement(container, (element) => element.getAttribute("data-planar-node-readout") === "pinned", "readout");
      await act(async () => { group.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Escape" })); });
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      dom.restore();
    }
  });

  it("keeps a pinned readout after the tool changes and shows no hover card outside inspect", () => {
    planarToolStore.setActiveTool("measure");
    const html = renderToStaticMarkup(
      <PlanarNodeInspector formatLength={formatLength} formatPosition={formatPosition} layers={[]}
        pinned={{ u_m: 0.5, v_m: 0.5 }} viewport={[0, 1, 0, 1]} onClosePinned={() => undefined} />,
    );
    expect(html).toContain('aria-label="Pinned planar probe"');
    expect(html).not.toContain("Planar node readout");
  });
});
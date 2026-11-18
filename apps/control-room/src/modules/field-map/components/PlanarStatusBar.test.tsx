import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { planarToolStore } from "@/kernel/visualization/planarToolStore";

import { PlanarStatusBar, type PlanarStatusBarProps } from "./PlanarStatusBar";

interface SliderProps {
  "aria-label"?: string;
  disabled?: boolean;
  max?: number;
  value: number[];
  onValueChange: (value: number[]) => void;
  onValueCommit: (value: number[]) => void;
}

const mocks = vi.hoisted(() => ({ slider: null as SliderProps | null }));

// Radix pointer capture is not available in the test DOM; the contract under
// test is draft-on-change and commit-on-release.
vi.mock("@/shared/ui/Slider", () => ({
  Slider: (props: SliderProps) => {
    mocks.slider = props;
    return (
      <input
        aria-label={props["aria-label"]}
        disabled={props.disabled}
        max={props.max}
        readOnly
        type="range"
        value={props.value[0]}
      />
    );
  },
}));

type Section = NonNullable<PlanarFieldMetaResource["section"]>;

const fdmSection = {
  cut_element_count: null,
  layer_count: 4,
  layer_index: 1,
  layer_spacing_m: 1e-9,
  layer_stops_m: [],
  navigation_step_kind: "fdm_cell",
  navigation_step_m: 1e-9,
  normal_axis: "z",
  normal_max_m: 4e-9,
  normal_min_m: 0,
  plane: "xy",
  requested_coordinate_m: 1.5e-9,
  requested_fraction: 0.5,
  resolved_coordinate_m: 1.5e-9,
  stops_kind: "fdm_cell_layers",
} as unknown as Section;

const femSection = {
  cut_element_count: 1699,
  layer_count: null,
  layer_index: null,
  layer_spacing_m: null,
  layer_stops_m: [],
  navigation_step_kind: "extent_fraction",
  navigation_step_m: 1e-11,
  normal_axis: "x",
  normal_max_m: 5e-9,
  normal_min_m: -5e-9,
  plane: "yz",
  requested_coordinate_m: 0,
  requested_fraction: 0.5,
  resolved_coordinate_m: 0,
  stops_kind: "continuous",
} as unknown as Section;

function props(overrides: Partial<PlanarStatusBarProps> = {}): PlanarStatusBarProps {
  return {
    crop: null,
    onClearCrop: vi.fn(),
    onPositionCommit: vi.fn(),
    onStep: vi.fn(),
    planeLabel: "XY",
    positionFraction: 0.5,
    section: fdmSection,
    zoom: 1,
    ...overrides,
  };
}

describe("PlanarStatusBar", () => {
  afterEach(() => {
    planarToolStore.reset();
    mocks.slider = null;
  });

  it("offers a discrete FDM layer slider with the snapped coordinate", () => {
    const html = renderToStaticMarkup(<PlanarStatusBar {...props()} />);
    expect(html).toContain('aria-label="Layer along z"');
    expect(html).toContain('max="3"');
    expect(html).toContain('value="1"');
    expect(html).toContain("z: 1.50 nm · layer 1 / 3");
    expect(html).toContain(">XY<");
    expect(html).toContain(">100%<");
  });

  it("captions the cut coordinate and element count of a FEM section", () => {
    const html = renderToStaticMarkup(
      <PlanarStatusBar {...props({ planeLabel: "YZ", section: femSection })} />,
    );
    expect(html).toContain('aria-label="Position along x"');
    expect(html).toContain("x: 0.00 nm · 1,699 el.");
  });

  it("describes the full-thickness average instead of a slider", () => {
    const html = renderToStaticMarkup(
      <PlanarStatusBar {...props({ operator: { kind: "slab_average", thickness_m: 8e-9 } })} />,
    );
    expect(html).toContain("Mean over Z · 4 layers");
    expect(html).not.toContain('type="range"');
  });

  it("uses the published Airbox bounds and FDM layer count", () => {
    const airbox = {
      ...fdmSection,
      layer_count: 26,
      layer_spacing_m: 2.5e-9,
      normal_max_m: 60e-9,
      normal_min_m: -5e-9,
      resolved_coordinate_m: 26.25e-9,
    } as Section;
    const html = renderToStaticMarkup(<PlanarStatusBar {...props({ section: airbox })} />);
    expect(html).toContain('max="25"');
    expect(html).toContain("z: 26.3 nm · layer 12 / 25");
  });

  it("shows a dash without a cursor and never the old No sample badge", () => {
    const html = renderToStaticMarkup(<PlanarStatusBar {...props()} />);
    expect(html).toMatch(/<output aria-label="Cursor position"[^>]*>—<\/output>/);
    expect(html).not.toContain("No sample");
  });

  it("commits a slider drag once on release and formats the live cursor", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onPositionCommit = vi.fn();
    try {
      await act(async () => root.render(
        <PlanarStatusBar
          {...props({ onPositionCommit })}
          formatCursor={(cursor) => `y ${cursor.u_m} · z ${cursor.v_m}`}
        />,
      ));
      await act(async () => mocks.slider!.onValueChange([2]));
      await act(async () => mocks.slider!.onValueChange([3]));
      expect(onPositionCommit).not.toHaveBeenCalled();
      expect(container.textContent).toContain("layer 3 / 3");

      await act(async () => mocks.slider!.onValueCommit([3]));
      expect(onPositionCommit).toHaveBeenCalledExactlyOnceWith(0.875);

      await act(async () => planarToolStore.setCursorUv({ u_m: 1, v_m: 2 }));
      expect(container.textContent).toContain("y 1 · z 2");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows the crop chip only with a crop and clears it from its button", async () => {
    expect(renderToStaticMarkup(<PlanarStatusBar {...props()} />)).not.toContain("data-planar-crop");
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onClearCrop = vi.fn();
    try {
      await act(async () => root.render(
        <PlanarStatusBar
          {...props({
            crop: { u_min_m: -25e-9, u_max_m: 25e-9, v_min_m: -30e-9, v_max_m: 30e-9 },
            onClearCrop,
          })}
        />,
      ));
      expect(container.textContent).toContain("u -25.0 nm…25.0 nm · v -30.0 nm…30.0 nm");
      const clear = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Clear crop",
        "clear crop button",
      );
      await act(async () => {
        clear.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(onClearCrop).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

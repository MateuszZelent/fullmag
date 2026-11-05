import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { FieldMapToolbar, type FieldMapToolbarQuantity } from "./FieldMapToolbar";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
const mocks = vi.hoisted(() => ({ selects: [] as { disabled?: boolean; value?: string; onValueChange: (value: string) => void }[] }));
vi.mock("@/shared/ui/Select", () => ({
  Select: (props: { children: ReactNode; disabled?: boolean; value?: string; onValueChange: (value: string) => void }) => {
    mocks.selects.push(props);
    return <div>{props.children}</div>;
  },
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, disabled, value }: { children: ReactNode; disabled?: boolean; value: string }) => <button data-value={value} disabled={disabled}>{children}</button>,
  SelectTrigger: ({ children, "aria-label": label }: { children: ReactNode; "aria-label"?: string }) => <button aria-label={label}>{children}</button>,
  SelectValue: () => null,
}));

const tensor: FieldMapToolbarQuantity = {
  components: 9, label: "Spin current", quantityId: "J_spin", unit: "A/m²", tensor: true,
  projections: [
    { value: "frobenius", label: "Frobenius norm" },
    { value: "spin_flow_z", label: "Flow vector, spin Z" },
  ],
};
function profile(component = "frobenius"): PlanarState {
  return { quantity_id: "J_spin", component, colormap: "viridis", range: { mode: "auto" },
    layers: { vectors: true, mesh: false }, view_scope: { kind: "monitor_target" } } as PlanarState;
}
function render(planar = profile(), quantities: FieldMapToolbarQuantity[] = [tensor]) {
  const onPatch = vi.fn();
  const html = renderToStaticMarkup(<FieldMapToolbar planar={planar} quantities={quantities} sectionStrip={null} onPatch={onPatch} />);
  return { html, onPatch };
}

describe("FieldMapToolbar tensor projection contract", () => {
  beforeEach(() => { mocks.selects.length = 0; });

  it("offers canonical tensor projections instead of Cartesian vector presets", () => {
    const { html, onPatch } = render();
    expect(html).toContain('aria-label="Tensor projection"');
    expect(html).not.toContain('aria-label="Component"');
    expect(html).toContain("Frobenius norm");
    mocks.selects[1].onValueChange("x");
    expect(onPatch).not.toHaveBeenCalled();
    mocks.selects[1].onValueChange("spin_flow_z");
    expect(onPatch).toHaveBeenCalledWith({ component: "spin_flow_z", colormap: "viridis" });
  });

  it("turns arrows off for a scalar tensor projection", () => {
    const { onPatch } = render(profile("spin_flow_z"));
    mocks.selects[1].onValueChange("frobenius");
    expect(onPatch).toHaveBeenCalledWith({ component: "frobenius", colormap: "viridis",
      layers: { vectors: false, mesh: false } });
  });

  it("chooses an allowed tensor projection when changing quantity", () => {
    const { onPatch } = render({ ...profile("x"), quantity_id: "H_oe" }, [
      { components: 3, label: "Oersted field", quantityId: "H_oe", unit: "A/m" }, tensor,
    ]);
    mocks.selects[0].onValueChange("J_spin");
    expect(onPatch).toHaveBeenCalledWith({ quantity_id: "J_spin", component: "frobenius", colormap: "viridis",
      layers: { vectors: false, mesh: false } });
  });

  it("does not invent projections while the catalog is absent or rejects them", () => {
    const { html, onPatch } = render(profile(), [{ ...tensor, projections: [] }]);
    expect(mocks.selects[1].disabled).toBe(true);
    expect(html).not.toContain('aria-label="Component"');
    mocks.selects[0].onValueChange("J_spin");
    mocks.selects[1].onValueChange("frobenius");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("patches only the selected canonical planar scope and retains an active extra scope item", () => {
    const planar = {
      ...profile("spin_flow_z"),
      source: { kind: "monitor", monitor_id: "monitor-1" },
      default_slice: {
        operator: { kind: "plane_sample" },
        plane: "yz",
        position_fraction: 0.25,
      },
      interaction: { pan_u_m: 1.5, pan_v_m: -0.25, zoom: 2 },
      view_scope: { kind: "mesh_part", scope_id: "part-7" },
    } as PlanarState;
    const { html, onPatch } = render(planar);
    const scope = mocks.selects.find((select) => select.value === "mesh_part");

    expect(html).toContain("Monitor target");
    expect(html).toContain("Universe / Airbox");
    expect(html).toContain("Current mesh part");
    expect(scope).toBeDefined();
    scope?.onValueChange("mesh_part");
    expect(onPatch).not.toHaveBeenCalled();

    scope?.onValueChange("airbox");
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ view_scope: { kind: "airbox" } });
    expect(onPatch.mock.calls[0]?.[0]).not.toHaveProperty("source");
    expect(onPatch.mock.calls[0]?.[0]).not.toHaveProperty("quantity_id");
  });
});

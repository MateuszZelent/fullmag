import { readFileSync } from "node:fs";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import { KernelContext } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { installSimulationPreparationTestDom, TestElement, TestEvent, TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { SpinInterfaceInspectorPanel } from "./SpinInterfaceInspector";

const known = { id: "nf", kind: "mixing_conductance", normal_side: { object_id: "stack", region_id: "n" }, ferromagnet_side: { object_id: "stack", region_id: "f" }, normal_to_ferromagnet: [0, 0, 1], g_up_Spm2: 1, g_down_Spm2: 2, g_r_Spm2: 3, g_i_Spm2: 4, spin_memory_loss: { formula_version: "sml_reservoir.fullmag.v2", g_n_Spm2: 1, g_f_Spm2: 2, g_lattice_Spm2: 3 }, formula_version: "magnetoelectronic.fullmag.v2", absorption: "full_absorption" };
const opaque = { id: "future", kind: "vendor.interface.v9", exact: { preserve: true } };

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  invalidateSpinAuthoringResources: vi.fn(),
  useSpinAuthoringGeometryResource: () => ({
    data: {
      revision: 4,
      objects: [{ id: "stack", name: "Stack", regions: [
        { region_id: "n", name: "Normal metal" },
        { region_id: "f", name: "Ferromagnet" },
      ] }],
      current_transports: [],
      spin_transports: [{ id: "spin", interfaces: [known, opaque] }],
    },
    error: null,
    revision: 4,
    status: "ready",
  }),
  useSpinInterfaceMeshEvidenceResource: () => ({ data: null, error: null, revision: null, status: "idle" }),
  SPIN_INTERFACES_RESOURCE_KEY: "interfaces",
  SPIN_TRANSPORTS_RESOURCE_KEY: "transports",
  useSpinInterfacesResource: () => ({ data: { scene_revision: 4, items: [
    { owner_spin_transport_id: "spin", interface_id: "nf", known: true, interface: known },
    { owner_spin_transport_id: "spin", interface_id: "future", known: false, interface: opaque },
  ] }, status: "ready" }),
  useSpinTransportsResource: () => ({ data: { scene_revision: 4, items: [{ id: "spin", interfaces: [known, opaque] }] }, status: "ready" }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({ requestScopeEpoch: "1", sessionEpoch: "1", sessionId: "test-session" }),
  useSessionStatusSelector: (selector: (value: unknown) => unknown) => selector({
    data: {
      capabilities: {
        transport_authoring: {
          m1_one_way_steady: { authoring_allowed: true, reason: "M1", status: "semantic_only" },
        },
      },
    },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return { ...original, publishCommittedSceneResource: vi.fn() };
});

const validateTransport = vi.fn();
const replaceSpinTransport = vi.fn();
const kernel = {
  api: { model: { replaceSpinTransport, validateTransport } },
  resources: { invalidate: vi.fn() },
  commands: { getSessionScopeKey: () => "session=test-session&epoch=1&request_scope_epoch=1" },
} as unknown as KernelApi;
function selection(index: number, id: string): Selection { return { kind: "physics.spin-interface", label: id, moduleSource: "explorer", nodeId: id, objectId: null, ref: { kind: "physics.spin-interface", nodeId: id, spinInterfaceId: id, spinInterfaceIndex: index, spinInterfaceOwnerId: "spin", type: "spin-interface" } }; }

describe("SpinInterfaceInspectorPanel", () => {
  it("records interface create and replace through the shared authoring history boundary", () => {
    const source = readFileSync(
      new URL("./SpinInterfaceInspector.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const commit = action === \"delete\"");
    expect(source).toContain("captureAuthoringMutationFence(");
    expect(source).toContain("validateTransport(validationRequest(), { sessionScopeKey })");
    expect(source).toContain("authoringWriteOptions(null, mutationContext.sessionScopeKey)");
    expect(source).toContain("}, requestOptions);");
    expect(source).toContain("mutationContext.isCurrentSessionScope?.() !== true");
    expect(source).toContain("${selected ? \"Replace\" : \"Create\"} spin interface");
    expect(source).toContain("baseRevision ?? transports.data!.scene_revision");
    expect(source).toContain("api.model.replaceSpinTransport(ownerId");
  });

  it("keeps a new interface draft fail-closed until an owner is selected", () => {
    validateTransport.mockClear();
    replaceSpinTransport.mockClear();
    const draft: Selection = {
      kind: "physics.spin-interface",
      label: "New spin interface",
      moduleSource: "ribbon",
      nodeId: "model:physics:spin-interface:draft",
      objectId: null,
      ref: {
        draft: true,
        kind: "physics.spin-interface",
        nodeId: "model:physics:spin-interface:draft",
        type: "spin-interface",
      } as Selection["ref"],
    };
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinInterfaceInspectorPanel selection={draft} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Owning spin transport");
    expect(html).toContain("Owner: not selected");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create<\/button>/);
    expect(validateTransport).not.toHaveBeenCalled();
    expect(replaceSpinTransport).not.toHaveBeenCalled();
  });

  it("renders a known mixing interface as model-specific typed SI fields", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={selection(0, "nf")} /></KernelContext.Provider>);
    expect(html).toContain("Normal-metal scope");
    expect(html).toContain('value="[&quot;stack&quot;,&quot;n&quot;]" selected=""');
    expect(html).toContain('value="[&quot;stack&quot;,&quot;f&quot;]" selected=""');
    expect(html).toContain("Ferromagnet scope");
    expect(html).toContain("Oriented trace pair (normal metal");
    expect(html).toContain('value="" disabled="" selected=""');
    expect(html).toContain("Clear both trace bindings");
    expect(html).toContain("Geometry and mesh adjacency/orientation are NOT VERIFIED");
    expect(html).toContain("S/m²");
    expect(html).toContain("magnetoelectronic.fullmag.v2");
    expect(html).toContain("0, 0, 1");
  });


  it("binds both same-object region traces explicitly and preserves the panel and later coefficient edits through pending and ACK", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    validateTransport.mockResolvedValue({ semantic: { valid: true, issues: [] }, execution: { authoring_allowed: true, qualification: "semantic_only" } });
    let acknowledge: ((value: unknown) => void) | undefined;
    replaceSpinTransport.mockReset();
    replaceSpinTransport.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    try {
      await act(async () => root.render(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={selection(0, "nf")} /></KernelContext.Provider>));
      const panel = elements(container, (item) => (item.getAttribute("class") ?? "").split(" ").includes("fm-inspector-panel"))[0];
      const trace = control(container, "Oriented trace pair (normal metal → ferromagnet)");
      const coefficient = control(container, "g_r");
      expect(trace.value).toBe("");
      expect(container.textContent).toContain("Normal-metal trace: not bound");
      await act(async () => { trace.value = "x+"; trace.dispatchEvent(new TestEvent("change", { bubbles: true })); });
      expect(container.textContent).toContain("stack:x+; outward [1, 0, 0]");
      expect(container.textContent).toContain("stack:x-; outward [-1, 0, 0]");
      await act(async () => button(container, "Clear both trace bindings").click());
      expect(trace.value).toBe("");
      expect(control(container, "Normal-to-ferromagnet orientation").value).toBe("1, 0, 0");
      await act(async () => { trace.value = "y-"; trace.dispatchEvent(new TestEvent("change", { bubbles: true })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(180); });
      const replace = button(container, "Replace");
      expect(replace.disabled).toBe(false);
      panel.scrollTop = 127;
      coefficient.focus();
      await act(async () => { replace.click(); });
      expect(replaceSpinTransport).toHaveBeenCalledOnce();
      const submitted = replaceSpinTransport.mock.calls[0][1].resource;
      expect(submitted.interfaces[0]).toMatchObject({
        normal_side: { object_id: "stack", region_id: "n" },
        ferromagnet_side: { object_id: "stack", region_id: "f" },
        normal_to_ferromagnet: [0, -1, 0],
        normal_surface: { object_id: "stack", surface_id: "y-", orientation: [0, -1, 0] },
        ferromagnet_surface: { object_id: "stack", surface_id: "y+", orientation: [0, 1, 0] },
      });
      expect(replaceSpinTransport.mock.calls[0][2]).toMatchObject({ sessionScopeKey: "session=test-session&epoch=1&request_scope_epoch=1" });
      expect(coefficient.disabled).toBe(false);
      expect(trace.disabled).toBe(false);
      await act(async () => {
        Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(coefficient, "11");
        coefficient.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      expect(coefficient.value).toBe("11");
      expect(control(container, "g_r")).toBe(coefficient);
      expect(panel.scrollTop).toBe(127);
      expect(dom.document.activeElement).toBe(coefficient);
      await act(async () => {
        acknowledge?.({ scene_revision: 5, resource: submitted, committed_scene: { revision: 5, objects: [] } });
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Interface committed through its owning spin transport.");
      expect(control(container, "g_r")).toBe(coefficient);
      expect(coefficient.value).toBe("11");
      expect(control(container, "Oriented trace pair (normal metal → ferromagnet)")).toBe(trace);
      expect(trace.value).toBe("y-");
      expect(elements(container, (item) => (item.getAttribute("class") ?? "").split(" ").includes("fm-inspector-panel"))[0]).toBe(panel);
      expect(panel.scrollTop).toBe(127);
      expect(dom.document.activeElement).toBe(coefficient);
      expect(elements(panel, (item) => Boolean(item.style.opacity))).toEqual([]);
      expect(container.textContent).toContain("Mesh adjacency/orientation NOT VERIFIED");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      vi.useRealTimers();
    }
  });

  it("resolves a graph-routed interface by stable owner and interface ids", () => {
    const graphSelection: Selection = {
      kind: "physics.spin-interface",
      label: "nf",
      moduleSource: "explorer",
      nodeId: "graph:nf",
      objectId: null,
      ref: {
        kind: "physics.spin-interface",
        nodeId: "graph:nf",
        spinInterfaceId: "nf",
        spinInterfaceOwnerId: "spin",
        type: "spin-interface",
      },
    };
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={graphSelection} /></KernelContext.Provider>);
    expect(html).toContain("magnetoelectronic.fullmag.v2");
    expect(html).toContain("Normal-metal scope");
    expect(html).toContain('value="[&quot;stack&quot;,&quot;n&quot;]" selected=""');
    expect(html).toContain('value="[&quot;stack&quot;,&quot;f&quot;]" selected=""');
  });

  it("renders an unknown interface losslessly without mutation controls", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={selection(1, "future")} /></KernelContext.Provider>);
    expect(html).toContain("vendor.interface.v9");
    expect(html).toContain("preserve");
    expect(html).toContain("read-only");
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
  });
});

function elements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
function control(root: TestNode, label: string): TestElement {
  const result = elements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!result) throw new Error("Missing control " + label);
  return result;
}
function button(root: TestNode, label: string): TestElement {
  const result = elements(root, (element) => element.tagName === "BUTTON" && element.textContent === label)[0];
  if (!result) throw new Error("Missing button " + label);
  return result;
}

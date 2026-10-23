import { act, Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom, TestElement, TestEvent, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { ModeCompositionLayer, ModeCompositionResource } from "@/kernel/visualization/ModeCompositionController";
import { InspectorEditSessionProvider } from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { ModeCompositionActiveInspectorPanel, ModeCompositionObjectInspectorPanel } from "./ModeCompositionInspectors";
import type { ModeCompositionInspectorDependencies } from "./modeCompositionInspectorTypes";

// Keep native change events and accessible labels while avoiding unrelated
// Radix portals and measurement in the lightweight test DOM.
vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children, disabled, onValueChange, value }: { children: ReactNode; disabled?: boolean; onValueChange: (value: string) => void; value: string }) => {
    const trigger = Children.toArray(children).find((child) => isValidElement<{ "aria-label"?: string }>(child) && child.props["aria-label"]);
    const label = isValidElement<{ "aria-label"?: string }>(trigger) ? trigger.props["aria-label"] : undefined;
    return <select aria-label={label} disabled={disabled} onChange={(event) => onValueChange(event.currentTarget.value)} value={value}>{children}</select>;
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
}));
vi.mock("@/shared/ui/Slider", () => ({ Slider: () => null }));
vi.mock("@/shared/ui/Switch", () => ({
  Switch: ({ "aria-label": label, checked, disabled, onCheckedChange }: { "aria-label": string; checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void }) => (
    <button aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onCheckedChange(!checked)} role="switch" type="button">{label}</button>
  ),
}));

describe("mode composition mutation ownership", () => {
  it("assigns the selected sample and complete mode identity while retaining the existing layer appearance", async () => {
    const harness = await mountEditor();
    try {
      await harness.select("Mode sample", "sample-2");
      await harness.select("Mode selection", "mode-3");
      await harness.click("Enable mode layer");
      expect(harness.assign).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        appearance: harness.original.appearance,
        animation: harness.original.animation,
        component: harness.original.component,
        field_id: "field-3",
        mode: { artifact_revision: "artifact-1", run_id: "run-1", stage_id: "stage-1", sample_id: "sample-2", mode_id: "mode-3", raw_mode_index: 3, branch_id: "branch-3" },
      }));
    } finally { await harness.dispose(); }
  });

  it("retains selection on revision ACK but resets it on target and dataset changes", async () => {
    const harness = await mountEditor();
    try {
      await harness.select("Mode sample", "sample-2");
      await harness.select("Mode selection", "mode-3");
      harness.resource.revision += 1;
      await harness.render();
      expect(harness.control("Mode selection").value).toBe("mode-3");
      await harness.render("reference");
      expect(harness.control("Mode sample").value).toBe("sample-1");
      expect(harness.control("Mode selection").value).toBe("mode-1");
      await harness.select("Mode sample", "sample-2");
      harness.resource.artifact_revision = "artifact-2";
      await harness.render("reference");
      expect(harness.control("Mode sample").value).toBe("sample-1");
    } finally { await harness.dispose(); }
  });

  it("keeps raw rate text through revision updates, commits zero and does not submit invalid rates", async () => {
    const harness = await mountEditor();
    try {
      for (const raw of ["", "-", "1e-", "-1", "Infinity"]) {
        await harness.editRate(raw);
        await harness.blurRate();
        expect(harness.control("Animation rate (Hz)").value).toBe(raw);
        expect(harness.update).not.toHaveBeenCalled();
      }
      await harness.editRate("12.");
      harness.resource.revision += 1;
      await harness.render();
      expect(harness.control("Animation rate (Hz)").value).toBe("12.");
      expect(harness.update).not.toHaveBeenCalled();
      await harness.blurRate();
      expect(harness.update).toHaveBeenLastCalledWith(expect.objectContaining({ animation: expect.objectContaining({ rate_hz: 12 }) }));
      await harness.render();
      await harness.editRate("0");
      await harness.enterRate();
      expect(harness.update).toHaveBeenLastCalledWith(expect.objectContaining({ animation: expect.objectContaining({ rate_hz: 0 }) }));
    } finally { await harness.dispose(); }
  });

  it("merges a rate commit with the latest optimistic appearance instead of an earlier render", async () => {
    const harness = await mountEditor();
    try {
      await harness.editRate("2");
      const current = harness.resource.layers[0]!;
      harness.resource.layers = [{ ...current, appearance: { ...current.appearance, opacity: 0.25 } }];
      await harness.blurRate();
      expect(harness.update).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: expect.objectContaining({ opacity: 0.25 }), animation: expect.objectContaining({ rate_hz: 2 }) }));
    } finally { await harness.dispose(); }
  });

  it("shows rejection feedback and suppresses old feedback after target A to B to A", async () => {
    const harness = await mountEditor();
    try {
      harness.assign.mockRejectedValueOnce(new Error("Published rejection"));
      await harness.click("Enable mode layer");
      expect(harness.container.textContent).toContain("Published rejection");
      const acknowledgement = deferred<ModeCompositionResource>();
      harness.assign.mockReturnValueOnce(acknowledgement.promise);
      await harness.click("Enable mode layer");
      await harness.render("reference");
      await harness.render("film");
      await act(async () => { acknowledgement.reject(new Error("Old owner rejection")); await Promise.resolve(); });
      expect(harness.container.textContent).not.toContain("Old owner rejection");
      expect(harness.container.textContent).not.toContain("Published rejection");
    } finally { await harness.dispose(); }
  });

  it("handles global action rejection visibly without an unhandled Promise", async () => {
    const harness = await mountEditor(true);
    try {
      harness.mutate.mockRejectedValueOnce(new Error("Cannot clear composition"));
      await harness.click("Clear composition");
      expect(harness.container.textContent).toContain("Cannot clear composition");
      harness.mutate.mockRejectedValueOnce(new Error("Cannot hide layers"));
      await harness.click("Hide all modal layers");
      expect(harness.container.textContent).toContain("Cannot hide layers");
      harness.clock.mockRejectedValueOnce(new Error("Cannot synchronize phase clock"));
      await harness.click("Synchronize mode composition phase clock");
      expect(harness.container.textContent).toContain("Cannot synchronize phase clock");
    } finally { await harness.dispose(); }
  });

  it.each(["before", "after"] as const)(
    "keeps the latest same-owner result when an older operation rejects %s its success",
    async (rejectionOrder) => {
      const harness = await mountEditor();
      const oldOperation = deferred<ModeCompositionResource>();
      const newOperation = deferred<ModeCompositionResource>();
      try {
        harness.assign.mockReturnValueOnce(oldOperation.promise).mockReturnValueOnce(newOperation.promise);
        await harness.click("Enable mode layer");
        await harness.select("Mode sample", "sample-2");
        await harness.click("Enable mode layer");
        expect(harness.assign).toHaveBeenCalledTimes(2);
        expect(harness.assign.mock.calls[0]?.[0].mode.mode_id).toBe("mode-1");
        expect(harness.assign.mock.calls[1]?.[0].mode.mode_id).toBe("mode-2");
        expect(harness.container.textContent).toContain("Updating mode composition…");

        if (rejectionOrder === "before") {
          await act(async () => {
            oldOperation.reject(new Error("Older overlapping operation failed"));
            await Promise.resolve();
          });
          expect(harness.container.textContent).not.toContain("Older overlapping operation failed");
          expect(harness.container.textContent).toContain("Updating mode composition…");
        }

        await act(async () => {
          newOperation.resolve(harness.resource);
          await Promise.resolve();
        });
        expect(harness.container.textContent).toContain("Mode composition updated.");
        expect(harness.container.textContent).not.toContain("Updating mode composition…");

        if (rejectionOrder === "after") {
          await act(async () => {
            oldOperation.reject(new Error("Older overlapping operation failed"));
            await Promise.resolve();
          });
        }

        expect(harness.container.textContent).toContain("Mode composition updated.");
        expect(harness.container.textContent).not.toContain("Older overlapping operation failed");
        expect(() => find(harness.container, (element) => element.getAttribute("role") === "alert")).toThrow("Missing mode composition control");
      } finally { await harness.dispose(); }
    },
  );

  it("preserves a newer raw rate and ignores an old ACK after session A to B to A", async () => {
    const harness = await mountEditor();
    try {
      const acknowledgement = deferred<ModeCompositionResource>();
      harness.assign.mockReturnValueOnce(acknowledgement.promise);
      await harness.click("Enable mode layer");
      await harness.changeSession("session=B&epoch=1");
      await harness.changeSession("session=A&epoch=1");
      await harness.editRate("-");
      await act(async () => { acknowledgement.resolve(harness.resource); await Promise.resolve(); });
      expect(harness.control("Animation rate (Hz)").value).toBe("-");
      expect(harness.container.textContent).not.toContain("Mode composition updated.");
    } finally { await harness.dispose(); }
  });
});

async function mountEditor(active = false) {
  const dom = installSimulationPreparationTestDom();
  Object.assign(dom.document.defaultView!, { getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }) });
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  const original = testLayer("film");
  const resource: ModeCompositionResource = {
    artifact_revision: "artifact-1", composition_id: "composition-1", layers: [original, testLayer("reference")],
    lifecycle: { artifact_revision: 1, mesh_revision: 2, run_id: "run-1", session_id: "session-1" },
    phase_clock: { master_rate_hz: 1, synchronized: true }, revision: 1, run_id: "run-1", schema_version: "mode-composition.v1", stage_id: "stage-1",
  };
  const assign = vi.fn(async (_layer: ModeCompositionLayer) => resource);
  const update = vi.fn(async (layer: ModeCompositionLayer) => {
    resource.layers = resource.layers.map((current) => current.target_id === layer.target_id ? layer : current);
    return resource;
  });
  const mutate = vi.fn(async () => resource);
  const clock = vi.fn(async () => resource);
  let dependencies: ModeCompositionInspectorDependencies = {
    sessionScopeKey: "session=A&epoch=1",
    controller: { assign, updateLayer: update, mutate, remove: vi.fn(async () => resource), setPhaseClock: clock, getSnapshot: () => ({ resource, error: null, pending_target_ids: [], status: "ready" }) },
    compatibleObjects: ["film", "reference"].map((objectId) => ({ objectId, label: objectId, targetId: `object:${objectId}` as const })),
    resource,
    spectrum: { samples: [
      { sampleId: "sample-1", label: "First sample", modes: [{ modeId: "mode-1", fieldId: "field-1", frequencyHz: 1e9, rawModeIndex: 1 }] },
      { sampleId: "sample-2", label: "Second sample", modes: [{ modeId: "mode-2", fieldId: "field-2", frequencyHz: 2e9, rawModeIndex: 2 }, { modeId: "mode-3", fieldId: "field-3", frequencyHz: 3e9, rawModeIndex: 3, branchId: "branch-3" }] },
    ] },
  };
  const render = async (objectId = "film") => act(async () => root.render(
    <InspectorEditSessionProvider>
      {active ? <ModeCompositionActiveInspectorPanel dependencies={dependencies} selection={selection(objectId)} /> : <ModeCompositionObjectInspectorPanel dependencies={dependencies} selection={selection(objectId)} />}
    </InspectorEditSessionProvider>,
  ));
  await render();
  const control = (label: string) => find(container, (element) => element.getAttribute("aria-label") === label);
  const editRate = async (value: string) => act(async () => {
    const input = control("Animation rate (Hz)");
    input.value = value;
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
  return {
    assign, update, mutate, clock, original, resource, container, control, render, editRate,
    changeSession: async (sessionScopeKey: string) => { dependencies = { ...dependencies, sessionScopeKey }; await render(); },
    select: async (label: string, value: string) => act(async () => { const input = control(label); input.value = value; input.dispatchEvent(new TestEvent("change", { bubbles: true })); }),
    click: async (text: string) => act(async () => { find(container, (element) => element.tagName === "BUTTON" && element.textContent.includes(text)).click(); await Promise.resolve(); }),
    blurRate: async () => act(async () => control("Animation rate (Hz)").dispatchEvent(new TestEvent("focusout", { bubbles: true }))),
    enterRate: async () => act(async () => {
      const input = control("Animation rate (Hz)");
      Object.assign(input, { attachEvent: () => undefined, detachEvent: () => undefined });
      input.focus(); input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      input.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
    }),
    dispose: async () => {
      await act(async () => { dom.document.activeElement?.dispatchEvent(new TestEvent("focusout", { bubbles: true })); root.unmount(); });
      dom.restore();
    },
  };
}

function testLayer(objectId: string): ModeCompositionLayer {
  return {
    amplitude_scale: 1, animation: { enabled: false, phase_offset_rad: 0.2, rate_hz: 1, synchronized: true },
    appearance: { auto_range: true, colorbar_visible: true, colormap: "coolwarm", opacity: 0.8, symmetric_zero: true, vector_budget: 512, vector_length_scale: 1, vectors_visible: false },
    component: "x", enabled: true, field_id: "field-1", layer_id: `mode-layer:${objectId}`,
    mode: { artifact_revision: "artifact-1", run_id: "run-1", stage_id: "stage-1", sample_id: "sample-1", mode_id: "mode-1", raw_mode_index: 1 },
    normalization: "mode_global_max", object_id: objectId, phase_rad: 0, representation: "phase_rotated_real", target_id: `object:${objectId}`,
  };
}
function selection(objectId: string): InspectorPanelProps["selection"] {
  const nodeId = `results:composition-1:object:${objectId}`;
  return { kind: "results.eigen.composition.object", label: objectId, nodeId, objectId, ref: { compositionId: "composition-1", compositionRevision: "1", kind: "results.eigen.composition.object", nodeId, objectId, targetId: `object:${objectId}`, type: "mode-composition-object" } };
}
function find(root: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  if (root instanceof TestElement && predicate(root)) return root;
  for (const child of root.childNodes) { try { return find(child, predicate); } catch { /* Search the next subtree. */ } }
  throw new Error("Missing mode composition control");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, reject, resolve };
}

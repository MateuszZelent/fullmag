import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { viewport3dStore } from "../viewport3dStore";

vi.mock("@/shared/ui/Slider", () => ({
  Slider: ({
    "aria-labelledby": ariaLabelledBy,
    disabled,
    id,
    max,
    min,
    onValueChange,
    step,
    value,
  }: {
    "aria-labelledby"?: string;
    disabled?: boolean;
    id?: string;
    max: number;
    min: number;
    onValueChange: (values: number[]) => void;
    step: number;
    value: number[];
  }) => (
    <input
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      id={id}
      max={max}
      min={min}
      onChange={(event) => onValueChange([event.currentTarget.valueAsNumber])}
      step={step}
      type="range"
      value={value[0] ?? min}
    />
  ),
}));
import {
  Viewport3DSettingsContent,
  type Viewport3DSettingsSection,
} from "./Viewport3DSettingsContent";

function elementsByRole(container: TestElement, role: string): TestElement[] {
  return findElements(container, (element) => element.getAttribute("role") === role);
}

function elementById(container: TestElement, id: string): TestElement {
  return findElement(container, (element) => element.getAttribute("id") === id, id);
}

async function mountContent(activeSection: Viewport3DSettingsSection) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const onSectionChange = vi.fn();
  const onCommand = vi.fn();

  await act(async () => {
    root.render(
      <Viewport3DSettingsContent
        activeSection={activeSection}
        cameraContent={<p>Camera editor content</p>}
        onCommand={onCommand}
        onSectionChange={onSectionChange}
      />,
    );
  });

  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
    container,
    onCommand,
    onSectionChange,
  };
}

async function dispatchInput(element: TestElement, value: string) {
  element.value = value;
  await act(async () => {
    element.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

describe("Viewport3DSettingsContent", () => {
  beforeEach(() => viewport3dStore.resetForTest());
  afterEach(() => viewport3dStore.resetForTest());

  it("renders four short sections inline and keeps the injected camera editor in View", () => {
    const html = renderToStaticMarkup(
      <Viewport3DSettingsContent
        activeSection="view"
        cameraContent={<p>Camera editor content</p>}
        onCommand={() => undefined}
        onSectionChange={() => undefined}
      />,
    );
    const tabs = Array.from(html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g), (match) => match[1]);

    expect(tabs).toEqual(["View", "Appearance", "Quality", "Export"]);
    expect(html).toContain('aria-label="3D View Settings"');
    expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(4);
    expect((html.match(/role="tabpanel"[^>]*hidden=""/g) ?? [])).toHaveLength(3);
    const viewPanelStart = html.indexOf('role="tabpanel"');
    const nextPanelStart = html.indexOf('role="tabpanel"', viewPanelStart + 1);
    expect(html.slice(viewPanelStart, nextPanelStart)).toContain("Camera editor content");
    expect(html).not.toContain('role="dialog"');
  });

  it("updates persisted view switches through the store", async () => {
    const view = await mountContent("view");
    try {
      const scaleLabels = findElement(
        view.container,
        (element) => element.getAttribute("role") === "switch" && element.getAttribute("aria-label") === "Scale labels",
        "Scale labels switch",
      );
      expect(scaleLabels.getAttribute("aria-checked")).toBe("true");
      await act(async () => scaleLabels.click());
      expect(viewport3dStore.getSnapshot().widgets.scaleLabelsVisible).toBe(false);
      expect(scaleLabels.getAttribute("aria-checked")).toBe("false");
    } finally {
      await view.cleanup();
    }
  });

  it("keeps a numeric draft while editing and rejects values outside the declared range", async () => {
    const appearance = await mountContent("appearance");
    try {
      const strength = elementById(appearance.container, "fm-view-background-strength-number");
      expect(strength.getAttribute("min")).toBe("0");
      expect(strength.getAttribute("max")).toBe("1");
      expect(strength.getAttribute("inputmode")).toBe("decimal");
      expect(
        findElements(appearance.container, (element) =>
          element.tagName === "LABEL" && element.textContent.includes("Gradient strength"),
        ),
      ).toHaveLength(1);

      strength.focus();
      await dispatchInput(strength, "-");
      expect(strength.value).toBe("-");
      expect(viewport3dStore.getSnapshot().appearance.backgroundStrength).toBe(0.65);

      await dispatchInput(strength, "0.9");
      expect(viewport3dStore.getSnapshot().appearance.backgroundStrength).toBe(0.65);
      await act(async () => {
        strength.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });
      expect(viewport3dStore.getSnapshot().appearance.backgroundStrength).toBe(0.9);

      strength.focus();
      await dispatchInput(strength, "1.2");
      expect(viewport3dStore.getSnapshot().appearance.backgroundStrength).toBe(0.9);
      await act(async () => {
        strength.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });
      expect(elementsByRole(appearance.container, "alert").map((entry) => entry.textContent).join(" "))
        .toContain("0 to 1");
    } finally {
      await appearance.cleanup();
    }
  });

  it("keeps presentation materials separate and reports protected post-processing as inactive", async () => {
    viewport3dStore.setAppearance({ renderMode: "presentation" });
    viewport3dStore.setEffectAmbientOcclusion(true);
    viewport3dStore.setEffectBloom(true);
    viewport3dStore.setPostProcessingDataProtection(true);

    const appearance = await mountContent("appearance");
    try {
      expect(elementById(appearance.container, "fm-view-roughness")).toBeDefined();
      expect(elementById(appearance.container, "fm-view-metalness")).toBeDefined();
      expect(appearance.container.textContent).toContain("Field colors stay faithful in both modes");
    } finally {
      await appearance.cleanup();
    }

    const quality = await mountContent("quality");
    try {
      expect(quality.container.textContent).toContain("Quantitative field colors are protected");
      expect(
        findElements(quality.container, (element) =>
          element.getAttribute("role") === "status" &&
          element.textContent.includes("Ambient occlusion") &&
          element.textContent.includes("inactive"),
        ),
      ).toHaveLength(1);
      const aoSwitch = findElement(
        quality.container,
        (element) => element.getAttribute("role") === "switch" && element.getAttribute("aria-label") === "Ambient occlusion",
        "Ambient occlusion switch",
      );
      expect(aoSwitch.getAttribute("aria-checked")).toBe("true");
    } finally {
      await quality.cleanup();
    }
  });

  it("routes only named section resets to existing commands and does not offer Reset quality", async () => {
    const view = await mountContent("view");
    try {
      const resetFrame = findElement(
        view.container,
        (element) => element.tagName === "BUTTON" && element.textContent === "Reset reference frame",
        "Reset reference frame",
      );
      await act(async () => resetFrame.click());
      expect(view.onCommand).toHaveBeenCalledWith("viewport-3d.reset-appearance-frame");
    } finally {
      await view.cleanup();
    }

    const appearance = await mountContent("appearance");
    try {
      const resetBackgrounds = findElement(
        appearance.container,
        (element) => element.tagName === "BUTTON" && element.textContent === "Reset backgrounds",
        "Reset backgrounds",
      );
      const resetLighting = findElement(
        appearance.container,
        (element) => element.tagName === "BUTTON" && element.textContent === "Reset lighting",
        "Reset lighting",
      );
      await act(async () => resetBackgrounds.click());
      await act(async () => resetLighting.click());
      expect(appearance.onCommand).toHaveBeenCalledWith("viewport-3d.reset-appearance-background");
      expect(appearance.onCommand).toHaveBeenCalledWith("viewport-3d.reset-appearance-lighting");
    } finally {
      await appearance.cleanup();
    }

    const quality = await mountContent("quality");
    try {
      expect(quality.container.textContent).not.toContain("Reset quality");
      expect(quality.container.textContent).not.toContain("Reset effects");
      expect(viewport3dStore.getSnapshot().visualProfileId).toBe("interactive");
    } finally {
      await quality.cleanup();
    }
  });

  it("exports through the existing capture command and exposes PNG options", async () => {
    const exported = await mountContent("export");
    try {
      expect(elementById(exported.container, "fm-view-export-background")).toBeDefined();
      expect(elementById(exported.container, "fm-view-export-scale")).toBeDefined();
      expect(elementById(exported.container, "fm-view-export-annotations")).toBeDefined();
      const exportButton = findElement(
        exported.container,
        (element) => element.tagName === "BUTTON" && element.textContent === "Export PNG",
        "Export PNG",
      );
      await act(async () => exportButton.click());
      expect(exported.onCommand).toHaveBeenCalledWith("viewport-3d.capture-frame");
    } finally {
      await exported.cleanup();
    }
  });
});

import { readFileSync } from "node:fs";

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
import { VIEWPORT_3D_QUALITY_PROFILE_OPTIONS } from "@/shared/viewport3dQualityLabels";

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

  const renderSection = async (section: Viewport3DSettingsSection) => {
    await act(async () => {
      root.render(
        <Viewport3DSettingsContent
          activeSection={section}
          cameraContent={<p>Camera editor content</p>}
          onCommand={onCommand}
          onSectionChange={onSectionChange}
        />,
      );
    });
  };

  await renderSection(activeSection);

  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
    container,
    onCommand,
    onSectionChange,
    renderSection,
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

  it("renders three view-settings sections inline and keeps the injected camera editor in View", () => {
    const html = renderToStaticMarkup(
      <Viewport3DSettingsContent
        activeSection="view"
        cameraContent={<p>Camera editor content</p>}
        onCommand={() => undefined}
        onSectionChange={() => undefined}
      />,
    );
    const tabs = Array.from(html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g), (match) => match[1]);

    expect(tabs).toEqual(["View", "Appearance", "Quality"]);
    expect(html).toContain('aria-label="3D View Settings"');
    expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(3);
    expect((html.match(/role="tabpanel"[^>]*hidden=""/g) ?? [])).toHaveLength(2);
    const viewPanelStart = html.indexOf('role="tabpanel"');
    const nextPanelStart = html.indexOf('role="tabpanel"', viewPanelStart + 1);
    expect(html.slice(viewPanelStart, nextPanelStart)).toContain("Camera editor content");
    expect(html).not.toContain('role="dialog"');
  });

  it("keeps Visualization mode above every tab and independent from the quality profile", async () => {
    const settings = await mountContent("view");
    try {
      const markup = settings.container.innerHTML;
      const groupIndex = markup.indexOf('aria-label="Visualization mode"');
      const tabsIndex = markup.indexOf('role="tablist"');
      expect(groupIndex).toBeGreaterThanOrEqual(0);
      expect(groupIndex).toBeLessThan(tabsIndex);
      expect(settings.container.textContent).toContain(
        "Scientific preserves exact field colors. Presentation shades field colors to reveal shape; use Scientific for quantitative color reading.",
      );

      const radios = findElements(
        settings.container,
        (element) => element.getAttribute("role") === "radio",
      );
      expect(radios.map((radio) => radio.textContent)).toEqual(["Scientific", "Presentation"]);
      expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
      expect(radios[0]?.getAttribute("tabindex")).toBe("0");
      expect(radios[1]?.getAttribute("tabindex")).toBe("-1");

      await act(async () => radios[1]?.click());
      expect(viewport3dStore.getSnapshot().appearance.renderMode).toBe("presentation");
      expect(viewport3dStore.getSnapshot().visualProfileId).toBe("interactive");
      expect(viewport3dStore.getSnapshot().widgets.effectAmbientOcclusion).toBe(true);

      await settings.renderSection("quality");
      const qualityRadios = findElements(
        settings.container,
        (element) => element.getAttribute("role") === "radio",
      );
      expect(qualityRadios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
      expect(settings.container.textContent).toContain("Quality profile");
      expect(settings.container.textContent).toContain("Quality controls render detail and GPU cost.");
      expect(VIEWPORT_3D_QUALITY_PROFILE_OPTIONS).toEqual([
        ["interactive-lite", "Fast"],
        ["interactive", "Standard"],
        ["balanced", "Detailed"],
        ["figure", "Figure"],
      ]);
      const qualityControl = elementById(settings.container, "fm-view-quality");
      const describedBy = qualityControl.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      expect(describedBy).toContain("fm-view-quality-help");
      expect(describedBy).toContain("fm-view-quality-description");
      expect(elementById(settings.container, "fm-view-quality-status").textContent)
        .toContain("Active quality: Standard.");

      await act(async () => viewport3dStore.setVisualProfile("figure"));
      expect(viewport3dStore.getSnapshot().visualProfileId).toBe("figure");
      expect(viewport3dStore.getSnapshot().appearance.renderMode).toBe("presentation");
      const figureDescription = elementById(settings.container, "fm-view-quality-description").textContent;
      expect(figureDescription).toMatch(/2× viewport resolution.*100% zoom/);
      expect(figureDescription).toMatch(/switching to Presentation.*Studio lighting.*soft shadows.*ambient occlusion/);
      expect(figureDescription).toMatch(/adjust.*GPU memory.*longer to render/i);
      expect(elementById(settings.container, "fm-view-quality-status").textContent)
        .toContain("Active quality: Figure.");
      await act(async () => viewport3dStore.requestCapture());
      expect(elementById(settings.container, "fm-view-quality-status").textContent)
        .toContain("Active quality: Figure. Exporting PNG.");
      await act(async () => viewport3dStore.completeCapture());
      await act(async () => viewport3dStore.setEffectAmbientOcclusion(false));
      const selectedPresentation = findElement(
        settings.container,
        (element) => element.getAttribute("role") === "radio" && element.textContent === "Presentation",
        "Presentation mode radio",
      );
      await act(async () => selectedPresentation.click());
      expect(viewport3dStore.getSnapshot().widgets.effectAmbientOcclusion).toBe(false);
      expect(
        findElements(settings.container, (element) =>
          element.getAttribute("role") === "radio" && element.getAttribute("aria-checked") === "true",
        ).map((radio) => radio.textContent),
      ).toEqual(["Presentation"]);

      for (const section of ["view", "appearance", "quality"] as const) {
        await settings.renderSection(section);
        expect(
          findElements(settings.container, (element) =>
            element.getAttribute("role") === "radiogroup" &&
            element.getAttribute("aria-label") === "Visualization mode",
          ),
        ).toHaveLength(1);
        const sectionMarkup = settings.container.innerHTML;
        expect(sectionMarkup.indexOf('aria-label="Visualization mode"')).toBeLessThan(
          sectionMarkup.indexOf('role="tablist"'),
        );
      }
    } finally {
      await settings.cleanup();
    }
  });

  it("supports keyboard mode selection through the shared radio group", async () => {
    const settings = await mountContent("quality");
    try {
      const scientific = findElement(
        settings.container,
        (element) => element.getAttribute("role") === "radio" && element.textContent === "Scientific",
        "Scientific mode radio",
      );
      const keyEvent = new TestEvent("keydown", { bubbles: true, key: "ArrowRight" });

      await act(async () => scientific.dispatchEvent(keyEvent));

      expect(keyEvent.defaultPrevented).toBe(true);
      expect(viewport3dStore.getSnapshot().appearance.renderMode).toBe("presentation");
      expect(
        findElement(
          settings.container,
          (element) => element.getAttribute("role") === "radio" && element.getAttribute("aria-checked") === "true",
          "Selected presentation mode radio",
        ).textContent,
      ).toBe("Presentation");
    } finally {
      await settings.cleanup();
    }
  });

  it("shows the retained profile during export and an explicit Capture profile honestly", async () => {
    const settings = await mountContent("quality");
    try {
      await act(async () => viewport3dStore.setVisualProfile("figure"));
      await act(async () => viewport3dStore.requestCapture());
      expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBe("figure");
      expect(elementById(settings.container, "fm-view-quality-status").textContent)
        .toBe("Active quality: Figure. Exporting PNG.");
      expect(elementById(settings.container, "fm-view-quality").textContent)
        .toContain("Figure");

      await act(async () => viewport3dStore.completeCapture());
      await act(async () => viewport3dStore.setVisualProfile("capture"));
      expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBeNull();
      expect(elementById(settings.container, "fm-view-quality-status").textContent)
        .toBe("Active quality: Capture.");
      expect(elementById(settings.container, "fm-view-quality-status").textContent)
        .not.toContain("Exporting PNG");
      expect(elementById(settings.container, "fm-view-quality").textContent)
        .toContain("Capture");
      expect(elementById(settings.container, "fm-view-quality-description").textContent)
        .toContain("image capture");
    } finally {
      await settings.cleanup();
    }
  });

  it("shows one shared mode control in Appearance and the legacy dialog", async () => {
    const appearance = await mountContent("appearance");
    const dialog = readFileSync(
      new URL("./Viewport3DSettingsDialog.tsx", import.meta.url),
      "utf8",
    );

    try {
      expect(
        findElements(appearance.container, (element) =>
          element.getAttribute("role") === "radiogroup" &&
          element.getAttribute("aria-label") === "Visualization mode",
        ),
      ).toHaveLength(1);
      expect(
        findElements(appearance.container, (element) => element.getAttribute("id") === "fm-view-render-mode"),
      ).toHaveLength(0);
      expect(dialog.match(/<Viewport3DVisualizationModeControl\s*\/>/g) ?? []).toHaveLength(1);
      expect(dialog).not.toContain("fm-view-render-mode");
      expect(dialog).toContain('label="Quality profile"');
      expect(dialog).toContain('describedBy="fm-view-quality-dialog-help fm-view-quality-dialog-description"');
    } finally {
      await appearance.cleanup();
    }
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

  it("keeps Presentation effects available and reports field protection in Scientific", async () => {
    viewport3dStore.setAppearance({ renderMode: "presentation" });
    viewport3dStore.setEffectAmbientOcclusion(true);
    viewport3dStore.setEffectBloom(true);
    viewport3dStore.setPostProcessingDataProtection(false);

    const appearance = await mountContent("appearance");
    try {
      expect(elementById(appearance.container, "fm-view-roughness")).toBeDefined();
      expect(elementById(appearance.container, "fm-view-metalness")).toBeDefined();
      expect(appearance.container.textContent).toContain(
        "Scientific preserves exact field colors. Presentation shades field colors to reveal shape; use Scientific for quantitative color reading.",
      );
    } finally {
      await appearance.cleanup();
    }

    const quality = await mountContent("quality");
    try {
      expect(quality.container.textContent).not.toContain("Quantitative field colors are protected");
      expect(
        findElements(quality.container, (element) =>
          element.getAttribute("role") === "status" &&
          element.textContent.includes("Ambient occlusion") &&
          element.textContent.includes("inactive"),
        ),
      ).toHaveLength(0);
      const aoSwitch = findElement(
        quality.container,
        (element) => element.getAttribute("role") === "switch" && element.getAttribute("aria-label") === "Ambient occlusion",
        "Ambient occlusion switch",
      );
      expect(aoSwitch.getAttribute("aria-checked")).toBe("true");
    } finally {
      await quality.cleanup();
    }

    viewport3dStore.setAppearance({ renderMode: "scientific" });
    viewport3dStore.setPostProcessingDataProtection(true);
    const scientificQuality = await mountContent("quality");
    try {
      expect(scientificQuality.container.textContent).toContain("Quantitative field colors are protected");
      expect(
        findElements(scientificQuality.container, (element) =>
          element.getAttribute("role") === "status" &&
          element.textContent.includes("Ambient occlusion") &&
          element.textContent.includes("inactive"),
        ),
      ).toHaveLength(1);
    } finally {
      await scientificQuality.cleanup();
    }
  });

  it("explains the field-color contract in both settings surfaces", async () => {
    const appearance = await mountContent("appearance");
    const dialog = readFileSync(
      new URL("./Viewport3DSettingsDialog.tsx", import.meta.url),
      "utf8",
    );
    const contentSource = readFileSync(
      new URL("./Viewport3DSettingsContent.tsx", import.meta.url),
      "utf8",
    );

    try {
      const explanation = "Scientific preserves exact field colors. Presentation shades field colors to reveal shape; use Scientific for quantitative color reading.";
      expect(appearance.container.textContent).toContain(explanation);
      expect(dialog).toContain("<Viewport3DVisualizationModeControl />");
      expect(contentSource).toContain("<Viewport3DVisualizationModeControl />");
      expect(dialog).not.toContain("field colors remain independent of lighting in both modes");
    } finally {
      await appearance.cleanup();
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
});

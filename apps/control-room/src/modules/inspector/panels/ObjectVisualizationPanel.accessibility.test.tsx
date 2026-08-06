import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ColorField,
  VisualizationRadioGroup,
  VisualizationToggleButton,
} from "./ObjectVisualizationPanel";
import {
  NumberField,
  VisualizationDisplayPassesSection,
} from "./ObjectVisualizationTargetSection";
import {
  AIRBOX_VISUALIZATION_TARGET,
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION,
  FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  nextVisualizationRadioValue,
  visualizationSectionDisabledDescription,
} from "./ObjectVisualizationPanelAccessibility";

describe("ObjectVisualizationPanel accessibility controls", () => {
  it("renders one Airbox master control without duplicate geometry toggles", () => {
    const html = renderToStaticMarkup(
      <VisualizationDisplayPassesSection
        displaySettings={DEFAULT_AIRBOX_VISUALIZATION}
        passControlsDisabled
        patch={vi.fn().mockResolvedValue(undefined)}
        pending={false}
        primitiveDisplayToggleVisible={false}
        renderWarning={null}
        settings={DEFAULT_AIRBOX_VISUALIZATION}
        target={AIRBOX_VISUALIZATION_TARGET}
      />,
    );

    expect(html).toContain('aria-label="Toggle target visibility"');
    expect(html).toContain(">Visible</button>");
    expect(html).toContain(">Vectors</button>");
    expect(html).not.toContain('aria-label="Toggle surface shading"');
    expect(html).not.toContain('aria-label="Toggle wireframe overlay"');
  });

  it("exposes FDM Airbox field vectors while retaining visibility and bounds", () => {
    const html = renderToStaticMarkup(
      <VisualizationDisplayPassesSection
        displaySettings={DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION}
        passControlsDisabled={false}
        patch={vi.fn().mockResolvedValue(undefined)}
        pending={false}
        primitiveDisplayToggleVisible={false}
        renderWarning={null}
        settings={DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION}
        target={FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET}
      />,
    );

    expect(html).toContain('aria-label="Toggle target visibility"');
    expect(html).toContain('aria-label="Toggle target bounds"');
    expect(html).toContain("Bounds opacity");
    expect(html).toContain("Toggle vector field arrows");
  });

  it("exposes only independent display overlays as pressed toggles", () => {
    const html = renderToStaticMarkup(
      <>
        <VisualizationToggleButton active label="Visible" onClick={vi.fn()} />
        <VisualizationToggleButton active={false} label="Vectors" onClick={vi.fn()} />
        <VisualizationToggleButton active label="Frame" onClick={vi.fn()} />
      </>,
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Visible</button>");
    expect(html).toContain(">Vectors</button>");
    expect(html).toContain(">Frame</button>");
  });

  it("announces why a disabled display control cannot be changed", () => {
    const html = renderToStaticMarkup(
      <VisualizationToggleButton
        active={false}
        disabled
        disabledDescription="Enable Visible to change display passes."
        label="Wireframe"
        onClick={vi.fn()}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("aria-describedby");
    expect(html).toContain("Enable Visible to change display passes.");
  });

  it("announces Visible before Vectors when a hidden target disables vector controls", () => {
    expect(
      visualizationSectionDisabledDescription({
        disabled: true,
        pending: false,
        requiredPass: "Vectors",
        requiredPassEnabled: true,
        targetVisible: false,
      }),
    ).toBe("Enable Visible to change display passes.");

    expect(
      visualizationSectionDisabledDescription({
        disabled: true,
        pending: false,
        requiredPass: "Vectors",
        requiredPassEnabled: false,
        targetVisible: true,
      }),
    ).toBe("Enable the Vectors display pass to change its effective settings.");
  });

  it("renders projection and color choices as labelled radio groups", () => {
    const html = renderToStaticMarkup(
      <>
        <VisualizationRadioGroup
          items={[
            { label: "Raw nodal", value: "raw" },
            { label: "Surface projected", value: "projected" },
          ]}
          label="Projection"
          value="raw"
          onValueChange={vi.fn()}
        />
        <VisualizationRadioGroup
          items={[
            { label: "Orientation", value: "orientation" },
            { label: "Mono", value: "mono" },
          ]}
          label="Vector coloring"
          value="orientation"
          onValueChange={vi.fn()}
        />
      </>,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Projection"');
    expect(html).toContain('aria-label="Vector coloring"');
    expect(html).toContain('data-slot="inspector-property-row"');
    expect(html).toContain('data-slot="segmented-control"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
  });

  it("moves radio selection with horizontal arrow keys", () => {
    const values = ["surface", "surface+edges", "wireframe"] as const;

    expect(nextVisualizationRadioValue(values, "surface", "ArrowRight")).toBe(
      "surface+edges",
    );
    expect(nextVisualizationRadioValue(values, "surface", "ArrowLeft")).toBe(
      "wireframe",
    );
    expect(nextVisualizationRadioValue(values, "wireframe", "Home")).toBe(
      "surface",
    );
    expect(nextVisualizationRadioValue(values, "surface", "End")).toBe(
      "wireframe",
    );
  });

  it("gives color picker and text input distinct accessible names", () => {
    const html = renderToStaticMarkup(
      <ColorField disabled={false} label="Wireframe color" value="#123456" onChange={vi.fn()} />,
    );

    expect(html).toContain('aria-label="Wireframe color picker"');
    expect(html).toContain('aria-label="Wireframe color value"');
    expect(html).toContain('data-slot="inspector-property-row"');
    expect(html).toContain('data-slot="visualization-color-control"');
  });

  it("renders numeric visualization controls as labelled Radix sliders", () => {
    const html = renderToStaticMarkup(
      <NumberField
        label="Vector alpha"
        max={100}
        min={0}
        unit="%"
        value={72}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain('data-slot="inspector-property-row"');
    expect(html).toContain('data-slot="visualization-number-control"');
    expect(html).toContain('aria-label="Vector alpha"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain("72%");
  });
});

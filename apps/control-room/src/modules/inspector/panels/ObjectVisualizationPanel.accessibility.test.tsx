import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ColorField,
  VisualizationRadioGroup,
  VisualizationToggleButton,
} from "./ObjectVisualizationPanel";
import {
  nextVisualizationRadioValue,
  visualizationSectionDisabledDescription,
} from "./ObjectVisualizationPanelAccessibility";

describe("ObjectVisualizationPanel accessibility controls", () => {
  it("exposes Surface, Wireframe, Points, and Vectors as pressed toggles", () => {
    const html = renderToStaticMarkup(
      <>
        <VisualizationToggleButton active label="Surface" onClick={vi.fn()} />
        <VisualizationToggleButton active={false} label="Wireframe" onClick={vi.fn()} />
        <VisualizationToggleButton active label="Points" onClick={vi.fn()} />
        <VisualizationToggleButton active={false} label="Vectors" onClick={vi.fn()} />
      </>,
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Surface</button>");
    expect(html).toContain(">Wireframe</button>");
    expect(html).toContain(">Points</button>");
    expect(html).toContain(">Vectors</button>");
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
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
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
  });
});

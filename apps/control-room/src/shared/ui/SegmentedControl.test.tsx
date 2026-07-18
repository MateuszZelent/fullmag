import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "./SegmentedControl";

interface SegmentedItemProps {
  disabled?: boolean;
  onClick: () => void;
}

describe("SegmentedControl", () => {
  it("renders one labelled radiogroup with selected and enabled options", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        aria-label="Render mode"
        options={[
          { label: "Shaded", value: "shaded" },
          { label: "Wire", value: "wire" },
        ]}
        value="shaded"
        onValueChange={() => undefined}
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Render mode"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-slot="segmented-control"');
    expect(html).toContain('data-slot="segmented-control-item"');
    expect(html).toContain("rounded-fm-segment");
    expect(html).toContain("border-fm-subtle");
    expect(html).toContain("shadow-fm-control-inset");
    expect(html).toContain("bg-fm-accent");
    expect(html).toContain("text-fm-inverse");
    expect(html).toContain("active:scale-[0.98]");
    expect(html).not.toContain("border-r");
  });

  it("selects an enabled option", () => {
    const onValueChange = vi.fn();
    const group = SegmentedControl({
      "aria-label": "Render mode",
      options: [
        { label: "Shaded", value: "shaded" },
        { label: "Wire", value: "wire" },
      ],
      value: "shaded",
      onValueChange,
    });
    const options = Children.toArray(
      group.props.children,
    ) as ReactElement<SegmentedItemProps>[];

    options[1]?.props.onClick();

    expect(onValueChange).toHaveBeenCalledWith("wire");
  });

  it("does not select a disabled option", () => {
    const onValueChange = vi.fn();
    const group = SegmentedControl({
      "aria-label": "Render mode",
      options: [{ disabled: true, label: "Points", value: "points" }],
      value: "wire",
      onValueChange,
    });
    const options = Children.toArray(
      group.props.children,
    ) as ReactElement<SegmentedItemProps>[];

    options[0]?.props.onClick();

    expect(onValueChange).not.toHaveBeenCalled();
    expect(options[0]?.props.disabled).toBe(true);
  });

  it("supports a compact visible label with a full accessible name", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        aria-label="Display mode"
        options={[
          {
            accessibleLabel: "Shaded plus wireframe",
            label: "Shaded+",
            value: "surface+edges",
          },
        ]}
        value="surface+edges"
        onValueChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Shaded plus wireframe"');
    expect(html).toContain('title="Shaded plus wireframe"');
    expect(html).toContain(">Shaded+</button>");
  });
});

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
});

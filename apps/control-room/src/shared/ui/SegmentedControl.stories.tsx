import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { SegmentedControl } from "./SegmentedControl";

const renderModes = [
  { label: "Shaded", value: "surface" },
  { label: "Shaded + wireframe", value: "surface+edges" },
  { label: "Wire", value: "wireframe" },
  { label: "Points", value: "points" },
] as const;

const meta = {
  args: {
    "aria-label": "Render mode",
    onValueChange: () => undefined,
    options: renderModes,
    value: "wireframe",
  },
  component: SegmentedControl,
  parameters: { layout: "padded" },
  title: "Shared/SegmentedControl",
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selected: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};

export const MixedDisabled: Story = {
  args: {
    options: renderModes.map((option) => ({
      ...option,
      disabled: option.value === "points",
    })),
  },
};

export const LongLabels: Story = {
  args: {
    options: [
      { label: "Shaded physical surface", value: "surface" },
      { label: "Surface with finite-element wireframe", value: "surface+edges" },
      { label: "Wireframe only", value: "wireframe" },
      { label: "Sampled mesh points", value: "points" },
    ],
  },
};

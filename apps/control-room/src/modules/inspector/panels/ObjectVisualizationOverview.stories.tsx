import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { controlVariants } from "@/shared/ui/controlVariants";

import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";
import { ObjectVisualizationOverview } from "./ObjectVisualizationOverview";

const display = (
  <div className="grid min-w-0 gap-3">
    <InspectorPropertyRow label="Render mode">
      <SegmentedControl
        aria-label="Render mode"
        options={[
          { label: "Shaded", value: "surface" },
          { label: "Wire", value: "wireframe" },
          { label: "Points", value: "points" },
        ]}
        value="wireframe"
        onValueChange={() => undefined}
      />
    </InspectorPropertyRow>
    <InspectorPropertyRow label="Quantity source">
      <select
        aria-label="Quantity source"
        className={controlVariants({ density: "compact" })}
        defaultValue="m"
      >
        <option value="m">m</option>
        <option value="H_eff">H_eff</option>
      </select>
    </InspectorPropertyRow>
  </div>
);

const surfaceColoring = (
  <InspectorGroup collapsible title="Surface Coloring">
    <InspectorPropertyRow label="Color source">
      <span>Solid (plain material)</span>
    </InspectorPropertyRow>
  </InspectorGroup>
);

const vectors = (
  <InspectorGroup collapsible title="Vectors">
    <InspectorPropertyRow label="Arrow extent">
      <span>Surface</span>
    </InspectorPropertyRow>
  </InspectorGroup>
);

const meta = {
  args: {
    advanced: <p className="m-0 text-fm-muted">Viewport quality profile</p>,
    camera: <p className="m-0 text-fm-muted">Camera follows viewport</p>,
    clipping: <p className="m-0 text-fm-muted">No clipping plane</p>,
    dataState: "Live",
    display,
    enabledPassCount: 4,
    meshState: "Ready",
    quantitySource: "m",
    surfaceColoring,
    vectors,
  },
  component: ObjectVisualizationOverview,
  decorators: [
    (Story) => (
      <div className="w-full max-w-[560px] bg-fm-panel p-4 font-fm-ui">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  title: "Inspector/Visualization Overview",
} satisfies Meta<typeof ObjectVisualizationOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Airbox: Story = {};

export const DegradedMesh: Story = {
  args: { dataState: "Stale", meshState: "Degraded" },
};

export const InheritedRegion: Story = {
  args: { dataState: "Inherited from object", quantitySource: "m (inherited)" },
};

export const RunningLocked: Story = {
  args: {
    dataState: "Running — controls locked",
    display: <div aria-disabled="true" className="text-fm-disabled-text">Display controls are locked while the stage runs.</div>,
  },
};

export const LongScientificLabels: Story = {
  args: {
    dataState: "Canonical finite-element field available",
    quantitySource: "H_demag_transverse_projected",
  },
};

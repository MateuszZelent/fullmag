import type { Preview } from "@storybook/nextjs-vite";

import "../app/globals.css";

const preview: Preview = {
  decorators: [
    (Story, context) => (
      <div
        data-theme={context.globals.theme}
        style={{
          background: "var(--fm-bg-app)",
          color: "var(--fm-text-primary)",
          minHeight: "100vh",
          padding: "var(--fm-space-4)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  globalTypes: {
    theme: {
      description: "Fullmag color theme",
      toolbar: {
        icon: "paintbrush",
        items: [
          { title: "Light", value: "light" },
          { title: "Dark", value: "dark" },
        ],
      },
    },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    viewport: {
      options: {
        inspector360: {
          name: "Inspector 360",
          styles: { height: "900px", width: "360px" },
        },
        inspector416: {
          name: "Inspector 416",
          styles: { height: "900px", width: "416px" },
        },
        inspector560: {
          name: "Inspector 560",
          styles: { height: "900px", width: "560px" },
        },
      },
    },
  },
};

export default preview;

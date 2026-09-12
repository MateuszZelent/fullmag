import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";

const vitestConfig = {
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "scripts/fdm-terminal-field-contract.test.mjs",
      "scripts/smoke-viewport-2d.test.mjs",
    ],
    environment: "node",
    globals: true,
  },
};

export default vitestConfig;

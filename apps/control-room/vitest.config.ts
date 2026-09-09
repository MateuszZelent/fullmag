import { configDefaults } from "vitest/config";
import { isAbsolute, resolve } from "node:path";

const frontendRoot = process.env.FULLMAG_FRONTEND_ROOT?.trim();
if (frontendRoot && !isAbsolute(frontendRoot)) {
  throw new Error(`FULLMAG_FRONTEND_ROOT must be absolute: ${frontendRoot}`);
}

const vitestConfig = {
  ...(frontendRoot
    ? { cacheDir: resolve(frontendRoot, "test-cache", "vite") }
    : {}),
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
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

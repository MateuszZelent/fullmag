/// <reference types="vitest" />
import path from "path";

export default {
  test: {
    include: ["**/__tests__/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  oxc: {
    jsxInject: undefined,
    jsx: "automatic",
  },
} satisfies import("vitest/config").UserConfig;

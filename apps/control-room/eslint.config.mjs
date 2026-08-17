import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Audit/smoke harnesses use isolated Next output directories whose names
    // carry a suffix (for example `.next-audit-target-smoke-fdm`).
    ".next-*/**",
    ".next-audit/**",
    ".fullmag/**",
    "out/**",
    "build/**",
    "storybook-static/**",
    "next-env.d.ts",
    "target-host/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;

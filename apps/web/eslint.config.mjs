import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";

const reactHooksCiRules = {
  "react-hooks/rules-of-hooks": "error",
};

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "out/**",
      "node_modules/**",
      "**/*.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": hooksPlugin,
    },
    rules: {
      ...reactHooksCiRules,
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@radix-ui/react-scroll-area",
              message: "Use components/ui/scroll-area.tsx native ScrollArea wrapper.",
            },
            {
              name: "@radix-ui/react-compose-refs",
              message: "Use the Next webpack alias to lib/radix/react-compose-refs-shim.ts.",
            },
          ],
        },
      ],
      "prefer-const": "error",
    },
  }
);

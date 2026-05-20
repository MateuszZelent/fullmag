import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const useLayoutSource = readFileSync(
  join(process.cwd(), "src/kernel/layout/useLayout.ts"),
  "utf8",
);
const ribbonModuleSource = readFileSync(
  join(process.cwd(), "src/modules/ribbon/RibbonModule.tsx"),
  "utf8",
);

describe("layout subscription performance contracts", () => {
  it("exposes action and selector hooks separately", () => {
    expect(useLayoutSource).toContain("export function useLayoutSelector");
    expect(useLayoutSource).toContain("export function useLayoutActions");
  });

  it("keeps RibbonModule subscribed only to the active module tab", () => {
    expect(ribbonModuleSource).toContain("useLayoutSelector");
    expect(ribbonModuleSource).toContain("useLayoutActions");
    expect(ribbonModuleSource).toContain("layout.activeModuleTab");
    expect(ribbonModuleSource).not.toContain("const { layout, setActiveTab } = useLayout()");
  });
});

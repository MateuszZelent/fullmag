import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const explorerStoreSource = readFileSync(
  join(process.cwd(), "src/modules/explorer/explorerStore.ts"),
  "utf8",
);
const explorerModuleSource = readFileSync(
  join(process.cwd(), "src/modules/explorer/ExplorerModule.tsx"),
  "utf8",
);

describe("explorer store subscription performance contracts", () => {
  it("exposes a selector hook for narrow explorer state subscriptions", () => {
    expect(explorerStoreSource).toContain("export function useExplorerStoreSelector");
    expect(explorerStoreSource).toContain("selector(explorerStore.getSnapshot())");
    expect(explorerStoreSource).toContain("options: { isEqual?:");
    expect(explorerStoreSource).toContain("isEqual(previous.selected, selected)");
  });

  it("uses selector subscriptions in ExplorerModule instead of the full store snapshot", () => {
    expect(explorerModuleSource).toContain("useExplorerStoreSelector");
    expect(explorerModuleSource).not.toContain("const explorer = useExplorerStore()");
  });
});

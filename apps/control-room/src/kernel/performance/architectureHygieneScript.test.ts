import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const scriptUrl = new URL("../../../scripts/check-architecture-hygiene.mjs", import.meta.url);

describe("architecture hygiene script", () => {
  it("rejects backup and rejected-patch suffixes anywhere under src", async () => {
    const source = await readFile(scriptUrl, "utf8");

    expect(source).toContain("checkBackupSuffixFiles();");
    expect(source).toContain('/(\\.orig|\\.rej|\\.bak|~)$/');
    expect(source).toContain("is a backup/reject artifact");
    expect(source).toContain("findBackupSuffixFailures(srcRoot, appRoot)");
    expect(source).toContain("listAllFiles(root)");
  });
});

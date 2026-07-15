import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiHygieneScriptUrl = new URL(
  "../../../scripts/check-api-hygiene.mjs",
  import.meta.url,
);
const appRootUrl = new URL("../../..", import.meta.url);

describe("API hygiene script", () => {
  it("executes with the Ubuntu system ripgrep", () => {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(apiHygieneScriptUrl)],
      {
        cwd: fileURLToPath(appRootUrl),
        encoding: "utf8",
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      },
    );

    expect(output).toBe("");
  });
});

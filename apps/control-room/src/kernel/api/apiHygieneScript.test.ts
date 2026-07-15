import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiHygieneScriptUrl = new URL(
  "../../../scripts/check-api-hygiene.mjs",
  import.meta.url,
);
const appRootUrl = new URL("../../..", import.meta.url);
const ubuntuSystemRipgrep = "/usr/bin/rg";
const ubuntuSystemRipgrepVersion = readUbuntuSystemRipgrepVersion();
const ubuntuRipgrep13It =
  ubuntuSystemRipgrepVersion === "ripgrep 13.0.0" ? it : it.skip;

describe("API hygiene script", () => {
  ubuntuRipgrep13It("executes with the Ubuntu ripgrep 13 used by CI", () => {
    expect(ubuntuSystemRipgrepVersion).toBe("ripgrep 13.0.0");
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

function readUbuntuSystemRipgrepVersion(): string | null {
  if (process.platform !== "linux" || !existsSync(ubuntuSystemRipgrep)) {
    return null;
  }
  try {
    return execFileSync(ubuntuSystemRipgrep, ["--version"], {
      encoding: "utf8",
    }).split("\n", 1)[0] ?? null;
  } catch {
    return null;
  }
}

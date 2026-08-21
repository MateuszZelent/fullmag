import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findLegacyRuntimePathFailures } from "../../../scripts/check-architecture-hygiene.mjs";

const scriptUrl = new URL("../../../scripts/check-architecture-hygiene.mjs", import.meta.url);
const controlRoomLauncherUrl = new URL(
  "../../../../../crates/fullmag-cli/src/control_room.rs",
  import.meta.url,
);

describe("architecture hygiene script", () => {
  it("rejects backup and rejected-patch suffixes anywhere under src", async () => {
    const source = await readFile(scriptUrl, "utf8");

    expect(source).toContain("checkBackupSuffixFiles();");
    expect(source).toContain('/(\\.orig|\\.rej|\\.bak|~)$/');
    expect(source).toContain("is a backup/reject artifact");
    expect(source).toContain("findBackupSuffixFailures(srcRoot, appRoot)");
    expect(source).toContain("listAllFiles(root)");
  });

  it("guards the Rust launcher against legacy frontend runtime fallbacks", async () => {
    const source = await readFile(scriptUrl, "utf8");
    const launcher = await readFile(controlRoomLauncherUrl, "utf8");

    expect(source).toContain('"crates/fullmag-cli/src/control_room.rs"');
    expect(source).toContain("apps/legacy_web");
    expect(source).toContain("legacy frontend runtime path");
    expect(launcher).toContain('root.join("apps").join("control-room")');
    expect(launcher).not.toContain("legacy_candidates");
    expect(launcher).not.toContain('root.join("apps").join("legacy_web")');
    expect(launcher).not.toContain('root.join("apps").join("web").join("out")');
    expect(launcher).not.toContain("apps/web/dev-server.mjs");
  });

  it("reports the exact runtime launcher path for a legacy fallback", async () => {
    const fixtureRoot = await mkdtemp(join("/tmp", "fullmag-architecture-hygiene-"));
    const launcherPath = join(fixtureRoot, "crates/fullmag-cli/src/control_room.rs");
    await mkdir(join(fixtureRoot, "crates/fullmag-cli/src"), { recursive: true });
    await writeFile(launcherPath, 'const fallback = "apps/legacy_web";\n', "utf8");

    expect(findLegacyRuntimePathFailures(fixtureRoot)).toEqual([
      'crates/fullmag-cli/src/control_room.rs still references legacy frontend runtime path "apps/legacy_web".',
    ]);

    await rm(fixtureRoot, { recursive: true, force: true });
  });
});

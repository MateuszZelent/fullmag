import {
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSmokeMutationGuard,
  resolveSmokeApiBase,
} from "../../../scripts/lib/smoke-session-isolation.mjs";

function disposableFixture() {
  const directory = mkdtempSync(join(tmpdir(), "fullmag-smoke-isolation-"));
  const scriptPath = join(directory, "fixture.py");
  const token = "test-disposable-token";
  writeFileSync(scriptPath, "original fixture\n");
  writeFileSync(join(directory, ".fullmag-smoke-disposable"), `${token}\n`);
  return { directory, scriptPath, token };
}

describe("viewport smoke session isolation", () => {
  it("refuses a mutating smoke without a disposable fixture proof", async () => {
    await expect(
      createSmokeMutationGuard({
        apiBase: "http://localhost:8081",
        env: {},
        fetchImpl: async () => {
          throw new Error("must fail before API access");
        },
        mutationRequired: true,
        pageUrl: "http://localhost:3100/workspace",
      }),
    ).rejects.toThrow("refuses to mutate an existing Control Room session");
  });

  it("requires the active session to own the exact disposable script", async () => {
    const fixture = disposableFixture();
    await expect(
      createSmokeMutationGuard({
        apiBase: "http://localhost:8081",
        env: {
          CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN: fixture.token,
          CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH: fixture.scriptPath,
        },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ script_path: join(fixture.directory, "other.py") }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        mutationRequired: true,
        pageUrl: "http://localhost:3100/workspace",
      }),
    ).rejects.toThrow("does not own the declared disposable script");
  });

  it("rejects a symlink alias instead of snapshotting its real path", async () => {
    const fixture = disposableFixture();
    const aliasPath = join(fixture.directory, "fixture-alias.py");
    symlinkSync(fixture.scriptPath, aliasPath);

    await expect(
      createSmokeMutationGuard({
        apiBase: "http://localhost:8081",
        env: {
          CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN: fixture.token,
          CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH: aliasPath,
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ script_path: aliasPath }), { status: 200 }),
        mutationRequired: true,
        pageUrl: "http://localhost:3100/workspace",
      }),
    ).rejects.toThrow("must not contain symbolic links");
  });

  it("restores the exact script snapshot when the smoke mutates it", async () => {
    const fixture = disposableFixture();
    const guard = await createSmokeMutationGuard({
      apiBase: "http://localhost:8081",
      env: {
        CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN: fixture.token,
        CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH: fixture.scriptPath,
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ script_path: fixture.scriptPath }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      mutationRequired: true,
      pageUrl: "http://localhost:3100/workspace",
    });

    writeFileSync(fixture.scriptPath, "corrupted by model sync\n");
    const result = guard.restoreAndVerify();

    expect(readFileSync(fixture.scriptPath, "utf8")).toBe("original fixture\n");
    expect(result.restored).toBe(true);
    expect(result.beforeSha256).toBe(result.afterSha256);
  });

  it("retries restoration after a failed restore attempt", async () => {
    const fixture = disposableFixture();
    const guard = await createSmokeMutationGuard({
      apiBase: "http://localhost:8081",
      env: {
        CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN: fixture.token,
        CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH: fixture.scriptPath,
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ script_path: fixture.scriptPath }), {
          status: 200,
        }),
      mutationRequired: true,
      pageUrl: "http://localhost:3100/workspace",
    });
    writeFileSync(fixture.scriptPath, "corrupted\n");
    const movedDirectory = `${fixture.directory}-temporarily-moved`;
    renameSync(fixture.directory, movedDirectory);

    expect(() => guard.restoreAndVerify()).toThrow();
    renameSync(movedDirectory, fixture.directory);
    const result = guard.restoreAndVerify();

    expect(result.restored).toBe(true);
    expect(readFileSync(fixture.scriptPath, "utf8")).toBe("original fixture\n");
  });

  it("derives the API origin from an explicit API base or page URL", () => {
    expect(
      resolveSmokeApiBase({
        apiBase: "http://localhost:8081/v2/",
        pageUrl: "http://localhost:3100/workspace",
      }),
    ).toBe("http://localhost:8081");
    expect(
      resolveSmokeApiBase({
        apiBase: null,
        pageUrl: "http://127.0.0.1:3100/workspace",
      }),
    ).toBe("http://127.0.0.1:3100");
  });
});

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DevSourceMirrorError,
  createDevSourceMirror,
  mirrorDevSourcesOnce,
} from "./dev-source-mirror.mjs";

const DIRECTORIES = ["app", "src", "public", "scripts"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fullmag-dev-source-mirror-"));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  for (const directory of DIRECTORIES) {
    await mkdir(join(source, directory), { recursive: true });
    await mkdir(join(target, directory), { recursive: true });
  }
  await writeFile(join(source, "app", "page.tsx"), "export default 1;\n");
  await writeFile(join(source, "src", "initial.ts"), "export const initial = 1;\n");
  await writeFile(join(source, "public", "icon.svg"), "<svg/>\n");
  await writeFile(join(source, "scripts", "tool.mjs"), "export const tool = 1;\n");
  return { root, source, target };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("timed out waiting for source mirror update");
}

test("mirrors regular source trees and relays atomic create/update/delete", async () => {
  const { root, source, target } = await fixture();
  const mirror = createDevSourceMirror({ sourceRoot: source, targetRoot: target });
  try {
    await mirror.start();
    assert.equal(await readFile(join(target, "app", "page.tsx"), "utf8"), "export default 1;\n");
    for (const directory of DIRECTORIES) {
      assert.equal((await lstat(join(target, directory))).isSymbolicLink(), false);
    }

    const replacement = join(source, "app", "page.tmp");
    await writeFile(replacement, "export default 2;\n");
    await rename(replacement, join(source, "app", "page.tsx"));
    await waitFor(async () => (await readFile(join(target, "app", "page.tsx"), "utf8")) === "export default 2;\n");

    await mkdir(join(source, "app", "workspace"));
    await writeFile(join(source, "app", "workspace", "page.tsx"), "export default 3;\n");
    await waitFor(async () => {
      try {
        return (await readFile(join(target, "app", "workspace", "page.tsx"), "utf8")) === "export default 3;\n";
      } catch (error) {
        if (error?.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    });

    await rm(join(source, "app", "workspace"), { recursive: true });
    await waitFor(async () => {
      try {
        await lstat(join(target, "app", "workspace"));
        return false;
      } catch (error) {
        return error?.code === "ENOENT";
      }
    });
  } finally {
    await mirror.close();
    await cleanup(root);
  }
});

test("initial reconciliation closes the copy/watch startup race", async () => {
  const { root, source, target } = await fixture();
  try {
    await writeFile(join(source, "src", "created-before-watcher.ts"), "export const ready = true;\n");
    await mirrorDevSourcesOnce({ sourceRoot: source, targetRoot: target });
    assert.equal(
      await readFile(join(target, "src", "created-before-watcher.ts"), "utf8"),
      "export const ready = true;\n",
    );
  } finally {
    await cleanup(root);
  }
});

test("source symlinks fail closed without touching the target", async (t) => {
  const { root, source, target } = await fixture();
  const outside = join(root, "outside.txt");
  await writeFile(outside, "protected\n");
  try {
    try {
      await symlink(outside, join(source, "src", "unsafe-link"));
    } catch (error) {
      if (["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) {
        t.skip(`host cannot create a source symlink: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      mirrorDevSourcesOnce({ sourceRoot: source, targetRoot: target }),
      (error) => error instanceof DevSourceMirrorError && /symlink|reparse/i.test(error.message),
    );
    assert.equal(await readFile(outside, "utf8"), "protected\n");
    await assert.rejects(lstat(join(target, "src", "unsafe-link")), { code: "ENOENT" });
  } finally {
    await cleanup(root);
  }
});

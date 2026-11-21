import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(
  process.env.FULLMAG_NEXT_ROUTE_PATCH_REPO_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const requireFromWorkspace = createRequire(
  join(repoRoot, "apps", "control-room", "package.json"),
);
const nextRoot = resolve(
  process.env.FULLMAG_NEXT_PACKAGE_ROOT ??
    dirname(requireFromWorkspace.resolve("next/package.json")),
);
const nextPackage = JSON.parse(
  await readFile(join(nextRoot, "package.json"), "utf8"),
);
assert.equal(nextPackage.version, requireFromWorkspace("./package.json").dependencies.next);

// Next 16.4.6 now snapshots route files before Watchpack starts and waits for
// that initial snapshot to become observable before publishing route tables.
const setupPath = join(
  nextRoot,
  "dist",
  "server",
  "lib",
  "router-utils",
  "setup-dev-bundler.js",
);
const setupSource = await readFile(setupPath, "utf8");
assert.match(
  setupSource,
  /const initialFiles = \(await Promise\.all\(directories\.map\(async \(directory\)=>/u,
);
assert.match(
  setupSource,
  /const initialPageFiles = initialFiles\.filter\(validFileMatcher\.isPageFile\);/u,
);
assert.match(
  setupSource,
  /initialPageFiles\.some\(\(file\)=>_fs\.default\.existsSync\(file\) && !knownFiles\.has\(file\)\)/u,
);
assert.match(
  setupSource,
  /const initialScanDeadline = initialWatchTime \+ 30000;/u,
);
assert.match(
  setupSource,
  /await propagateServerField\(opts, 'appPathRoutes', serverFields\.appPathRoutes\);/u,
);
process.stdout.write(
  "Next dev route discovery contract PASS (snapshot, bounded watcher gate, route propagation)\n",
);

// Keep the local CSS HMR fix: the bundled 16.4.6 handlers still assume the old
// stylesheet has a parent after React detaches it during a replacement.
const cssHmrSource = await readFile(
  join(nextRoot, "dist/compiled/mini-css-extract-plugin/hmr/hotModuleReplacement.js"),
  "utf8",
);
assert.equal(
  [...cssHmrSource.matchAll(/if\(e\.parentNode\)\{e\.parentNode\.removeChild\(e\)\}/gu)].length,
  2,
  "both CSS HMR completion callbacks must guard detached links",
);
for (const event of ["load", "error"]) {
  for (const detached of [false, true]) {
    let replacement;
    let removed = 0;
    const parent = {
      appendChild(link) { link.parentNode = this; replacement = link; },
      removeChild(link) {
        assert.equal(link.parentNode, this);
        link.parentNode = null;
        removed += 1;
      },
    };
    const listeners = new Map();
    const old = {
      href: "http://localhost/example.css",
      parentNode: parent,
      cloneNode() {
        return { addEventListener(name, listener) { listeners.set(name, listener); } };
      },
    };
    const module = { exports: {} };
    runInNewContext(cssHmrSource, {
      module,
      __dirname: nextRoot,
      document: {
        currentScript: { src: "http://localhost/app.js" },
        querySelectorAll() { return [old]; },
      },
      console: { log() {} },
      setTimeout(callback) { callback(); return 1; },
      clearTimeout() {},
    });
    module.exports(7, { locals: true })();
    assert.ok(replacement, "CSS HMR must insert the replacement link");
    assert.equal(replacement.isLoaded, false);
    if (detached) parent.removeChild(old);
    assert.doesNotThrow(() => listeners.get(event)());
    assert.equal(replacement.isLoaded, true);
    assert.equal(replacement.parentNode, parent);
    assert.equal(old.parentNode, null);
    assert.equal(removed, 1);
    assert.doesNotThrow(() => listeners.get(event)());
    assert.equal(removed, 1, "a repeated completion must not remove a second node");
  }
}
process.stdout.write("CSS HMR fixture PASS (load/error; attached/detached link)\n");

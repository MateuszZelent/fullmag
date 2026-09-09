import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanNextTarget, inspectNextTarget } from "./clean-control-room-next.mjs";

function fixtureRoot(name) {
  const root = join(tmpdir(), `fullmag-web-clean-${name}-${process.pid}`);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function nextPath(root) {
  return join(root, "apps", "control-room", ".next");
}

test("cleans only an ordinary checkout-owned Next output directory", () => {
  const root = fixtureRoot("ordinary");
  try {
    const target = nextPath(root);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "BUILD_ID"), "fixture\n");

    assert.equal(inspectNextTarget(root).status, "safe");
    cleanNextTarget(root);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("refuses a junction or symbolic link and leaves its destination intact", () => {
  const root = fixtureRoot("link");
  const destination = fixtureRoot(`link-destination-${process.pid}`);
  try {
    const target = nextPath(root);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "KEEP"), "owned elsewhere\n");
    mkdirSync(join(root, "apps", "control-room"), { recursive: true });
    symlinkSync(
      destination,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );

    const inspection = inspectNextTarget(root);
    assert.equal(inspection.status, "managed-link");
    assert.throws(() => cleanNextTarget(root), /refusing to remove managed link/u);
    assert.equal(existsSync(join(destination, "KEEP")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(destination, { force: true, recursive: true });
  }
});

import {
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const NEXT_PATH = join("apps", "control-room", ".next");

/**
 * Inspect the fixed Next.js output path before any removal.
 *
 * A junction or symbolic link is never treated as a disposable directory.
 * This also checks each parent component so a linked checkout cannot redirect
 * the fixed relative path into an unrelated storage tree.
 */
export function inspectNextTarget(repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(repoRoot);
  const target = resolve(root, NEXT_PATH);
  const pathFromRoot = relative(root, target);

  if (
    isAbsolute(pathFromRoot) ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    return {
      status: "invalid",
      target,
      reason: "the resolved Next output path is outside the repository root",
    };
  }

  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink()) {
    return {
      status: "managed-link",
      linkPath: root,
      resolvedPath: resolveLink(root),
      target,
      reason: "the repository root is a symbolic link or Windows junction",
    };
  }

  let cursor = root;
  for (const component of pathFromRoot.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, component);
    let entry;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { status: "missing", target };
      }
      throw error;
    }

    if (entry.isSymbolicLink()) {
      return {
        status: "managed-link",
        linkPath: cursor,
        resolvedPath: resolveLink(cursor),
        target,
        reason: "a symbolic link or Windows junction is in the cleanup path",
      };
    }
  }

  const entry = lstatSync(target);
  if (!entry.isDirectory()) {
    return {
      status: "invalid",
      target,
      reason: "the cleanup path exists but is not a directory",
    };
  }

  const resolvedTarget = resolveLink(target);
  if (resolvedTarget && !samePath(resolvedTarget, target)) {
    return {
      status: "managed-link",
      linkPath: target,
      resolvedPath: resolvedTarget,
      target,
      reason: "the cleanup path resolves outside its lexical directory",
    };
  }

  return { status: "safe", target };
}

export function cleanNextTarget(repoRoot = DEFAULT_REPO_ROOT) {
  const inspection = inspectNextTarget(repoRoot);

  if (inspection.status === "missing") {
    process.stdout.write(`[web:clean] Next output is already absent: ${inspection.target}\n`);
    return inspection;
  }

  if (inspection.status === "managed-link") {
    const destination = inspection.resolvedPath
      ? ` (resolves to ${inspection.resolvedPath})`
      : "";
    throw new Error(
      `refusing to remove managed link ${inspection.linkPath}${destination}. ` +
        "Inspect the storage inventory and stop any running Control Room dev " +
        "servers before retrying; web:clean only removes an ordinary " +
        "checkout-owned apps/control-room/.next directory.",
    );
  }

  if (inspection.status === "invalid") {
    throw new Error(`refusing to clean ${inspection.target}: ${inspection.reason}.`);
  }

  // The target is fixed above; there are no wildcards or caller-controlled
  // paths here. Only the checkout-owned Next output directory is removed.
  rmSync(inspection.target, { force: true, recursive: true });
  process.stdout.write(`[web:clean] removed Next output: ${inspection.target}\n`);
  return inspection;
}

function resolveLink(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function samePath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return samePath(resolve(process.argv[1]), SCRIPT_PATH);
}

if (isDirectInvocation()) {
  try {
    cleanNextTarget();
  } catch (error) {
    process.stderr.write(
      `[web:clean] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

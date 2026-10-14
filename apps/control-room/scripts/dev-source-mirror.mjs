import { randomUUID } from "node:crypto";
import { watch as watchPath } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEV_SOURCE_MIRROR_DIRECTORIES = Object.freeze([
  "app",
  "src",
  "public",
  "scripts",
]);

const WINDOWS_RECURSIVE_WATCH_ERROR_CODES = new Set([
  "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
  "ENOSYS",
  "EINVAL",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".fullmag",
  ".fullmag-frontend",
  ".next",
  ".next-audit",
  "artifacts",
  ".artifacts",
  "node_modules",
  "out",
  "storybook-static",
  "target",
]);
const EXCLUDED_DIRECTORY_PREFIXES = [".fullmag-", ".next-"];
const EXCLUDED_FILE_SUFFIXES = [".tsbuildinfo"];

export class DevSourceMirrorError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "DevSourceMirrorError";
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathInside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function signature(record) {
  return `${record.kind}:${record.size ?? 0}:${record.mtime ?? ""}:${record.ctime ?? ""}`;
}

function timeValue(stats, nanoseconds, milliseconds) {
  return String(stats[nanoseconds] ?? stats[milliseconds] ?? "");
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function isExcludedDirectory(name) {
  const lowered = name.toLowerCase();
  return EXCLUDED_DIRECTORY_NAMES.has(lowered) || EXCLUDED_DIRECTORY_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function isExcludedFile(name) {
  const lowered = name.toLowerCase();
  return EXCLUDED_FILE_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

function yieldToFilesystem() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

async function lstatNoFollow(path, label) {
  let stats;
  try {
    stats = await fs.lstat(path);
  } catch (error) {
    throw new DevSourceMirrorError(`Cannot inspect ${label}: ${path}`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new DevSourceMirrorError(`${label} must not be a symlink or reparse point: ${path}`);
  }
  // Node exposes Windows junctions as real directories on some supported
  // versions.  realpath differs from the lexical path in that case, so use
  // it as the second no-follow check.  Case folding is limited to Windows.
  try {
    const resolved = await fs.realpath(path);
    if (!samePath(resolved, path)) {
      throw new DevSourceMirrorError(`${label} must not be a junction or reparse point: ${path}`);
    }
  } catch (error) {
    if (error instanceof DevSourceMirrorError) {
      throw error;
    }
    throw new DevSourceMirrorError(`Cannot resolve ${label}: ${path}`, { cause: error });
  }
  return stats;
}

async function requireDirectory(path, label) {
  const stats = await lstatNoFollow(path, label);
  if (!stats.isDirectory()) {
    throw new DevSourceMirrorError(`${label} must be a directory: ${path}`);
  }
  return stats;
}

async function requireRegularFile(path, label) {
  const stats = await lstatNoFollow(path, label);
  if (!stats.isFile()) {
    throw new DevSourceMirrorError(`${label} must be a regular file: ${path}`);
  }
  return stats;
}

function validateRoot(value, label) {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) {
    throw new DevSourceMirrorError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

async function snapshotTree(root, label) {
  await requireDirectory(root, label);
  const entries = new Map();
  const stack = [{ path: root, key: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    let children;
    try {
      children = await fs.readdir(current.path, { withFileTypes: true });
    } catch (error) {
      throw new DevSourceMirrorError(`Cannot enumerate ${label}: ${current.path}`, { cause: error });
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      // Keep the relay's source boundary identical to the staging helper.
      // Generated output, dependency trees, and TypeScript build metadata
      // are owned by the isolated workspace and are never copied from the
      // checkout.
      if (isExcludedDirectory(child.name) || isExcludedFile(child.name)) {
        continue;
      }
      const childPath = join(current.path, child.name);
      const childKey = current.key ? `${current.key}/${child.name}` : child.name;
      const stats = await lstatNoFollow(childPath, `${label} entry`);
      if (stats.isDirectory()) {
        entries.set(childKey, {
          kind: "directory",
          size: 0,
          mtime: timeValue(stats, "mtimeNs", "mtimeMs"),
          ctime: timeValue(stats, "ctimeNs", "ctimeMs"),
        });
        stack.push({ path: childPath, key: childKey });
      } else if (stats.isFile()) {
        entries.set(childKey, {
          kind: "file",
          size: stats.size,
          mtime: timeValue(stats, "mtimeNs", "mtimeMs"),
          ctime: timeValue(stats, "ctimeNs", "ctimeMs"),
        });
      } else {
        throw new DevSourceMirrorError(`Unsupported ${label} entry: ${childPath}`);
      }
    }
  }
  return entries;
}

function snapshotFingerprint(entries) {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, record]) => `${key}\0${signature(record)}`)
    .join("\n");
}

async function removeTreeNoFollow(path, label) {
  let stats;
  try {
    stats = await lstatNoFollow(path, label);
  } catch (error) {
    if (isMissing(error.cause) || error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stats.isDirectory()) {
    let children;
    try {
      children = await fs.readdir(path);
    } catch (error) {
      throw new DevSourceMirrorError(`Cannot enumerate staged directory before removal: ${path}`, { cause: error });
    }
    for (const child of children) {
      await removeTreeNoFollow(join(path, child), "staged entry");
    }
    await fs.rmdir(path);
  } else if (stats.isFile()) {
    await fs.unlink(path);
  } else {
    throw new DevSourceMirrorError(`Cannot remove unsupported staged entry: ${path}`);
  }
}

async function replaceStagedFile(temporary, target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      // Node/libuv uses replace-existing rename on Windows. Keep the old
      // source readable while Next/antivirus briefly holds a sharing lock.
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      try {
        const existing = await lstatNoFollow(target, "staged file");
        if (!existing.isFile()) {
          throw new DevSourceMirrorError(`Staged target is not a regular file: ${target}`);
        }
      } catch (inspection) {
        if (!(inspection instanceof DevSourceMirrorError && isMissing(inspection.cause))) {
          throw inspection;
        }
      }
      if (attempt === 7) {
        throw new DevSourceMirrorError(`Staged file is busy; prior source retained: ${target}`, {
          cause: { code: "EAGAIN", originalCode: error.code },
        });
      }
      await new Promise((resume) => setTimeout(resume, Math.min(10 * 2 ** attempt, 80)));
    }
  }
}

async function publishFile(source, target) {
  const parent = dirname(target);
  await requireDirectory(parent, "staged parent directory");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await requireRegularFile(source, "source file");
    const temporary = join(
      parent,
      `.fullmag-source-mirror-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      await fs.copyFile(source, temporary);
      const after = await requireRegularFile(source, "source file");
      if (
        before.size !== after.size ||
        timeValue(before, "mtimeNs", "mtimeMs") !== timeValue(after, "mtimeNs", "mtimeMs") ||
        timeValue(before, "ctimeNs", "ctimeMs") !== timeValue(after, "ctimeNs", "ctimeMs")
      ) {
        continue;
      }
      await replaceStagedFile(temporary, target);
      return;
    } catch (error) {
      if (isMissing(error)) {
        // Atomic editor replacement can remove the source between lstat and
        // copy.  The enclosing reconcile pass will observe the new state.
        continue;
      }
      if (error instanceof DevSourceMirrorError && isMissing(error.cause)) {
        continue;
      }
      if (error instanceof DevSourceMirrorError) throw error;
      throw new DevSourceMirrorError(`Cannot mirror source file ${source} -> ${target}`, { cause: error });
    } finally {
      try {
        await fs.unlink(temporary);
      } catch (error) {
        if (!isMissing(error)) {
          throw new DevSourceMirrorError(`Cannot remove temporary mirror file: ${temporary}`, { cause: error });
        }
      }
    }
  }
  throw new DevSourceMirrorError(
    `Source file changed continuously during mirror: ${source}`,
    { cause: { code: "EAGAIN" } },
  );
}

export class DevSourceMirror {
  constructor({
    sourceRoot,
    targetRoot,
    directories = DEV_SOURCE_MIRROR_DIRECTORIES,
    debounceMs = 75,
    onError = null,
  } = {}) {
    this.sourceRoot = validateRoot(sourceRoot, "source root");
    this.targetRoot = validateRoot(targetRoot, "target root");
    this.directories = [...directories];
    this.debounceMs = debounceMs;
    this.onError = onError;
    this.watchers = [];
    this.pollTimer = null;
    this.debounceTimer = null;
    this.reconciling = false;
    this.drainPromise = null;
    this.pending = false;
    this.closed = false;
    this.failed = null;
    this.published = new Map();
  }

  sourcePath(directory) {
    return join(this.sourceRoot, directory);
  }

  targetPath(directory) {
    return join(this.targetRoot, directory);
  }

  async validateRoots() {
    if (samePath(this.sourceRoot, this.targetRoot)) {
      throw new DevSourceMirrorError("Source and target roots must be different");
    }
    if (pathInside(this.sourceRoot, this.targetRoot) || pathInside(this.targetRoot, this.sourceRoot)) {
      throw new DevSourceMirrorError("Source and target roots must not contain one another");
    }
    await requireDirectory(this.sourceRoot, "source Control Room root");
    await requireDirectory(this.targetRoot, "staged Control Room root");
    if (
      this.directories.length !== new Set(this.directories).size ||
      this.directories.some((directory) => !/^[A-Za-z0-9_-]+$/.test(directory))
    ) {
      throw new DevSourceMirrorError("Source mirror directory names are invalid");
    }
    for (const directory of this.directories) {
      await requireDirectory(this.sourcePath(directory), `source mirror directory ${directory}`);
      await requireDirectory(this.targetPath(directory), `staged mirror directory ${directory}`);
    }
  }

  async snapshotSources() {
    const entries = new Map();
    for (const directory of this.directories) {
      const sourceEntries = await snapshotTree(this.sourcePath(directory), `source mirror ${directory}`);
      for (const [key, record] of sourceEntries) {
        entries.set(`${directory}/${key}`, record);
      }
    }
    return entries;
  }

  async snapshotTargets() {
    const entries = new Map();
    for (const directory of this.directories) {
      const targetEntries = await snapshotTree(this.targetPath(directory), `staged mirror ${directory}`);
      for (const [key, record] of targetEntries) {
        entries.set(`${directory}/${key}`, record);
      }
    }
    return entries;
  }

  async applySnapshot(sourceEntries, targetEntries) {
    const stale = [...targetEntries.keys()]
      .filter((key) => !sourceEntries.has(key))
      .sort((left, right) => right.length - left.length || right.localeCompare(left));
    for (const key of stale) {
      try {
        await lstatNoFollow(join(this.sourceRoot, key), "source deletion confirmation");
        this.pending = true;
        continue;
      } catch (error) {
        if (!(error instanceof DevSourceMirrorError && isMissing(error.cause))) throw error;
      }
      await removeTreeNoFollow(join(this.targetRoot, key), "staged mirror entry");
      this.published.delete(key);
    }

    const directories = [...sourceEntries.entries()]
      .filter(([, record]) => record.kind === "directory")
      .sort(([left], [right]) => left.length - right.length || left.localeCompare(right));
    for (const [key] of directories) {
      const destination = join(this.targetRoot, key);
      try {
        const existing = await lstatNoFollow(destination, "staged mirror entry");
        if (!existing.isDirectory()) {
          await removeTreeNoFollow(destination, "staged mirror entry");
          await fs.mkdir(destination);
        }
      } catch (error) {
        if (isMissing(error) || (error instanceof DevSourceMirrorError && isMissing(error.cause))) {
          await fs.mkdir(destination, { recursive: true });
        } else {
          throw error;
        }
      }
    }

    const files = [...sourceEntries.entries()]
      .filter(([, record]) => record.kind === "file")
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [key, sourceRecord] of files) {
      const source = join(this.sourceRoot, key);
      const target = join(this.targetRoot, key);
      const oldSignature = this.published.get(key);
      let targetIsCurrent = false;
      if (oldSignature === signature(sourceRecord)) {
        try {
          const targetRecord = await requireRegularFile(target, "staged mirror file");
          targetIsCurrent = targetRecord.size === sourceRecord.size;
        } catch (error) {
          if (!isMissing(error) && !(error instanceof DevSourceMirrorError && isMissing(error.cause))) {
            throw error;
          }
        }
      }
      if (!targetIsCurrent) {
        try {
          const existing = await lstatNoFollow(target, "staged mirror entry");
          if (existing.isDirectory()) {
            await removeTreeNoFollow(target, "staged mirror entry");
          } else if (!existing.isFile()) {
            throw new DevSourceMirrorError(`Staged mirror target is unsupported: ${target}`);
          }
        } catch (error) {
          if (!isMissing(error) && !(error instanceof DevSourceMirrorError && isMissing(error.cause))) {
            throw error;
          }
        }
        await publishFile(source, target);
      }
      this.published.set(key, signature(sourceRecord));
    }
  }

  async reconcileOnce() {
    if (this.closed) {
      return;
    }
    await this.validateRoots();
    const sourceEntries = await this.snapshotSources();
    const targetEntries = await this.snapshotTargets();
    await this.applySnapshot(sourceEntries, targetEntries);
    return snapshotFingerprint(sourceEntries);
  }

  async reconcileUntilStable() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      this.pending = false;
      let before;
      try {
        before = await this.reconcileOnce();
      } catch (error) {
        if (error instanceof DevSourceMirrorError && error.cause?.code === "EAGAIN") {
          await yieldToFilesystem();
          continue;
        }
        throw error;
      }
      await yieldToFilesystem();
      const after = await this.snapshotSources();
      if (!this.pending && before === snapshotFingerprint(after)) {
        return;
      }
    }
    throw new DevSourceMirrorError(
      "Source changed continuously while mirroring the staged Control Room",
      { cause: { code: "EAGAIN" } },
    );
  }

  schedule() {
    if (this.closed || this.failed) {
      return;
    }
    this.pending = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain().catch((error) => {
        if (error instanceof DevSourceMirrorError && error.cause?.code === "EAGAIN") {
          // Live editing can outlast one bounded scan; keep the watcher alive.
          this.schedule();
        } else {
          this.fail(error);
        }
      });
    }, this.debounceMs);
  }

  async drain() {
    if (this.closed || this.failed) {
      return;
    }
    if (this.reconciling) {
      this.pending = true;
      return;
    }
    this.reconciling = true;
    const operation = (async () => {
      try {
        await this.reconcileUntilStable();
      } finally {
        this.reconciling = false;
      }
      if (this.pending && !this.closed) {
        this.schedule();
      }
    })();
    this.drainPromise = operation;
    try {
      await operation;
    } finally {
      if (this.drainPromise === operation) {
        this.drainPromise = null;
      }
    }
  }

  installWatcher(root) {
    const callback = () => this.schedule();
    try {
      const watcher = watchPath(root, { recursive: true }, callback);
      watcher.on("error", (error) => this.fail(error));
      this.watchers.push(watcher);
      return true;
    } catch (error) {
      if (!WINDOWS_RECURSIVE_WATCH_ERROR_CODES.has(error?.code)) {
        throw new DevSourceMirrorError(`Cannot watch source mirror root: ${root}`, { cause: error });
      }
      return false;
    }
  }

  installFallbackWatchers() {
    // Linux does not implement recursive fs.watch.  The native Windows route
    // uses the recursive watcher above; this bounded fallback keeps direct
    // development and interpreted tests useful without following links.
    this.pollTimer = setInterval(() => this.schedule(), 500);
    this.pollTimer.unref?.();
    for (const directory of this.directories) {
      const watcher = watchPath(this.sourcePath(directory), () => this.schedule());
      watcher.on("error", (error) => this.fail(error));
      this.watchers.push(watcher);
    }
  }

  async start() {
    await this.validateRoots();
    let recursiveWatchers = 0;
    for (const directory of this.directories) {
      if (this.installWatcher(this.sourcePath(directory))) {
        recursiveWatchers += 1;
      }
    }
    if (recursiveWatchers !== this.directories.length) {
      for (const watcher of this.watchers) {
        watcher.close();
      }
      this.watchers = [];
      this.installFallbackWatchers();
    }
    try {
      // Watchers are attached before the first scan.  The second snapshot in
      // reconcileUntilStable closes the initial-copy/event race.
      await this.reconcileUntilStable();
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  fail(error) {
    if (this.closed || this.failed) {
      return;
    }
    this.failed = error instanceof DevSourceMirrorError
      ? error
      : new DevSourceMirrorError("Source mirror watcher failed", { cause: error });
    if (typeof this.onError === "function") {
      this.onError(this.failed);
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const watcher of this.watchers.splice(0)) {
      watcher.close();
    }
    if (this.drainPromise) {
      await this.drainPromise.catch(() => {});
    }
  }
}

export async function mirrorDevSourcesOnce(options) {
  const mirror = new DevSourceMirror(options);
  try {
    await mirror.reconcileUntilStable();
  } finally {
    await mirror.close();
  }
}

export function createDevSourceMirror(options) {
  return new DevSourceMirror(options);
}

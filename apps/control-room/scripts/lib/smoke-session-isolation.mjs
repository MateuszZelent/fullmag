import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DISPOSABLE_SENTINEL = ".fullmag-smoke-disposable";
const CURRENT_SESSION_PATH = "/v2/sessions/current";

export function resolveSmokeApiBase({ apiBase, pageUrl }) {
  if (!apiBase) {
    return new URL(pageUrl).origin;
  }
  const base = new URL(apiBase);
  base.pathname = base.pathname.replace(/\/+$/, "").replace(/\/v2$/, "");
  base.search = "";
  base.hash = "";
  return (base.origin + base.pathname).replace(/\/$/, "");
}

export async function createSmokeMutationGuard({
  apiBase,
  env,
  fetchImpl = fetch,
  mutationRequired,
  pageUrl,
}) {
  if (!mutationRequired) {
    return createNoopGuard();
  }

  const declaredScriptPath = env.CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH;
  const declaredToken = env.CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN;
  if (!declaredScriptPath || !declaredToken) {
    throw new Error(
      "Viewport 3D smoke refuses to mutate an existing Control Room session. " +
        "Launch a disposable fixture and provide CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH " +
        "plus CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN.",
    );
  }

  const scriptPath = declaredScriptPath;
  assertDisposableFixtureProof(scriptPath, declaredToken);

  const response = await fetchImpl(
    `${resolveSmokeApiBase({ apiBase, pageUrl })}${CURRENT_SESSION_PATH}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(
      `Cannot verify disposable smoke session: ${response.status} ${await response.text()}`,
    );
  }
  const session = await response.json();
  const activeScriptPath =
    typeof session?.script_path === "string" ? session.script_path : null;
  if (activeScriptPath !== scriptPath) {
    throw new Error(
      "Active Control Room session does not own the declared disposable script: " +
        `active=${activeScriptPath ?? String(session?.script_path ?? "missing")} ` +
        `declared=${scriptPath}`,
    );
  }

  return createFileSnapshotGuard(scriptPath);
}

function assertDisposableFixtureProof(scriptPath, expectedToken) {
  const temporaryRoot = realpathSync(tmpdir());
  if (!isAbsolute(scriptPath) || resolve(scriptPath) !== scriptPath) {
    throw new Error(
      `Disposable smoke script path must be absolute and normalized: ${scriptPath}`,
    );
  }
  const scriptDirectory = dirname(scriptPath);
  const relativeToTemp = relative(temporaryRoot, scriptDirectory);
  if (
    relativeToTemp === "" ||
    relativeToTemp === ".." ||
    relativeToTemp.startsWith(`..${sep}`) ||
    resolve(temporaryRoot, relativeToTemp) !== scriptDirectory
  ) {
    throw new Error(
      `Disposable smoke script must live below the system temporary directory ${temporaryRoot}: ${scriptPath}`,
    );
  }

  assertPathHasNoSymbolicLinks(temporaryRoot, scriptPath);

  const sentinelPath = join(scriptDirectory, DISPOSABLE_SENTINEL);
  const sentinelToken = readFileSync(sentinelPath, "utf8").trim();
  if (!sentinelToken || sentinelToken !== expectedToken) {
    throw new Error(
      `Disposable smoke fixture proof is invalid at ${sentinelPath}.`,
    );
  }
}

function assertPathHasNoSymbolicLinks(root, target) {
  const relativePath = relative(root, target);
  let cursor = root;
  for (const component of relativePath.split(sep)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(
        `Disposable smoke script path must not contain symbolic links: ${cursor}`,
      );
    }
  }
}

function createFileSnapshotGuard(scriptPath) {
  const original = readFileSync(scriptPath);
  const originalMode = statSync(scriptPath).mode;
  const beforeSha256 = sha256(original);
  let active = true;

  const restoreAndVerify = () => {
    if (!active) {
      const afterSha256 = sha256(readFileSync(scriptPath));
      return { afterSha256, beforeSha256, restored: false };
    }
    const current = existsSync(scriptPath) ? readFileSync(scriptPath) : null;
    const restored = current == null || !current.equals(original);
    if (restored) {
      const restorePath = `${scriptPath}.fullmag-smoke-restore-${randomUUID()}`;
      writeFileSync(restorePath, original, { mode: originalMode });
      renameSync(restorePath, scriptPath);
    }
    const afterSha256 = sha256(readFileSync(scriptPath));
    if (afterSha256 !== beforeSha256) {
      throw new Error(
        `Disposable smoke script SHA-256 mismatch after restore: before=${beforeSha256} after=${afterSha256}`,
      );
    }
    active = false;
    return { afterSha256, beforeSha256, restored };
  };

  const installProcessGuards = () => {
    const onExit = () => {
      restoreAndVerify();
    };
    const onSigint = () => {
      try {
        restoreAndVerify();
        process.exit(130);
      } catch (error) {
        console.error(`Smoke fixture restore failed during SIGINT: ${error.message}`);
        process.exit(1);
      }
    };
    const onSigterm = () => {
      try {
        restoreAndVerify();
        process.exit(143);
      } catch (error) {
        console.error(`Smoke fixture restore failed during SIGTERM: ${error.message}`);
        process.exit(1);
      }
    };
    process.once("exit", onExit);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    return () => {
      process.off("exit", onExit);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
  };

  return {
    beforeSha256,
    installProcessGuards,
    restoreAndVerify,
    scriptPath,
  };
}

function createNoopGuard() {
  return {
    beforeSha256: null,
    installProcessGuards: () => () => {},
    restoreAndVerify: () => ({
      afterSha256: null,
      beforeSha256: null,
      restored: false,
    }),
    scriptPath: null,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

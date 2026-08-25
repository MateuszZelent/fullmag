import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SCRATCH_API_BASE,
  DEFAULT_SCRATCH_WORKSPACE_URL,
  runScratchAuthoringBrowser,
} from "./lib/scratch-authoring-browser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/scratch-authoring");
const fixture = JSON.parse(
  await readFile(resolve(root, "fdm.v1.json"), "utf8"),
);

try {
  const manifest = await runScratchAuthoringBrowser({
    backend: "fdm",
    fixture,
    apiBase: process.env.CONTROL_ROOM_API_BASE ?? DEFAULT_SCRATCH_API_BASE,
    workspaceUrl: process.env.CONTROL_ROOM_URL ?? DEFAULT_SCRATCH_WORKSPACE_URL,
  });
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}

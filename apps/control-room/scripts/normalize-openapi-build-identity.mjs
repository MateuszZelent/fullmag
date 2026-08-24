import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GENERATED_IDENTITY = Object.freeze({
  built_at_utc: "generated-artifact",
  git_commit: "generated-artifact",
  source_snapshot_sha256: "generated-artifact",
  worktree_state: "generated-artifact",
});

export function normalizeOpenApiBuildIdentity(document) {
  document["x-fullmag-build-identity"] = { ...GENERATED_IDENTITY };
}

async function main(path) {
  const document = JSON.parse(await readFile(path, "utf8"));
  normalizeOpenApiBuildIdentity(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}

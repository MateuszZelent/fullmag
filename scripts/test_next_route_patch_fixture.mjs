import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(
  process.env.FULLMAG_NEXT_ROUTE_PATCH_REPO_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const require = createRequire(import.meta.url);
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
assert.equal(nextPackage.version, "16.3.8");
const requireFromNext = createRequire(join(nextRoot, "package.json"));

const setupPath = join(
  nextRoot,
  "dist",
  "server",
  "lib",
  "router-utils",
  "setup-dev-bundler.js",
);
const setupSource = await readFile(
  process.env.FULLMAG_NEXT_CJS_SETUP_SOURCE_PATH ?? setupPath,
  "utf8",
);
assert.match(setupSource, /seedMissingAppFiles/u);

// Load the exact patched CJS handler, adding only an in-memory test export.
const requireModule = require("node:module");
const setupModule = new requireModule.Module(setupPath, null);
setupModule.filename = setupPath;
setupModule.paths = requireModule._nodeModulePaths(dirname(setupPath));
setupModule._compile(
  `${setupSource}\nmodule.exports.__fullmagSeedMissingAppFiles = seedMissingAppFiles;\n`,
  setupPath,
);
const seedMissingAppFiles = setupModule.exports.__fullmagSeedMissingAppFiles;
assert.equal(typeof seedMissingAppFiles, "function");

const { createValidFileMatcher } = requireFromNext(
  "./dist/server/lib/find-page-file.js",
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "fullmag-next-route-patch-"));
const appDir = join(fixtureRoot, "app");
const fileContents = new Map([
  ["page.tsx", "export default function Page() { return null; }\n"],
  ["[slug]/page.tsx", "export default function Dynamic() { return null; }\n"],
  ["workspace/layout.tsx", "export default function Layout({ children }) { return children; }\n"],
  ["workspace/route.ts", "export function GET() { return new Response(); }\n"],
  ["robots.txt", "User-agent: *\nAllow: /\n"],
  ["sitemap.xml", "<?xml version=\"1.0\"?><urlset />\n"],
  ["icon.png", "fixture-icon\n"],
  ["manifest.webmanifest", "{}\n"],
  ["sitemap.ts", "export default function sitemap() { return []; }\n"],
  ["_private/page.tsx", "export default function PrivatePage() { return null; }\n"],
  ["workspace/not-a-route.tsx", "export const helper = true;\n"],
]);

try {
  for (const [relativePath, contents] of fileContents) {
    const filePath = join(appDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  const matcher = createValidFileMatcher(["js", "jsx", "ts", "tsx"], appDir);
  const existingPath = join(appDir, "workspace", "layout.tsx");
  const existingMeta = { accuracy: 1, timestamp: 17 };
  const knownFiles = new Map([[existingPath, existingMeta]]);

  await seedMissingAppFiles(appDir, matcher, knownFiles);

  const expectedFiles = [
    "page.tsx",
    "[slug]/page.tsx",
    "workspace/layout.tsx",
    "workspace/route.ts",
    "robots.txt",
    "sitemap.xml",
    "icon.png",
    "manifest.webmanifest",
    "sitemap.ts",
  ].map((relativePath) => join(appDir, relativePath));
  assert.deepEqual(
    [...knownFiles.keys()].sort(),
    expectedFiles.sort(),
  );
  assert.strictEqual(knownFiles.get(existingPath), existingMeta);
  for (const filePath of expectedFiles) {
    const metadata = knownFiles.get(filePath);
    assert.equal(metadata?.accuracy, 1, filePath);
    assert.equal(typeof metadata?.timestamp, "number", filePath);
    await stat(filePath);
  }
  assert.equal(knownFiles.has(join(appDir, "_private", "page.tsx")), false);
  assert.equal(
    knownFiles.has(join(appDir, "workspace", "not-a-route.tsx")),
    false,
  );

  process.stdout.write(
    `patched Next route seed fixture PASS (${expectedFiles.length} files; metadata included)\n`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

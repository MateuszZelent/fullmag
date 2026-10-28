import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  bundleDocumentation,
  extractRelativeAssetPaths,
  findBuiltDocsSource,
  injectEmbedAssetsHtml,
  isSkipped,
  parseDocnamesFromSearchIndex,
} from "./bundle-docs.mjs";

const root = join("site", "_build", "html");

test("skips Sphinx sources and build bookkeeping at the site root", () => {
  assert.equal(isSkipped(root, join(root, "_sources")), true);
  assert.equal(isSkipped(root, join(root, "_sources", "index.md.txt")), true);
  assert.equal(isSkipped(root, join(root, ".doctrees", "env.pickle")), true);
  assert.equal(isSkipped(root, join(root, ".buildinfo")), true);
});

test("ships everything a reader or the search needs", () => {
  assert.equal(isSkipped(root, root), false);
  assert.equal(isSkipped(root, join(root, "index.html")), false);
  assert.equal(isSkipped(root, join(root, "searchindex.js")), false);
  assert.equal(isSkipped(root, join(root, "_static", "searchtools.js")), false);
  assert.equal(isSkipped(root, join(root, "physics", "_sources_overview.html")), false);
});

test("matches a directory named like the skipped ones only at the root", () => {
  assert.equal(isSkipped(root, join(root, "physics", "_sources")), false);
});

test("parses docnames from Sphinx searchindex.js", () => {
  const sample = `Search.setIndex({"docnames": ["index", "getting-started/index", "../unsafe", "_sources/ignored"], "filenames": ["index.md", "getting-started/index.md"]})`;
  assert.deepEqual(parseDocnamesFromSearchIndex(sample), [
    "index",
    "getting-started/index",
  ]);
});

test("extracts normalized relative asset paths from root and nested pages", () => {
  const html = `
    <link rel="stylesheet" href="../_static/fullmag-docs.css?v=123" />
    <script src="../_static/status-navigation.js"></script>
    <img src="../_images/diagram.png" />
    <a href="https://example.com/_static/external.js">External</a>
  `;
  assert.deepEqual(extractRelativeAssetPaths(html, "getting-started"), [
    "_static/fullmag-docs.css",
    "_static/status-navigation.js",
    "_images/diagram.png",
  ]);
});

test("injects embed CSS and JS links into HTML when missing", () => {
  const rawHtml = `<!DOCTYPE html><html><head><link rel="stylesheet" href="../_static/basic.css" /></head><body></body></html>`;
  const injected = injectEmbedAssetsHtml(rawHtml);
  assert.ok(injected.includes('href="../_static/fullmag-embed.css"'));
  assert.ok(injected.includes('src="../_static/fullmag-embed.js"'));
  assert.equal(injectEmbedAssetsHtml(injected), injected);
});

test("bundles local built docs and overlays fullmag-embed assets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "fullmag-docs-bundle-test-"));
  try {
    const fakeRepoRoot = join(tempRoot, "repo");
    const fakeBuildDir = join(fakeRepoRoot, "public_docs", "site", "_build", "html");
    const fakeStaticSourceDir = join(fakeRepoRoot, "public_docs", "site", "_static");
    const fakeTargetDir = join(fakeRepoRoot, "apps", "control-room", "public", "docs");

    await mkdir(join(fakeBuildDir, "getting-started"), { recursive: true });
    await mkdir(join(fakeBuildDir, "_sources"), { recursive: true });
    await mkdir(fakeStaticSourceDir, { recursive: true });

    await writeFile(
      join(fakeBuildDir, "index.html"),
      "<!DOCTYPE html><html><head><title>FullMag</title></head><body>Home</body></html>",
      "utf-8",
    );
    await writeFile(
      join(fakeBuildDir, "getting-started", "index.html"),
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="../_static/basic.css" /></head><body>Start</body></html>',
      "utf-8",
    );
    await writeFile(
      join(fakeBuildDir, "searchindex.js"),
      'Search.setIndex({"docnames":["index","getting-started/index"]})',
      "utf-8",
    );
    await writeFile(join(fakeBuildDir, "_sources", "index.md.txt"), "raw", "utf-8");
    await writeFile(join(fakeStaticSourceDir, "fullmag-embed.css"), "/* embed css */", "utf-8");
    await writeFile(join(fakeStaticSourceDir, "fullmag-embed.js"), "// embed js", "utf-8");

    const res = await bundleDocumentation({
      ifPresent: true,
      build: false,
      noFetch: true,
      currentRepoRoot: fakeRepoRoot,
      staticSourceDir: fakeStaticSourceDir,
      targetDir: fakeTargetDir,
    });

    assert.equal(res.mode, "local");
    const rootIndex = await readFile(join(fakeTargetDir, "index.html"), "utf-8");
    const nestedIndex = await readFile(
      join(fakeTargetDir, "getting-started", "index.html"),
      "utf-8",
    );
    const embedCss = await readFile(
      join(fakeTargetDir, "_static", "fullmag-embed.css"),
      "utf-8",
    );
    const embedJs = await readFile(
      join(fakeTargetDir, "_static", "fullmag-embed.js"),
      "utf-8",
    );

    assert.ok(rootIndex.includes('href="_static/fullmag-embed.css"'));
    assert.ok(rootIndex.includes('src="_static/fullmag-embed.js"'));
    assert.ok(nestedIndex.includes('href="../_static/fullmag-embed.css"'));
    assert.ok(nestedIndex.includes('src="../_static/fullmag-embed.js"'));
    assert.equal(embedCss, "/* embed css */");
    assert.equal(embedJs, "// embed js");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejects stale local _build/html that lacks fullmag-embed assets when conf.py is present", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "fullmag-docs-stale-test-"));
  try {
    const fakeRepoRoot = join(tempRoot, "repo");
    const fakeSiteDir = join(fakeRepoRoot, "public_docs", "site");
    const fakeBuildDir = join(fakeSiteDir, "_build", "html");

    await mkdir(join(fakeSiteDir, "physics"), { recursive: true });
    await mkdir(join(fakeSiteDir, "changelog"), { recursive: true });
    await mkdir(join(fakeBuildDir, "physics"), { recursive: true });
    await mkdir(join(fakeBuildDir, "changelog"), { recursive: true });
    await mkdir(join(fakeBuildDir, "_static"), { recursive: true });

    await writeFile(join(fakeSiteDir, "conf.py"), "# conf", "utf-8");
    await writeFile(join(fakeSiteDir, "physics", "index.md"), "# physics", "utf-8");
    await writeFile(join(fakeSiteDir, "changelog", "index.md"), "# changelog", "utf-8");
    await writeFile(join(fakeBuildDir, "index.html"), "<html></html>", "utf-8");
    await writeFile(join(fakeBuildDir, "searchindex.js"), "Search.setIndex({})", "utf-8");
    await writeFile(join(fakeBuildDir, "physics", "index.html"), "<html></html>", "utf-8");
    await writeFile(join(fakeBuildDir, "changelog", "index.html"), "<html></html>", "utf-8");

    const staleCandidate = await findBuiltDocsSource({
      currentRepoRoot: fakeRepoRoot,
      explicitBuildDir: fakeBuildDir,
    });
    assert.equal(staleCandidate, null);

    await writeFile(join(fakeBuildDir, "_static", "fullmag-embed.css"), "/* css */", "utf-8");
    await writeFile(join(fakeBuildDir, "_static", "fullmag-embed.js"), "// js", "utf-8");

    const validCandidate = await findBuiltDocsSource({
      currentRepoRoot: fakeRepoRoot,
      explicitBuildDir: fakeBuildDir,
    });
    assert.equal(validCandidate, fakeBuildDir);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

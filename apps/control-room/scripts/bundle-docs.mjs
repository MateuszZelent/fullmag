import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle the public Sphinx documentation into `apps/control-room/public/docs/`
// so `/docs/` works locally inside the Control Room (including client-side
// search, theme sync, and navigation tracking).
//
// Resolution order:
// 1. If `--build` is passed, run `sphinx-build` first (optionally bootstrapping
//    `.fullmag/docs-venv` when `--bootstrap-venv` is passed).
// 2. Copy from a local Sphinx build directory (`public_docs/site/_build/html`
//    in the current checkout or the main Git checkout when running inside a
//    worktree).
// 3. Otherwise try running `sphinx-build` if available on the host.
// 4. Otherwise (unless `--no-fetch` or `FULLMAG_DOCS_NO_FETCH=1` is set),
//    automatically download the published documentation from
//    `https://fullmag.mzelent.pl/` (or `FULLMAG_DOCS_URL`).
// 5. Overlay tracked `public_docs/site/_static/fullmag-embed.{css,js}` and
//    ensure every bundled HTML file includes them.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const controlRoomRoot = resolve(scriptDir, "..");
const repoRoot = resolve(controlRoomRoot, "../..");
const sphinxSourceDir = resolve(repoRoot, "public_docs/site");
const sphinxStaticDir = resolve(sphinxSourceDir, "_static");
const defaultBuildDir = resolve(sphinxSourceDir, "_build/html");
const defaultTargetDir = resolve(controlRoomRoot, "public/docs");

export const DEFAULT_ONLINE_DOCS_URL = "https://fullmag.mzelent.pl/";

// The Sphinx sources and build bookkeeping are not needed to read or search.
const SKIPPED = new Set(["_sources", ".doctrees", ".buildinfo"]);

const CORE_SPHINX_ASSETS = [
  "_static/basic.css",
  "_static/pygments.css",
  "_static/pygments_dark.css",
  "_static/main.css",
  "_static/copybutton.css",
  "_static/sphinx-design.min.css",
  "_static/fullmag-docs.css",
  "_static/page-last-modified.css",
  "_static/documentation-changelog.css",
  "_static/fullmag-embed.css",
  "_static/documentation_options.js",
  "_static/doctools.js",
  "_static/sphinx_highlight.js",
  "_static/clipboard.min.js",
  "_static/copybutton.js",
  "_static/copybutton_funcs.js",
  "_static/design-tabs.js",
  "_static/language_data.js",
  "_static/searchtools.js",
  "_static/status-navigation.js",
  "_static/fullmag-embed.js",
];

/** True for an entry directly under the site root that must not be shipped. */
export function isSkipped(root, entry) {
  const first = relative(root, entry).split(sep)[0];
  return first !== undefined && SKIPPED.has(first);
}

/**
 * Extract the `docnames` list from Sphinx's `searchindex.js` (`Search.setIndex(...)`).
 */
export function parseDocnamesFromSearchIndex(searchIndexContent) {
  if (typeof searchIndexContent !== "string" || !searchIndexContent.trim()) {
    return [];
  }

  const sanitize = (items) =>
    Array.from(
      new Set(
        items
          .filter((item) => typeof item === "string")
          .map((item) => item.trim().replace(/^\/+|\/+$/g, ""))
          .filter(
            (item) =>
              item.length > 0 &&
              !item.includes("..") &&
              !item.includes("\\") &&
              !item.startsWith("_"),
          ),
      ),
    );

  const prefixMatch = searchIndexContent.match(/Search\.setIndex\s*\(\s*/);
  if (prefixMatch && prefixMatch.index !== undefined) {
    const startIdx = prefixMatch.index + prefixMatch[0].length;
    const endIdx = searchIndexContent.lastIndexOf(")");
    if (endIdx > startIdx) {
      const jsonCandidate = searchIndexContent.slice(startIdx, endIdx).trim();
      try {
        const parsed = JSON.parse(jsonCandidate);
        if (parsed && Array.isArray(parsed.docnames)) {
          return sanitize(parsed.docnames);
        }
      } catch {
        // Fall through to regex extraction if searchindex.js is non-standard JSON.
      }
    }
  }

  const arrayMatch = searchIndexContent.match(/"docnames"\s*:\s*\[([^\]]*)\]/);
  if (!arrayMatch) {
    return [];
  }

  const matches = Array.from(arrayMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g), (m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  });
  return sanitize(matches);
}

/**
 * Extract relative Sphinx asset paths (`_static/...`, `_images/...`,
 * `_sphinx_design_static/...`) referenced in HTML or CSS content.
 */
export function extractRelativeAssetPaths(content, pageDir = "") {
  if (typeof content !== "string" || !content) {
    return [];
  }

  const normalizedPageDir = pageDir
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const results = new Set();

  const maybeAdd = (rawRef) => {
    if (!rawRef || typeof rawRef !== "string") {
      return;
    }
    const trimmed = rawRef
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .split(/[?#]/, 1)[0]
      .trim();
    if (
      !trimmed ||
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("javascript:")
    ) {
      return;
    }

    const joined = normalizedPageDir
      ? posix.normalize(posix.join(normalizedPageDir, trimmed))
      : posix.normalize(trimmed);
    const cleaned = joined.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    if (
      cleaned.startsWith("..") ||
      cleaned.includes("/../") ||
      !(
        cleaned.startsWith("_static/") ||
        cleaned.startsWith("_images/") ||
        cleaned.startsWith("_sphinx_design_static/")
      )
    ) {
      return;
    }
    results.add(cleaned);
  };

  for (const match of content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    maybeAdd(match[1]);
  }
  for (const match of content.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) {
    maybeAdd(match[1]);
  }

  return Array.from(results);
}

/**
 * Ensure an HTML document references `_static/fullmag-embed.css` and
 * `_static/fullmag-embed.js` so older Sphinx builds or downloaded pages still
 * participate in Control Room theme sync and navigation.
 */
export function injectEmbedAssetsHtml(html, relativePrefix = "") {
  if (typeof html !== "string" || !html.includes("</head>")) {
    return html;
  }

  let prefix = relativePrefix;
  if (!prefix) {
    const existingStaticMatch = html.match(
      /\b(?:href|src)=["']((?:\.\.\/)*)_static\//i,
    );
    if (existingStaticMatch) {
      prefix = existingStaticMatch[1] ?? "";
    }
  }

  const cssHref = `${prefix}_static/fullmag-embed.css`;
  const jsSrc = `${prefix}_static/fullmag-embed.js`;

  let updated = html;
  if (!updated.includes("fullmag-embed.css")) {
    updated = updated.replace(
      "</head>",
      `  <link rel="stylesheet" type="text/css" href="${cssHref}" />\n</head>`,
    );
  }
  if (!updated.includes("fullmag-embed.js")) {
    updated = updated.replace(
      "</head>",
      `  <script src="${jsSrc}"></script>\n</head>`,
    );
  }
  return updated;
}

export async function hasBuiltDocs(dir) {
  try {
    const indexStat = await stat(join(dir, "index.html"));
    const searchStat = await stat(join(dir, "searchindex.js"));
    return indexStat.isFile() && searchStat.isFile();
  } catch {
    return false;
  }
}

function resolveMainCheckoutRoot(currentRepoRoot = repoRoot) {
  try {
    const res = spawnSync(
      "git",
      ["-C", currentRepoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (res.status !== 0 || !res.stdout) {
      return null;
    }
    const commonDir = res.stdout.trim();
    if (!commonDir) {
      return null;
    }
    const mainRoot = dirname(commonDir);
    if (resolve(mainRoot) === resolve(currentRepoRoot)) {
      return null;
    }
    return mainRoot;
  } catch {
    return null;
  }
}

export async function findBuiltDocsSource({
  currentRepoRoot = repoRoot,
  explicitBuildDir = process.env.FULLMAG_DOCS_BUILD_DIR,
} = {}) {
  const candidates = [];
  if (explicitBuildDir) {
    candidates.push(resolve(explicitBuildDir));
  }
  candidates.push(
    resolve(currentRepoRoot, "public_docs/site/_build/html"),
    resolve(currentRepoRoot, "public_docs/site/_build"),
  );

  const mainRoot = resolveMainCheckoutRoot(currentRepoRoot);
  if (mainRoot) {
    candidates.push(
      resolve(mainRoot, "public_docs/site/_build/html"),
      resolve(mainRoot, "public_docs/site/_build"),
      resolve(mainRoot, "apps/control-room/public/docs"),
    );
  }

  const requiresV2Sections =
    existsSync(resolve(currentRepoRoot, "public_docs/site/conf.py")) &&
    existsSync(resolve(currentRepoRoot, "public_docs/site/physics/index.md")) &&
    existsSync(resolve(currentRepoRoot, "public_docs/site/changelog/index.md"));

  const checks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      valid:
        (await hasBuiltDocs(candidate)) &&
        (!requiresV2Sections ||
          (existsSync(join(candidate, "physics/index.html")) &&
            existsSync(join(candidate, "changelog/index.html")) &&
            existsSync(join(candidate, "_static/fullmag-embed.css")) &&
            existsSync(join(candidate, "_static/fullmag-embed.js")))),
    })),
  );
  return checks.find((entry) => entry.valid)?.candidate ?? null;
}

function findSphinxCommand(currentRepoRoot = repoRoot) {
  const isWin = process.platform === "win32";
  const binDir = isWin ? "Scripts" : "bin";
  const exeSuffix = isWin ? ".exe" : "";

  const roots = [currentRepoRoot];
  const mainRoot = resolveMainCheckoutRoot(currentRepoRoot);
  if (mainRoot) {
    roots.push(mainRoot);
  }

  if (process.env.FULLMAG_SPHINX_BUILD) {
    return { command: process.env.FULLMAG_SPHINX_BUILD, prefixArgs: [] };
  }

  for (const root of roots) {
    for (const venvName of [".fullmag/docs-venv", ".venv", "venv", ".fullmag/local/python"]) {
      const sphinxBin = resolve(root, venvName, binDir, `sphinx-build${exeSuffix}`);
      if (existsSync(sphinxBin)) {
        return { command: sphinxBin, prefixArgs: [] };
      }
    }
  }

  const directProbe = spawnSync("sphinx-build", ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (directProbe.status === 0) {
    return { command: "sphinx-build", prefixArgs: [] };
  }

  for (const pyCmd of ["python3", "python"]) {
    const probe = spawnSync(pyCmd, ["-m", "sphinx", "--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (probe.status === 0) {
      return { command: pyCmd, prefixArgs: ["-m", "sphinx"] };
    }
  }

  return null;
}

function bootstrapDocsVenv(currentRepoRoot = repoRoot) {
  const isWin = process.platform === "win32";
  const binDir = isWin ? "Scripts" : "bin";
  const exeSuffix = isWin ? ".exe" : "";
  const venvDir = resolve(currentRepoRoot, ".fullmag/docs-venv");
  const requirementsPath = resolve(currentRepoRoot, "public_docs/site/requirements.txt");

  if (!existsSync(requirementsPath)) {
    return null;
  }

  let pyCmd = null;
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (probe.status === 0) {
      pyCmd = candidate;
      break;
    }
  }
  if (!pyCmd) {
    return null;
  }

  const venvPython = resolve(venvDir, binDir, `python${exeSuffix}`);
  if (!existsSync(venvPython)) {
    console.log(`docs:bundle: creating Python venv for Sphinx at ${venvDir}...`);
    const createRes = spawnSync(pyCmd, ["-m", "venv", venvDir], { stdio: "inherit" });
    if (createRes.status !== 0) {
      return null;
    }
  }

  console.log(`docs:bundle: installing Sphinx requirements from ${requirementsPath}...`);
  const pipRes = spawnSync(
    venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
    { stdio: "inherit" },
  );
  if (pipRes.status !== 0) {
    return null;
  }

  const sphinxBin = resolve(venvDir, binDir, `sphinx-build${exeSuffix}`);
  if (existsSync(sphinxBin)) {
    return { command: sphinxBin, prefixArgs: [] };
  }
  return { command: venvPython, prefixArgs: ["-m", "sphinx"] };
}

export async function tryBuildSphinxDocs({
  currentRepoRoot = repoRoot,
  outputDir = resolve(currentRepoRoot, "public_docs/site/_build/html"),
  bootstrapVenv = false,
} = {}) {
  const siteDir = resolve(currentRepoRoot, "public_docs/site");
  if (!existsSync(resolve(siteDir, "conf.py"))) {
    return null;
  }

  let runner = findSphinxCommand(currentRepoRoot);
  if (!runner && bootstrapVenv) {
    runner = bootstrapDocsVenv(currentRepoRoot);
  }
  if (!runner) {
    return null;
  }

  console.log(`docs:bundle: building Sphinx documentation into ${outputDir}...`);
  const buildRes = spawnSync(
    runner.command,
    [...runner.prefixArgs, "-b", "html", siteDir, outputDir],
    {
      cwd: currentRepoRoot,
      stdio: "inherit",
    },
  );
  if (buildRes.status === 0 && (await hasBuiltDocs(outputDir))) {
    return outputDir;
  }
  return null;
}

async function collectHtmlFiles(dir, currentRel = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectHtmlFiles(fullPath, relPath);
      }
      if (entry.isFile() && entry.name.endsWith(".html")) {
        return [{ fullPath, relPath }];
      }
      return [];
    }),
  );
  return nested.flat();
}

export async function ensureEmbedAssets(
  targetDir = defaultTargetDir,
  staticSourceDir = sphinxStaticDir,
) {
  const targetStaticDir = join(targetDir, "_static");
  await mkdir(targetStaticDir, { recursive: true });

  await Promise.all(
    [
      "fullmag-embed.css",
      "fullmag-embed.js",
      "fullmag-docs.css",
      "documentation-changelog.css",
      "page-last-modified.css",
      "status-navigation.js",
    ].map(
      async (assetName) => {
        const srcAsset = join(staticSourceDir, assetName);
        if (existsSync(srcAsset)) {
          await cp(srcAsset, join(targetStaticDir, assetName), { force: true });
        }
      },
    ),
  );

  const htmlFiles = await collectHtmlFiles(targetDir);
  await Promise.all(
    htmlFiles.map(async ({ fullPath, relPath }) => {
      const depth = relPath.split("/").length - 1;
      const relativePrefix = depth > 0 ? "../".repeat(depth) : "";
      const original = await readFile(fullPath, "utf-8");
      const updated = injectEmbedAssetsHtml(original, relativePrefix);
      if (updated !== original) {
        await writeFile(fullPath, updated, "utf-8");
      }
    }),
  );
}

async function fetchWithTimeout(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "FullMag-ControlRoom-DocsBundler/1.0",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function runConcurrent(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        await worker(next);
      }
    }
  });
  await Promise.all(workers);
}

export async function fetchOnlineDocsToTarget({
  targetDir = defaultTargetDir,
  onlineUrl = process.env.FULLMAG_DOCS_URL || DEFAULT_ONLINE_DOCS_URL,
  staticSourceDir = sphinxStaticDir,
} = {}) {
  const baseUrl = onlineUrl.endsWith("/") ? onlineUrl : `${onlineUrl}/`;
  const stagingDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    const searchIndexUrl = new URL("searchindex.js", baseUrl).href;
    const searchIndexRes = await fetchWithTimeout(searchIndexUrl);
    if (!searchIndexRes.ok) {
      throw new Error(`HTTP ${searchIndexRes.status} when fetching ${searchIndexUrl}`);
    }
    const searchIndexText = await searchIndexRes.text();
    await writeFile(join(stagingDir, "searchindex.js"), searchIndexText, "utf-8");

    const docnames = parseDocnamesFromSearchIndex(searchIndexText);
    const htmlPaths = Array.from(
      new Set([
        "index.html",
        "search.html",
        "genindex.html",
        ...docnames.map((doc) => (doc.endsWith(".html") ? doc : `${doc}.html`)),
      ]),
    );

    const discoveredAssets = new Set(CORE_SPHINX_ASSETS);

    await runConcurrent(htmlPaths, 12, async (relHtmlPath) => {
      const pageUrl = new URL(relHtmlPath, baseUrl).href;
      try {
        const res = await fetchWithTimeout(pageUrl);
        if (!res.ok) {
          if (relHtmlPath === "index.html") {
            throw new Error(`HTTP ${res.status} when fetching ${pageUrl}`);
          }
          return;
        }
        const html = await res.text();
        const destPath = join(stagingDir, ...relHtmlPath.split("/"));
        await mkdir(dirname(destPath), { recursive: true });
        await writeFile(destPath, html, "utf-8");

        const pageDir = posix.dirname(relHtmlPath);
        for (const assetPath of extractRelativeAssetPaths(
          html,
          pageDir === "." ? "" : pageDir,
        )) {
          discoveredAssets.add(assetPath);
        }
      } catch (err) {
        if (relHtmlPath === "index.html") {
          throw err;
        }
      }
    });

    if (!(await hasBuiltDocs(stagingDir))) {
      throw new Error("Downloaded documentation is incomplete (missing index.html or searchindex.js).");
    }

    // Optional objects.inv for completeness
    try {
      const invRes = await fetchWithTimeout(new URL("objects.inv", baseUrl).href);
      if (invRes.ok) {
        const buf = Buffer.from(await invRes.arrayBuffer());
        await writeFile(join(stagingDir, "objects.inv"), buf);
      }
    } catch {
      // Optional inventory file.
    }

    const fetchedAssets = new Set();
    const pendingAssets = Array.from(discoveredAssets);

    while (pendingAssets.length > 0) {
      const batch = pendingAssets.splice(0, pendingAssets.length);
      await runConcurrent(batch, 12, async (relAssetPath) => {
        if (fetchedAssets.has(relAssetPath)) {
          return;
        }
        fetchedAssets.add(relAssetPath);

        const assetUrl = new URL(relAssetPath, baseUrl).href;
        try {
          const res = await fetchWithTimeout(assetUrl);
          if (!res.ok) {
            return;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const destPath = join(stagingDir, ...relAssetPath.split("/"));
          await mkdir(dirname(destPath), { recursive: true });
          await writeFile(destPath, buf);

          if (relAssetPath.endsWith(".css")) {
            const cssText = buf.toString("utf-8");
            const cssDir = posix.dirname(relAssetPath);
            for (const nestedAsset of extractRelativeAssetPaths(
              cssText,
              cssDir === "." ? "" : cssDir,
            )) {
              if (!fetchedAssets.has(nestedAsset)) {
                pendingAssets.push(nestedAsset);
              }
            }
          }
        } catch {
          // Ignore optional/missing remote asset files.
        }
      });
    }

    await ensureEmbedAssets(stagingDir, staticSourceDir);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(dirname(targetDir), { recursive: true });
    await rename(stagingDir, targetDir);
    return targetDir;
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export async function bundleDocumentation({
  ifPresent = process.argv.includes("--if-present"),
  build = process.argv.includes("--build"),
  bootstrapVenv = process.argv.includes("--bootstrap-venv") || process.argv.includes("--build"),
  fetchOnly = process.argv.includes("--fetch-only"),
  noFetch =
    process.argv.includes("--no-fetch") || process.env.FULLMAG_DOCS_NO_FETCH === "1",
  targetDir = defaultTargetDir,
  currentRepoRoot = repoRoot,
  staticSourceDir = sphinxStaticDir,
  onlineUrl = process.env.FULLMAG_DOCS_URL || DEFAULT_ONLINE_DOCS_URL,
} = {}) {
  let sourceDir = null;

  if (!fetchOnly) {
    if (build) {
      sourceDir = await tryBuildSphinxDocs({
        currentRepoRoot,
        outputDir: resolve(currentRepoRoot, "public_docs/site/_build/html"),
        bootstrapVenv,
      });
    }

    if (!sourceDir) {
      sourceDir = await findBuiltDocsSource({ currentRepoRoot });
    }

    if (!sourceDir) {
      sourceDir = await tryBuildSphinxDocs({
        currentRepoRoot,
        outputDir: resolve(currentRepoRoot, "public_docs/site/_build/html"),
        bootstrapVenv: false,
      });
    }
  }

  if (sourceDir) {
    if (resolve(sourceDir) !== resolve(targetDir)) {
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      await cp(sourceDir, targetDir, {
        recursive: true,
        filter: (entry) => !isSkipped(sourceDir, entry),
      });
    }
    await ensureEmbedAssets(targetDir, staticSourceDir);
    console.log(`Bundled documentation from ${sourceDir} into ${targetDir}`);
    return { mode: "local", sourceDir, targetDir };
  }

  const requiresV2Sections =
    existsSync(resolve(currentRepoRoot, "public_docs/site/conf.py")) &&
    existsSync(resolve(currentRepoRoot, "public_docs/site/physics/index.md")) &&
    existsSync(resolve(currentRepoRoot, "public_docs/site/changelog/index.md"));
  const hasCurrentTargetDocs =
    (await hasBuiltDocs(targetDir)) &&
    (!requiresV2Sections ||
      (existsSync(join(targetDir, "physics/index.html")) &&
        existsSync(join(targetDir, "changelog/index.html")) &&
        existsSync(join(targetDir, "_static/fullmag-embed.css")) &&
        existsSync(join(targetDir, "_static/fullmag-embed.js"))));

  if (!fetchOnly && hasCurrentTargetDocs) {
    await ensureEmbedAssets(targetDir, staticSourceDir);
    console.log(`Using existing bundled documentation in ${targetDir}`);
    return { mode: "existing", sourceDir: targetDir, targetDir };
  }

  if (!noFetch) {
    try {
      console.log(
        `docs:bundle: no local Sphinx build found; downloading published documentation from ${onlineUrl}...`,
      );
      await fetchOnlineDocsToTarget({ targetDir, onlineUrl, staticSourceDir });
      console.log(`Downloaded and bundled documentation from ${onlineUrl} into ${targetDir}`);
      return { mode: "online", sourceDir: onlineUrl, targetDir };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ifPresent) {
        console.log(
          `docs:bundle: could not download documentation from ${onlineUrl} (${message}); the app will fall back to online proxy/links.`,
        );
        return { mode: "skipped", sourceDir: null, targetDir };
      }
      console.error(
        `Failed to bundle documentation locally or download from ${onlineUrl}: ${message}\n` +
          `Build it locally with: sphinx-build -b html ${defaultBuildDir}`,
      );
      process.exitCode = 1;
      return { mode: "failed", sourceDir: null, targetDir };
    }
  }

  if (ifPresent) {
    console.log(
      "docs:bundle: no built documentation found; the app will link to the online docs.",
    );
    return { mode: "skipped", sourceDir: null, targetDir };
  }

  console.error(
    `No built documentation at ${defaultBuildDir}.\n` +
      "Build it first: sphinx-build -b html public_docs/site public_docs/site/_build/html",
  );
  process.exitCode = 1;
  return { mode: "failed", sourceDir: null, targetDir };
}

// Run only when invoked as a script, so helpers can be imported by tests.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await bundleDocumentation();
}

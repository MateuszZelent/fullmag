import { cp, mkdir, rm, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Copy the built Sphinx site into the control room's static assets so the
// documentation, including Sphinx's client-side search, ships inside the app
// and works offline. The site is built separately (see public_docs/site):
//   sphinx-build -b html public_docs/site public_docs/site/_build/html
// The app degrades to a link to the online docs when this has not been run.
//
// `--if-present` is for build routes (the `build` script): bundle when a built
// site exists, otherwise say so and carry on, so a host without Sphinx still
// builds the app.

const ifPresent = process.argv.includes("--if-present");

const source = fileURLToPath(new URL("../../../public_docs/site/_build/html/", import.meta.url));
const target = fileURLToPath(new URL("../public/docs/", import.meta.url));

// The Sphinx sources and build bookkeeping are not needed to read or search.
const SKIPPED = new Set(["_sources", ".doctrees", ".buildinfo"]);

/** True for an entry directly under the site root that must not be shipped. */
export function isSkipped(root, entry) {
  const first = relative(root, entry).split(sep)[0];
  return first !== undefined && SKIPPED.has(first);
}

async function main() {
  try {
    await stat(`${source}index.html`);
    await stat(`${source}searchindex.js`);
  } catch {
    if (ifPresent) {
      console.log("docs:bundle: no built documentation found; the app will link to the online docs.");
      return;
    }
    console.error(
      `No built documentation at ${source}.\n` +
        "Build it first: sphinx-build -b html public_docs/site public_docs/site/_build/html",
    );
    process.exitCode = 1;
    return;
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, {
    recursive: true,
    filter: (entry) => !isSkipped(source, entry),
  });
  console.log(`Bundled documentation into ${target}`);
}

// Run only when invoked as a script, so the filter can be imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

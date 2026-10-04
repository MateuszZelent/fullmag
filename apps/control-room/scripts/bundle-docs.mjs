import { cp, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Copy the built Sphinx site into the control room's static assets so the
// documentation, including Sphinx's client-side search, ships inside the app
// and works offline. The site is built separately (see public_docs/site):
//   sphinx-build -b html public_docs/site public_docs/site/_build/html
// The app degrades to a link to the online docs when this has not been run.

const source = fileURLToPath(new URL("../../../public_docs/site/_build/html/", import.meta.url));
const target = fileURLToPath(new URL("../public/docs/", import.meta.url));

try {
  await stat(`${source}index.html`);
  await stat(`${source}searchindex.js`);
} catch {
  console.error(
    `No built documentation at ${source}.\n` +
      "Build it first: sphinx-build -b html public_docs/site public_docs/site/_build/html",
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
// The Sphinx sources and build bookkeeping are not needed to read or search.
await cp(source, target, {
  recursive: true,
  filter: (entry) => !/[\/](_sources|\.doctrees|\.buildinfo)([\/]|$)/.test(entry),
});
console.log(`Bundled documentation into ${target}`);

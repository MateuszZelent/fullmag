# Documentation inside the app

The public Sphinx documentation (`public_docs/site`) is available from the
Fullmag start screen and from **Help → Search Docs** (`F1`), with Sphinx's own
search, offline.

## How it works

- The control room serves the built HTML under `/docs/` from
  `apps/control-room/public/docs/` (git-ignored).
- The **Docs** section of the start screen shows it in a frame. Its search box
  opens Sphinx's `search.html?q=…`, so results, stemming and highlighting are the
  documentation's own and need no server (`searchindex.js` is client-side).
- Over an open workspace the start screen is laid on top, so reading the
  documentation never closes a project.
- When `/docs/index.html` is not served, the section says so and links to the
  online site (`https://fullmag.mzelent.pl/`, see `public_docs/site/CNAME`).

## Bundling it

```bash
sphinx-build -b html public_docs/site public_docs/site/_build/html
pnpm --dir apps/control-room docs:bundle
```

`docs:bundle` copies the built site (without `_sources`) into
`apps/control-room/public/docs/`. Build the site first; the strict CI build is in
`.github/workflows/documentation.yml`.

## Not yet done

The bundle is not produced by the app's build or packaging recipes: wiring
`docs:bundle` into the Windows, desktop and CI routes is a separate step (it needs
Python and the Sphinx requirements on the build host). Until then a build that
does not run it shows the online link instead.

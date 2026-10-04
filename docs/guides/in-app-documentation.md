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

## In builds

`pnpm --dir apps/control-room build` runs `docs:bundle --if-present` first: when
`public_docs/site/_build/html` exists the site is bundled into the app, otherwise
the build carries on and the app links to the online documentation. This covers
the Windows static route, the MSI script and the release workflow. Build the
Sphinx site before the app build in any job that should ship offline docs.

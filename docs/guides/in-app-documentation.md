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

## Bundling, building, and online fallback

```bash
# Bundle from local Sphinx build, main checkout build, local sphinx-build,
# or automatically download from https://fullmag.mzelent.pl/
pnpm --dir apps/control-room docs:bundle

# Build Sphinx locally (bootstrapping .fullmag/docs-venv if needed) and bundle
pnpm --dir apps/control-room docs:build

# Explicitly download the published documentation from https://fullmag.mzelent.pl/
pnpm --dir apps/control-room docs:fetch
```

`docs:bundle` resolves the documentation in the following order:
1. A local Sphinx build in `public_docs/site/_build/html` (in the current checkout or the main Git checkout when working inside a worktree).
2. A local `sphinx-build` invocation when Sphinx is installed on the host (or via `docs:build` / `--build`, which bootstraps `.fullmag/docs-venv` from `public_docs/site/requirements.txt`).
3. An automatic download of the published documentation from `https://fullmag.mzelent.pl/` (unless `--no-fetch` or `FULLMAG_DOCS_NO_FETCH=1` is set).
4. In all cases, tracked `public_docs/site/_static/fullmag-embed.css` and `public_docs/site/_static/fullmag-embed.js` are overlaid into `apps/control-room/public/docs/_static/` and linked in every bundled HTML file.

## In development and builds

`pnpm --dir apps/control-room dev`, `dev:binary`, `build`, and `build:webpack` run `docs:bundle --if-present` automatically. In addition, when running Next.js in non-static-export mode (`next dev` / `next start`), `/docs/:path*` falls back to proxying `https://fullmag.mzelent.pl/:path*` on the same origin whenever a static file is not present under `apps/control-room/public/docs/`.

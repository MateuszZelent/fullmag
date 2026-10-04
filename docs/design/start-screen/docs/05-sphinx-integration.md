# Sphinx documentation inside the app

How the public documentation (`public_docs/site`, built with Sphinx) is reachable
from the Fullmag start screen and from an open workspace, with search, offline.
It extends `01-design-spec.md` (§3.2 Navigation, §6.6 Documentation) and is the
contract between the app and the documentation site.

---

## 1. Why

A physicist stuck on a parameter wants the page about it, not a browser tab on a
cluster login node. The documentation already exists, is built strictly in CI
(`.github/workflows/documentation.yml`, `sphinx-build -W -n`) and ships Sphinx's
own client-side search. Bringing it into the app costs a frame and a bundle step;
rebuilding it as app UI would cost a second source of truth.

Goals:

1. **Offline.** Everything needed to read and search is a static file.
2. **One source.** The app shows the site; it never copies or re-renders its text.
3. **The documentation's own search.** Stemming, ranking, highlighting and result
   summaries come from Sphinx, not from a re-implementation.
4. **Never blocks the work.** No bundle, no network, a broken page: the section
   degrades to a message and a link, and the rest of the app is unaffected.
5. **Reachable from anywhere.** `F1` and Help → Search Docs, over an open
   workspace as well as on the start screen.

Non-goals: editing documentation in the app, versioned documentation switching,
a second search index, and rendering Markdown in the renderer.

---

## 2. Shape

```
public_docs/site (Sphinx, sphinx_clarity_theme)
        │  sphinx-build -b html
        ▼
public_docs/site/_build/html ──docs:bundle──▶ apps/control-room/public/docs/   (git-ignored)
                                                       │ served as /docs/
                                                       ▼
start screen › Docs section ── <iframe src="/docs/…"> ◀── postMessage ──▶ fullmag-embed.js
   search box ─▶ /docs/search.html?q=…                       (theme, navigation, ready)
```

| Piece | Where | Role |
|---|---|---|
| Docs section | `modules/start/sections/DocsSection.tsx` | query box, **Contents**, **Open online**, the frame, the unavailable state |
| Pure model | `modules/start/model/docs.ts` | URLs, availability probe, message parsing, online link |
| Embed script | `public_docs/site/_static/fullmag-embed.js` | runs only when framed; theme, link handling, navigation reports |
| Embed styles | `public_docs/site/_static/fullmag-embed.css` | hides what the app already provides |
| Bundle script | `apps/control-room/scripts/bundle-docs.mjs` | copies the built site into `public/docs/` |
| Commands | `start.section.docs`, `workspace.search-docs` | rail item; `F1` / Help menu |

---

## 3. Entry points

| Entry | Behaviour |
|---|---|
| Rail → **Docs** | `start.section.docs`; the section takes the full content width and hides the inspector |
| `F1`, **Help → Search Docs** | `workspace.search-docs`: selects the Docs section and lays the start screen over an open workspace (`homeView.open()`), so reading never closes a project |
| Command palette | both commands appear in `Ctrl ⇧ P` |
| About → *Open the documentation* | switches to the Docs section |

Over a workspace the start screen is a visit, not a mode: opening a project or a
session change ends it, and the workspace beneath stays mounted (see
`kernel/layout/homeView.ts`).

---

## 4. Search

The query box does not search anything itself. Submitting it points the frame at
Sphinx's search page:

```
/docs/search.html?q=<encodeURIComponent(query)>
```

`searchindex.js` is loaded by that page and queried in the browser, so it works
offline and the results are exactly what the published site would show. An empty
query opens the documentation home. `docsSearchUrl()` is the single place that
builds the URL.

Why not search in the renderer: Sphinx stores *stemmed* terms in the index; a
second implementation would need the same stemmer and would silently disagree
with the published site.

---

## 5. The contract between app and site

Both sides are the same origin (`/docs/` is served by the control room), and each
checks that, so neither trusts a message from anywhere else.

### 5.1 Messages

| Direction | Message | When |
|---|---|---|
| docs → app | `{ source: "fullmag-docs", type: "ready" }` | after every page load |
| docs → app | `{ source: "fullmag-docs", type: "navigated", path, title }` | after every page load; `path` is relative to the docs root |
| app → docs | `{ source: "fullmag-app", type: "theme", theme: "dark" \| "light" }` | on `ready`, on frame load and whenever the app theme changes |

### 5.2 Rules

- The app listens only to the frame it owns (`event.source` is the frame's
  `contentWindow`) and only on its own origin; the site accepts theme messages
  only from `window.parent` on its own origin.
- `parseDocsMessage()` accepts **only** the two documented docs messages and
  re-validates every field. A page the docs link to cannot steer the app by
  posting something shaped almost right.
- The app addresses the frame with `window.location.origin`, never `"*"`.
- The site announces nothing and changes nothing when it is not framed
  (`window.parent === window`), so the published site is unaffected.

### 5.3 What embedded mode changes in the site

`html[data-fullmag-embedded]` is set only when framed.

- **Theme.** The Clarity theme already keys off `data-theme` and exposes
  `updatePygmentsTheme`; the embed script sets the former and calls the latter, so
  prose and code highlighting follow the app's light/dark theme without a reload.
- **Hidden:** the build stamp, the theme toggle and the announcement bar. The app
  provides search, the contents link, the theme and the online link. The site
  navigation and side tree stay: leaving them would strand a reader on a page.
- **Links.** A link that leaves the site opens in a new tab (`noopener`), so a
  reference never replaces the documentation in the app.

### 5.4 Online link

`Open online` follows the reader: the `navigated` path is appended to the
published origin (`https://fullmag.mzelent.pl/`, from `public_docs/site/CNAME`),
so the link opens the same page. `onlineDocsUrl()` falls back to the home page for
an empty path, a `..` segment or an absolute URL.

---

## 6. Bundling

```bash
sphinx-build -b html public_docs/site public_docs/site/_build/html
pnpm --dir apps/control-room docs:bundle
```

`docs:bundle` requires `index.html` and `searchindex.js` in the built site (it
exits with the build command otherwise), clears `public/docs/`, and copies the
site without `_sources` and build bookkeeping. `apps/control-room/public/docs/`
is git-ignored: the bundle is a build artefact, never source.

Sphinx needs the requirements in `public_docs/site/requirements.txt`; a build host
without them simply does not bundle, and the app shows the online link.

### 6.1 Not wired yet

`docs:bundle` is not part of the Windows (`windows-ui static`), desktop or CI
build routes. Those recipes are governed by the build-storage policy (preflight,
resolver, lease), and adding a Python/Sphinx dependency to them is a decision for
whoever owns them, not a side effect of this feature. Until then a build that does
not run it shows the unavailable state.

---

## 7. Degradation

| Situation | Behaviour |
|---|---|
| `/docs/index.html` answers | frame, query box and **Contents** enabled; the box takes focus |
| not bundled, offline | the section says so, links to the online site and names `docs:bundle`; query box and **Contents** disabled; nothing else is affected |
| a docs page fails to load | the frame shows the browser's own error; the app is unaffected |
| `postMessage` not delivered | the docs keep their own theme; **Open online** points at the home page |

The probe is a single `HEAD /docs/index.html` with `cache: "no-store"`.

---

## 8. Accessibility

- The frame has `title="Fullmag documentation"`; the query box is a labelled
  `search` landmark (`aria-label="Search the documentation"`).
- Focus lands in the query box when the docs are available, never inside the
  frame, so the section never traps the keyboard.
- Theme follows the app, so contrast is whatever the Clarity theme guarantees in
  each mode; the app does not override its colours.
- `referrerpolicy="no-referrer"` on the frame.

---

## 9. Testing

| Check | Where |
|---|---|
| URL building, path hardening, message parsing, online link | `modules/start/model/docs.test.ts` |
| Bundle precondition | `scripts/bundle-docs.mjs` exits non-zero without a build |
| Strict docs build with the embed assets | `sphinx-build -W -n` (CI) builds with `fullmag-embed.{js,css}` registered in `conf.py` |
| Framed behaviour | in a browser: `data-fullmag-embedded` set, theme follows the app both ways, theme toggle hidden, **Open online** follows the page, search returns results |

---

## 10. Extending it

- **Context-sensitive help.** `docsPageUrl("physics/…")` already addresses a page;
  an inspector can offer a *Read more* link by passing a documented path. Keep the
  mapping in the model and verify the path exists in the built site.
- **Release bundling.** Produce `docs:bundle` in the release job that already
  builds the site, and ship `public/docs/` with the app.
- **Versioned docs.** The site is built with `FULLMAG_DOCS_VERSION`; bundling the
  version that matches the app is a release-job concern.

---

## 11. Files

```
apps/control-room/src/modules/start/sections/DocsSection.tsx
apps/control-room/src/modules/start/model/docs.ts            (+ docs.test.ts)
apps/control-room/scripts/bundle-docs.mjs
apps/control-room/public/docs/                               (generated, git-ignored)
public_docs/site/_static/fullmag-embed.js
public_docs/site/_static/fullmag-embed.css
public_docs/site/conf.py                                     (registers the two assets)
docs/guides/in-app-documentation.md                          (how to bundle)
```

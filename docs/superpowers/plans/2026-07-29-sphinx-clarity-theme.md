# Sphinx Clarity Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PyData Sphinx Theme with the default ReadCraft Clarity Theme Community edition on the public FullMag documentation portal.

**Architecture:** Keep Sphinx, MyST, the public source root, URLs, and GitHub Pages workflow unchanged. Change only the theme dependency and Sphinx theme selection, then prove the strict build and deployed HTML use Clarity.

**Tech Stack:** Python 3.11, Sphinx 8, MyST Parser 4, `sphinx-clarity-theme`, GitHub Actions, GitHub Pages.

## Global Constraints

- Public documentation builds exclusively from `public_docs/site/`.
- Internal `docs/` content must not enter the public Pages artifact.
- Use the Community edition under the MIT license.
- Use the default Clarity presentation without custom CSS or visual overrides.
- Preserve MyST, mathematics, strict warnings, `CNAME`, page structure, and public URLs.
- Do not introduce Next.js or Jekyll.

---

### Task 1: Replace the public Sphinx theme

**Files:**
- Modify: `public_docs/site/requirements.txt`
- Modify: `public_docs/site/conf.py`

**Interfaces:**
- Consumes: the existing Sphinx dependency installation and `html_theme` configuration.
- Produces: an environment containing `sphinx_clarity_theme` and a Sphinx configuration selecting it.

- [ ] **Step 1: Verify the old theme is selected**

Run:

```bash
rg -n 'pydata-sphinx-theme|html_theme = "pydata_sphinx_theme"|navbar_align|show_toc_level|navigation_with_keys' public_docs/site/requirements.txt public_docs/site/conf.py
```

Expected: matches for the PyData dependency, theme name, and PyData-only options.

- [ ] **Step 2: Replace the dependency**

Replace:

```text
pydata-sphinx-theme>=0.16,<0.17
```

with:

```text
sphinx-clarity-theme>=2.1,<3
```

Keep `sphinx`, `myst-parser`, `linkify-it-py`, and `sphinx-design` unchanged.

- [ ] **Step 3: Select the default Clarity theme**

Set:

```python
html_theme = "sphinx_clarity_theme"
html_title = "FullMag public documentation"
html_static_path = ["_static"]
html_extra_path = ["CNAME"]
```

Delete the entire PyData-specific `html_theme_options` dictionary. Do not add replacement options or custom CSS.

- [ ] **Step 4: Verify configuration scope**

Run:

```bash
rg -n 'sphinx-clarity-theme|html_theme = "sphinx_clarity_theme"' public_docs/site/requirements.txt public_docs/site/conf.py
rg -n 'pydata_sphinx_theme|pydata-sphinx-theme|navbar_align|show_toc_level|navigation_with_keys' public_docs/site/requirements.txt public_docs/site/conf.py
```

Expected: the first command finds the new dependency and theme; the second command returns no matches.

- [ ] **Step 5: Commit the theme migration**

Commit only `public_docs/site/requirements.txt` and `public_docs/site/conf.py` with message:

```text
docs: adopt Sphinx Clarity theme
```

### Task 2: Verify and publish the theme

**Files:**
- Verify: `scripts/check_public_docs_boundary.py`
- Verify: `.github/workflows/documentation.yml`
- Verify: generated GitHub Pages artifact

**Interfaces:**
- Consumes: the Clarity configuration from Task 1 and the existing public documentation workflow.
- Produces: a deployed Clarity-themed portal at `https://fullmag.mzelent.pl/`.

- [ ] **Step 1: Run the public/internal boundary check**

Run:

```bash
python scripts/check_public_docs_boundary.py
```

Expected: exit code 0 and confirmation that only the public source root is eligible for publication.

- [ ] **Step 2: Build strict HTML**

Install `public_docs/site/requirements.txt` in an isolated Python 3.11 environment and run:

```bash
sphinx-build -b html -W -n --keep-going public_docs/site public_docs/site/_build/html
```

Expected: exit code 0 with no warnings.

- [ ] **Step 3: Verify generated theme evidence**

Run:

```bash
rg -n 'clarity|sphinx_clarity_theme' public_docs/site/_build/html/index.html public_docs/site/_build/html/_static
```

Expected: at least one generated asset or HTML reference identifies the Clarity theme.

- [ ] **Step 4: Publish through the existing workflow**

Push the branch, open a pull request into `master`, and verify its documentation build. Merge only after the strict build succeeds.

Expected: the post-merge `Public documentation` workflow completes both `build` and `deploy` successfully.

- [ ] **Step 5: Verify the public site**

Run:

```bash
curl --fail --silent --show-error --location https://fullmag.mzelent.pl/
curl --fail --silent --show-error --location https://fullmag.mzelent.pl/physics/exchange-demag-zeeman.html
```

Expected: both requests return HTTP success and their HTML references Clarity theme assets. Confirm that navigation between the landing page, architecture pages, and physics pages works and that no internal `docs/` page appears.

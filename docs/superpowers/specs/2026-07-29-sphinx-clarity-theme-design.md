# Sphinx Clarity Theme design

Date: 2026-07-29  
Status: approved approach, awaiting specification review  
Scope: public documentation presentation only

## Objective

Replace the current PyData Sphinx Theme on the FullMag public documentation portal with the ReadCraft Clarity Theme shown at `https://readcraft.io/sphinx-clarity-theme/demo/`.

The implementation will use the Community edition distributed as the `sphinx-clarity-theme` Python package under the MIT license. FullMag will use the theme's default presentation without custom CSS or visual overrides.

## Documentation boundary

This design document is internal development documentation under `docs/`. It must not be included in the GitHub Pages build.

The public site continues to build exclusively from `public_docs/site/`. The theme change must not copy internal plans, audits, diagnostics, or developer documentation into the public artifact.

## Configuration changes

- Replace the `pydata-sphinx-theme` dependency with the stable `sphinx-clarity-theme` package.
- Configure Sphinx with `html_theme = "sphinx_clarity_theme"`.
- Remove `html_theme_options` entries that are specific to PyData Sphinx Theme.
- Do not add custom CSS, templates, colors, typography, or layout overrides.
- Preserve the FullMag project title and existing source navigation.
- Preserve MyST parsing, mathematics, strict warnings, the custom-domain `CNAME`, and the exclusion of the author-facing `README.md`.

## Publication flow

The existing GitHub Actions workflow remains the publication mechanism:

1. install the public documentation dependencies;
2. verify the public/internal documentation boundary;
3. run the strict Sphinx HTML build;
4. upload the Pages artifact;
5. deploy it to `https://fullmag.mzelent.pl/`.

No Next.js or Jekyll workflow will be introduced.

## Verification

The change is complete only when all of the following are demonstrated:

- dependency installation succeeds on GitHub Actions;
- the documentation-boundary check passes;
- strict Sphinx build passes with warnings treated as errors;
- GitHub Pages deployment succeeds;
- the public domain returns HTTP 200;
- the generated HTML identifies the Clarity theme assets;
- the landing page and one nested physics page render with working navigation;
- internal `docs/` content is absent from the public artifact.

## Failure handling

If the current Clarity release is incompatible with Sphinx 8, use the newest stable Clarity version compatible with the existing Python 3.11 and Sphinx 8 publication lane. Do not weaken strict warning handling or broaden the public source tree to make the build pass.

## Non-goals

- FullMag-specific branding or custom CSS;
- changing public documentation content;
- changing information architecture or page URLs;
- publishing internal development documentation;
- replacing Sphinx or GitHub Pages.

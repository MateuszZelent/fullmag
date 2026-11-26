---
title: Documentation changelog
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: git-history
orphan: true
---

(public-docs-documentation-changelog)=
# Documentation changelog

The **Last changes** date above refers to this page’s own source file. The **Latest documentation change** below is generated from the current repository history each time the site is published.

```{versionadded} development
This public page and the accompanying Sphinx version-change index were added to make documentation evolution directly inspectable.
```

```{versionchanged} development
The changelog now exposes separate Documentation and GitHub / code tabs, each with its own latest-change timestamp and history. The version-change report is published at the directory entry point and retains the full generated report at `changes.html`.
```

```{versionchanged} development
The 5 October 2026 documentation update corrected the getting-started, Control Room, installation, and architecture guides against the current implementation. The Documentation tab links the exact commit and changed pages.
```

```{versionchanged} development
The November 2026 documentation synchronization updated the getting-started, architecture, Control Room, physics, numerical-methods, Python API, and validation references against commit `752450f8d2` and added the dedicated {ref}`Computational Optimizations and Hardware Acceleration <numerical-methods-performance>` subtree covering FDM/FEM CPU and CUDA acceleration, preflight budgets, and verified A/B parity evidence.
```

FullMag exposes two complementary change records:

1. **Documentation history** below is generated from the repository's first-parent Git history and
   lists commits that changed the public Sphinx source, documentation workflow, source contracts,
   or public API documentation tests.
2. **Sphinx version changes** aggregate explicit `versionadded`, `versionchanged`, `deprecated`,
   and `versionremoved` directives for the current documentation version.

The Git-backed list answers “what changed in the documentation and when?”. The Sphinx index answers
“which user-visible contracts were added, changed, deprecated, or removed?”. Neither replaces
release notes for solver binaries or scientific qualification receipts.

<div class="fm-changelog-page-links">
  <a class="fm-changelog-page-link" href="../version-changes/index.html">Open Sphinx version-change report</a>
</div>

## Two change histories

The tabs use separate Git scopes. **Documentation** covers commits that change the public Sphinx source and its documentation contract. **GitHub / code** covers the remaining repository code history and links every entry to its commit on GitHub.

```{documentation-changelog-tabs}
:documentation-limit: 80
:code-limit: 40
:show-paths:
```

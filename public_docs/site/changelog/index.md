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

```{versionadded} development
This public page and the accompanying Sphinx version-change index were added to make documentation evolution directly inspectable.
```

```{versionchanged} development
The changelog now exposes separate Documentation and GitHub / code tabs, each with its own latest-change timestamp and history. The version-change report is published at the directory entry point and retains the full generated report at `changes.html`.
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

## Recording future changes

Use Sphinx's native directives next to the affected public contract:

````text
```{versionadded} development
Description of the newly exposed user-facing contract.
```

```{versionchanged} development
Description of the changed behavior, units, defaults, or support boundary.
```

```{deprecated} development
Migration target and removal policy.
```

```{versionremoved} development
Replacement, rationale, and compatibility consequence.
```
````

The documentation workflow builds the native Sphinx `changes` builder after the strict HTML build
and publishes its output under `/version-changes/`. A documentation change is therefore visible
both through Git history and, when it affects a public contract, through an explicit semantic
change directive.

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.

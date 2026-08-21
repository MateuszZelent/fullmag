---
title: Documentation changelog
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
orphan: true
---

(public-docs-documentation-changelog)=
# Documentation changelog

```{versionadded} development
This public page and the accompanying Sphinx version-change index were added to make documentation evolution directly inspectable.
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
  <a class="fm-changelog-page-link" href="../version-changes/index.html">Open Sphinx version-change index</a>
  <a class="fm-changelog-page-link" href="https://github.com/MateuszZelent/fullmag/commits/master/public_docs/site">Open complete documentation history on GitHub</a>
</div>

## Recent documentation changes

```{documentation-changelog}
:limit: 80
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

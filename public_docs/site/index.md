---
title: FullMag public documentation
status: draft
audience: user
owner: fullmag-public-docs
source_of_truth: public_docs/fullmag_profesjonalna_dokumentacja_architektura.md
---

# FullMag public documentation

FullMag is a physics-first micromagnetics platform. This site is the curated public documentation
for users and scientific readers. It is deliberately separate from internal developer
documentation, engineering plans, audits and diagnostics in docs/.

## Documentation boundary

This public site contains product architecture and user-facing concepts, public Python and API
contracts, documented physical models, reproducible examples, validation scope, release notes and
public limitations.

It does not contain internal implementation plans, agent instructions, private diagnostics,
unfinished engineering reports or raw backend development notes.

Internal sources are used as review input, but a page enters this portal only after curation,
public status and review.

## Start here

```{toctree}
:maxdepth: 2
:caption: Public documentation

architecture/index
physics/index
```

## Publication status

The first publication target is the GitHub Pages project site:
https://mateuszelent.github.io/fullmag/

The public source is only public_docs/site. The workflow must never build the whole docs/ tree.
